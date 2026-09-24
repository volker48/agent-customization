import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, join, parse, relative, resolve, sep } from "node:path";

import type { Criterion, DirectedPairReward } from "./types.js";

export interface VerifierModelIdentity {
  provider: string;
  model: string;
  api: string;
}

export interface VerifierImplementationIdentity {
  name: string;
  version: string;
  upstreamVersion: string;
  pairwisePromptVersion: string;
  progressPromptVersion: string;
  scoreScaleVersion: string;
}

export interface VerifierScoringParameters {
  repetitions: number;
  pivots: number;
  seed: number;
  temperature: number;
  topLogprobs: number;
  extractionMode: string;
  minimumScaleTokens: number;
  [key: string]: string | number | boolean;
}

export interface RunFingerprintInput {
  implementation: VerifierImplementationIdentity;
  model: VerifierModelIdentity;
  problem: string;
  candidateEvidence: readonly string[];
  criteria: readonly Criterion[];
  groundTruthNote: string;
  scoring: VerifierScoringParameters;
}

export interface CacheEntry extends DirectedPairReward {
  createdAt: string;
}

export interface PairScoreCache {
  get(entryKey: string): Promise<DirectedPairReward | undefined>;
  set(entryKey: string, reward: DirectedPairReward): Promise<void>;
}

export type CachePathGuard = (path: string) => string;

interface CacheEntryIndex {
  [entryKey: string]: CacheEntry;
}

interface CacheRun {
  createdAt: string;
  entries: CacheEntryIndex;
}

interface CacheRunIndex {
  [runHash: string]: CacheRun;
}

interface CacheFile {
  schemaVersion: 1;
  runs: CacheRunIndex;
}

interface CacheDirectory {
  readonly cachePath: string;
  readonly fileName: string;
  resolve(name: string): string;
  close(): Promise<void>;
}

interface PinnedDirectory {
  readonly handle: FileHandle;
  readonly descriptorPath: string;
}

const NO_FOLLOW_FLAG = constants.O_NOFOLLOW ?? 0;
const DIRECTORY_FLAG = constants.O_DIRECTORY ?? 0;

export function canonicalText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

export function canonicalRunFingerprint(input: RunFingerprintInput): RunFingerprintInput {
  return {
    ...input,
    problem: canonicalText(input.problem),
    candidateEvidence: input.candidateEvidence.map(canonicalText),
    criteria: input.criteria.map((criterion) => ({
      id: canonicalText(criterion.id),
      name: canonicalText(criterion.name),
      description: canonicalText(criterion.description),
    })),
    groundTruthNote: canonicalText(input.groundTruthNote),
  };
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function computeRunHash(input: RunFingerprintInput): string {
  return createHash("sha256")
    .update(stableStringify(canonicalRunFingerprint(input)))
    .digest("hex");
}

export function scoreCacheEntryKey(
  criterionId: string,
  candidateA: number,
  candidateB: number,
  repetition: number,
): string {
  return JSON.stringify([criterionId, candidateA, candidateB, repetition]);
}

export class JsonPairScoreCache implements PairScoreCache {
  readonly path: string;

  private writeTail: Promise<void> = Promise.resolve();
  private cacheFile: Promise<CacheFile> | undefined;

  constructor(
    path: string,
    readonly runHash: string,
    private readonly pathGuard?: CachePathGuard,
  ) {
    this.path = guardPath(path, pathGuard);
  }

  async get(entryKey: string): Promise<CacheEntry | undefined> {
    const cache = await this.load();
    return cache.runs[this.runHash]?.entries[entryKey];
  }

  async set(entryKey: string, reward: DirectedPairReward): Promise<void> {
    const write = this.writeTail.then(async () => {
      const directory = await openCacheDirectory(this.path, this.pathGuard, true);
      try {
        const release = await acquireFileLock(directory);
        try {
          const cache = await readCacheFile(directory);
          const run = (cache.runs[this.runHash] ??= {
            createdAt: new Date().toISOString(),
            entries: {},
          });
          run.entries[entryKey] = {
            ...reward,
            createdAt: new Date().toISOString(),
          };
          await atomicWriteJson(directory, cache);
          this.cacheFile = Promise.resolve(cache);
        } finally {
          await release();
        }
      } finally {
        await directory.close();
      }
    });
    this.writeTail = write.catch(() => undefined);
    await write;
  }

  private load(): Promise<CacheFile> {
    this.cacheFile ??= this.read();
    return this.cacheFile;
  }

  private async read(): Promise<CacheFile> {
    let directory: CacheDirectory | undefined;
    try {
      directory = await openCacheDirectory(this.path, this.pathGuard, false);
      return await readCacheFile(directory);
    } catch (error) {
      if (isMissingFile(error)) return emptyCacheFile();
      throw error;
    } finally {
      await directory?.close();
    }
  }
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cannot canonicalize a non-finite number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object") {
    throw new Error(`Cannot canonicalize value of type ${typeof value}`);
  }

  const output: { [key: string]: unknown } = {};
  for (const key of Object.keys(value).sort()) {
    const item = (value as { [key: string]: unknown })[key];
    if (item === undefined) throw new Error(`Cannot canonicalize undefined at key ${key}`);
    output[key] = canonicalize(item);
  }
  return output;
}

