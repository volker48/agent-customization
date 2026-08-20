import type { Criterion, TournamentResult } from "../core/types.js";

export type CandidateRunStatus = "completed" | "failed" | "cancelled";

export interface LavRunConfig {
  task: string;
  candidateCount: number;
  verifierModelRef: string;
  criteria: readonly Criterion[];
  repetitions: number;
  pivots: number;
  seed: number;
  candidateConcurrency: number;
  verifierConcurrency: number;
  cachePath?: string;
  applyWinner: boolean;
}

export interface CandidateAction {
  sequence: number;
  kind: "assistant" | "tool";
  toolName: string;
  input: string;
  output: string;
  isError: boolean;
}

export interface CandidateExecution {
  status: "completed";
  actions: readonly CandidateAction[];
  finalMessage: string;
}

export interface CandidateRunInput {
  task: string;
  candidateIndex: number;
  candidateCount: number;
  cwd: string;
  signal: AbortSignal;
}

export interface CandidateRunner {
  run(input: CandidateRunInput): Promise<CandidateExecution>;
}

export interface FrozenRepositoryState {
  patch: string;
  patchHash: string;
  status: string;
}

export interface CandidateWorktree {
  candidateIndex: number;
  path: string;
}

export interface LavRepository {
  readonly repoRoot: string;
  readonly baseCommit: string;
  readonly worktrees: readonly CandidateWorktree[];
  freeze(worktree: CandidateWorktree, signal: AbortSignal): Promise<FrozenRepositoryState>;
  applyFrozenPatch(patch: string, signal: AbortSignal): Promise<boolean>;
  cleanup(): Promise<void>;
}

export interface LavRepositoryFactory {
  open(cwd: string, candidateCount: number, signal: AbortSignal): Promise<LavRepository>;
}

export interface FrozenCandidate {
  candidateIndex: number;
  status: CandidateRunStatus;
  baseCommit: string;
  patch: string;
  patchHash: string;
  repositoryStatus: string;
  actions: readonly CandidateAction[];
  finalMessage: string;
  error: string;
  evidence: string;
}

export interface CandidateSelectionInput {
  problem: string;
  candidates: readonly string[];
  criteria: readonly Criterion[];
  repetitions: number;
  pivots: number;
  seed: number;
  maxConcurrency: number;
  cachePath?: string;
  signal: AbortSignal;
}

export interface CandidateSelectionResult extends TournamentResult {
  runHash?: string;
}

export interface CandidateSelector {
  select(input: CandidateSelectionInput): Promise<CandidateSelectionResult>;
}

export type LavProgressEvent =
  | { type: "repository-ready"; baseCommit: string; candidateCount: number }
  | { type: "preflight-started" }
  | { type: "preflight-finished" }
  | { type: "candidate-started"; candidateIndex: number }
  | { type: "candidate-finished"; candidateIndex: number; status: CandidateRunStatus }
  | { type: "verification-started"; eligibleCandidateCount: number }
  | { type: "verification-finished"; selectedCandidateIndex: number }
  | { type: "patch-applied"; candidateIndex: number; changed: boolean }
  | { type: "cleanup-started" }
  | { type: "cleanup-finished" };

export interface LavRunDependencies {
  repositoryFactory: LavRepositoryFactory;
  candidateRunner: CandidateRunner;
  selector: CandidateSelector;
  preflight?: (signal: AbortSignal) => Promise<void>;
  onProgress?: (event: LavProgressEvent) => void;
}

export interface LavRunResult {
  baseCommit: string;
  repoRoot: string;
  candidates: readonly FrozenCandidate[];
  eligibleCandidateIndices: readonly number[];
  selectedCandidateIndex: number;
  ranking: readonly number[];
  verifierRunHash?: string;
  applied: boolean;
}
