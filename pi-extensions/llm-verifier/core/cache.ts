import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

export function canonicalRunFingerprint(
  input: RunFingerprintInput,
): RunFingerprintInput {
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
  private writeTail: Promise<void> = Promise.resolve();
  private cacheFile: Promise<CacheFile> | undefined;

  constructor(
    readonly path: string,
    readonly runHash: string,
  ) {}

  async get(entryKey: string): Promise<CacheEntry | undefined> {
    const cache = await this.load();
    return cache.runs[this.runHash]?.entries[entryKey];
  }

  async set(entryKey: string, reward: DirectedPairReward): Promise<void> {
    const write = this.writeTail.then(async () => {
      const cache = await this.load();
      const run = (cache.runs[this.runHash] ??= {
        createdAt: new Date().toISOString(),
        entries: {},
      });
      run.entries[entryKey] = {
        ...reward,
        createdAt: new Date().toISOString(),
      };
      await atomicWriteJson(this.path, cache);
    });
    this.writeTail = write.catch(() => undefined);
    await write;
  }

  private load(): Promise<CacheFile> {
    this.cacheFile ??= readCacheFile(this.path);
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

async function readCacheFile(path: string): Promise<CacheFile> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<CacheFile>;
    if (parsed.schemaVersion !== 1 || !parsed.runs || typeof parsed.runs !== "object") {
      throw new Error(`Unsupported verifier cache schema in ${path}`);
    }
    return parsed as CacheFile;
  } catch (error) {
    if (isMissingFile(error)) return { schemaVersion: 1, runs: {} };
    throw error;
  }
}

async function atomicWriteJson(path: string, value: CacheFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