async function openCacheDirectory(
  path: string,
  pathGuard: CachePathGuard | undefined,
  create: boolean,
): Promise<CacheDirectory> {
  const guardedPath = guardPath(path, pathGuard);
  const parentPath = dirname(guardedPath);
  const fileName = basename(guardedPath);
  if (!fileName) throw new Error(`Verifier cache path must name a file: ${guardedPath}`);
  if (!pathGuard) {
    if (create) await mkdir(parentPath, { recursive: true });
    return {
      cachePath: guardedPath,
      fileName,
      resolve: (name) => join(parentPath, name),
      close: () => Promise.resolve(),
    };
  }

  const pinned = await openPinnedDirectory(parentPath, create);
  try {
    // Recheck the descriptor-anchored destination itself. This catches an ancestor
    // swap before the directory was opened while keeping later writes pinned to
    // the verified directory if its pathname is replaced afterward.
    guardPath(join(pinned.descriptorPath, fileName), pathGuard);
    return {
      cachePath: guardedPath,
      fileName,
      resolve: (name) => join(pinned.descriptorPath, name),
      close: () => pinned.handle.close(),
    };
  } catch (error) {
    await pinned.handle.close();
    throw error;
  }
}

async function openPinnedDirectory(path: string, create: boolean): Promise<PinnedDirectory> {
  if (process.platform === "win32" || NO_FOLLOW_FLAG === 0 || DIRECTORY_FLAG === 0) {
    throw new Error(
      "Guarded verifier caches require descriptor-anchored directory access on this platform",
    );
  }

  const absolutePath = resolve(path);
  const root = parse(absolutePath).root;
  const segments = relative(root, absolutePath).split(sep).filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`Cannot securely open verifier cache directory ${absolutePath}`);
  }

  let handle = await open(root, constants.O_RDONLY | DIRECTORY_FLAG | NO_FOLLOW_FLAG);
  try {
    let descriptorPath = await descriptorPathFor(handle);
    for (const segment of segments) {
      const childPath = join(descriptorPath, segment);
      if (create) {
        try {
          await mkdir(childPath, { mode: 0o700 });
        } catch (error) {
          if (!isAlreadyExists(error)) throw error;
        }
      }
      const child = await open(
        childPath,
        constants.O_RDONLY | DIRECTORY_FLAG | NO_FOLLOW_FLAG,
      );
      await handle.close();
      handle = child;
      descriptorPath = await descriptorPathFor(handle);
    }
    return { handle, descriptorPath };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function descriptorPathFor(handle: FileHandle): Promise<string> {
  const expected = await handle.stat({ bigint: true });
  for (const root of ["/proc/self/fd", "/dev/fd"]) {
    const candidate = join(root, String(handle.fd));
    try {
      const actual = await stat(candidate, { bigint: true });
      if (actual.dev === expected.dev && actual.ino === expected.ino) return candidate;
    } catch {
      // Try the next descriptor filesystem.
    }
  }
  throw new Error(
    "Guarded verifier caches require descriptor-anchored directory access on this platform",
  );
}

async function readCacheFile(directory: CacheDirectory): Promise<CacheFile> {
  const path = directory.resolve(directory.fileName);
  let file: FileHandle | undefined;
  try {
    file = await open(path, constants.O_RDONLY | NO_FOLLOW_FLAG);
    const parsed = JSON.parse(await file.readFile({ encoding: "utf8" })) as Partial<CacheFile>;
    if (parsed.schemaVersion !== 1 || !parsed.runs || typeof parsed.runs !== "object") {
      throw new Error(`Unsupported verifier cache schema in ${directory.cachePath}`);
    }
    return parsed as CacheFile;
  } catch (error) {
    if (isMissingFile(error)) return emptyCacheFile();
    throw error;
  } finally {
    await file?.close();
  }
}

async function atomicWriteJson(directory: CacheDirectory, value: CacheFile): Promise<void> {
  const temporaryName = `${directory.fileName}.${process.pid}.${randomUUID()}.tmp`;
  const temporaryPath = directory.resolve(temporaryName);
  let temporaryFile: FileHandle | undefined;
  try {
    temporaryFile = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW_FLAG,
      0o600,
    );
    await temporaryFile.writeFile(`${JSON.stringify(value)}\n`, { encoding: "utf8" });
    await temporaryFile.sync();
    await temporaryFile.close();
    temporaryFile = undefined;
    await rename(temporaryPath, directory.resolve(directory.fileName));
  } finally {
    await temporaryFile?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true });
  }
}

async function acquireFileLock(directory: CacheDirectory): Promise<() => Promise<void>> {
  const lockPath = directory.resolve(`${directory.fileName}.lock`);
  const displayLockPath = `${directory.cachePath}.lock`;
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      await mkdir(lockPath);
      return async () => rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      if (await isStaleLock(lockPath)) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for verifier cache lock ${displayLockPath}`);
      }
      await delay(25);
    }
  }
}

async function isStaleLock(lockPath: string): Promise<boolean> {
  try {
    const metadata = await lstat(lockPath);
    return Date.now() - metadata.mtimeMs > 60_000;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

function emptyCacheFile(): CacheFile {
  return { schemaVersion: 1, runs: {} };
}

function guardPath(path: string, pathGuard?: CachePathGuard): string {
  return pathGuard?.(path) ?? path;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
