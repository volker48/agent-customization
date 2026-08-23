import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

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
      const release = await acquireFileLock(`${this.path}.lock`, this.pathGuard);
      try {
        const cache = await readCacheFile(this.path, this.pathGuard);
        const run = (cache.runs[this.runHash] ??= {
          createdAt: new Date().toISOString(),
          entries: {},
        });
        run.entries[entryKey] = {
          ...reward,
          createdAt: new Date().toISOString(),
        };
        await atomicWriteJson(this.path, cache, this.pathGuard);
        this.cacheFile = Promise.resolve(cache);
      } finally {
        await release();
      }
    });
    this.writeTail = write.catch(() => undefined);
    await write;
  }

  private load(): Promise<CacheFile> {
    this.cacheFile ??= readCacheFile(this.path, this.pathGuard);
    return this.cacheFile;
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

async function readCacheFile(path: string, pathGuard?: CachePathGuard): Promise<CacheFile> {
  try {
    const guardedPath = guardPath(path, pathGuard);
    const parsed = JSON.parse(await readFile(guardedPath, "utf8")) as Partial<CacheFile>;
    if (parsed.schemaVersion !== 1 || !parsed.runs || typeof parsed.runs !== "object") {
      throw new Error(`Unsupported verifier cache schema in ${guardedPath}`);
    }
    return parsed as CacheFile;
  } catch (error) {
    if (isMissingFile(error)) return { schemaVersion: 1, runs: {} };
    throw error;
  }
}

async function atomicWriteJson(
  path: string,
  value: CacheFile,
  pathGuard?: CachePathGuard,
): Promise<void> {
  let guardedPath = guardPath(path, pathGuard);
  await mkdir(dirname(guardedPath), { recursive: true });
  guardedPath = guardPath(path, pathGuard);
  const temporaryPath = guardPath(
    `${guardedPath}.${process.pid}.${randomUUID()}.tmp`,
    pathGuard,
  );
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
    const sourcePath = guardPath(temporaryPath, pathGuard);
    const destinationPath = guardPath(path, pathGuard);
    if (dirname(destinationPath) !== dirname(sourcePath)) {
      throw new Error("Verifier cache path changed during an atomic write");
    }
    await rename(sourcePath, destinationPath);
    guardPath(path, pathGuard);
  } finally {
    await rm(guardPath(temporaryPath, pathGuard), { force: true });
  }
}

async function acquireFileLock(
  lockPath: string,
  pathGuard?: CachePathGuard,
): Promise<() => Promise<void>> {
  let guardedLockPath = guardPath(lockPath, pathGuard);
  await mkdir(dirname(guardedLockPath), { recursive: true });
  const deadline = Date.now() + 10_000;
  while (true) {
    guardedLockPath = guardPath(lockPath, pathGuard);
    try {
      await mkdir(guardedLockPath);
      return async () => rm(guardPath(lockPath, pathGuard), { recursive: true, force: true });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      if (await isStaleLock(lockPath, pathGuard)) {
        await rm(guardPath(lockPath, pathGuard), { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for verifier cache lock ${guardedLockPath}`);
      }
      await delay(25);
    }
  }
}

async function isStaleLock(lockPath: string, pathGuard?: CachePathGuard): Promise<boolean> {
  try {
    const metadata = await stat(guardPath(lockPath, pathGuard));
    return Date.now() - metadata.mtimeMs > 60_000;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

function guardPath(path: string, pathGuard?: CachePathGuard): string {
  return pathGuard?.(path) ?? path;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
