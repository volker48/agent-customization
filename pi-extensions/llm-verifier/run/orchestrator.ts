import { assertCachePathOutsideRepository } from "./cache-path.js";
import { buildCandidateEvidence } from "./evidence.js";
import { abortError } from "./git.js";
import type {
  CandidateExecution,
  CandidateRunStatus,
  CandidateSelectionResult,
  FrozenCandidate,
  FrozenRepositoryState,
  LavProgressEvent,
  LavRepository,
  LavRunConfig,
  LavRunDependencies,
  LavRunResult,
} from "./types.js";

interface CandidateAttempt {
  execution?: CandidateExecution;
  status: CandidateRunStatus;
  error: string;
}

export class CleanupFailedError extends Error {
  constructor(
    readonly primaryError: unknown,
    readonly cleanupError: string,
  ) {
    super(errorMessage(primaryError), { cause: primaryError });
    this.name = "CleanupFailedError";
  }
}

export async function runLav(
  cwd: string,
  config: LavRunConfig,
  dependencies: LavRunDependencies,
  signal: AbortSignal,
): Promise<LavRunResult> {
  validateConfig(config);
  throwIfAborted(signal);

  const repository = await dependencies.repositoryFactory.open(cwd, config.candidateCount, signal);
  let result: LavRunResult | undefined;
  let primaryError: unknown;
  let primaryFailed = false;
  try {
    if (repository.worktrees.length !== config.candidateCount) {
      throw new Error(
        `Repository prepared ${repository.worktrees.length} candidate worktree(s), expected ` +
          `${config.candidateCount}`,
      );
    }
    const cachePathGuard = (path: string): string => {
      const verifiedPath = assertCachePathOutsideRepository(repository.repoRoot, path);
      if (!verifiedPath) throw new Error("Verifier cache path must not be empty");
      return verifiedPath;
    };
    const verifiedCachePath = config.cachePath ? cachePathGuard(config.cachePath) : undefined;
    emitProgress(dependencies, {
      type: "repository-ready",
      baseCommit: repository.baseCommit,
      candidateCount: repository.worktrees.length,
    });
    if (dependencies.preflight) {
      emitProgress(dependencies, { type: "preflight-started" });
      await dependencies.preflight(signal);
      throwIfAborted(signal);
      emitProgress(dependencies, { type: "preflight-finished" });
    }
    const frozenCandidates = await generateAndFreezeCandidates(
      config,
      dependencies,
      repository,
      signal,
    );
    throwIfAborted(signal);

    const eligible = frozenCandidates.filter((candidate) => candidate.status === "completed");
    if (eligible.length === 0) {
      const failures = frozenCandidates
        .map(
          (candidate) =>
            `candidate ${candidate.candidateIndex + 1}: ${candidate.error || candidate.status}`,
        )
        .join("; ");
      throw new Error(`All LAV candidates failed. ${failures}`);
    }

    let selection: CandidateSelectionResult;
    if (eligible.length === 1) {
      selection = singletonSelection();
    } else {
      emitProgress(dependencies, {
        type: "verification-started",
        eligibleCandidateCount: eligible.length,
      });
      selection = await dependencies.selector.select({
        problem: config.task,
        candidates: eligible.map((candidate) => candidate.evidence),
        criteria: config.criteria,
        repetitions: config.repetitions,
        pivots: config.pivots,
        seed: config.seed,
        maxConcurrency: config.verifierConcurrency,
        cachePath: verifiedCachePath,
        cachePathGuard: verifiedCachePath ? cachePathGuard : undefined,
        signal,
      });
      throwIfAborted(signal);
    }
    validateSelection(selection, eligible.length);

    const selectedCandidate = eligible[selection.index];
    const ranking = selection.ranking.map(
      (eligibleIndex) => eligible[eligibleIndex].candidateIndex,
    );
    emitProgress(dependencies, {
      type: "verification-finished",
      selectedCandidateIndex: selectedCandidate.candidateIndex,
    });

    const winnerPatchPath = selectedCandidate.patch.trim()
      ? await repository.preserveFrozenPatch(
          selectedCandidate.patch,
          selectedCandidate.patchHash,
          selectedCandidate.candidateIndex,
          signal,
        )
      : undefined;
    let applied = false;
    let applicationError: string | undefined;
    if (config.applyWinner) {
      try {
        applied = await repository.applyFrozenPatch(selectedCandidate.patch, signal);
      } catch (error) {
        if (signal.aborted || isAbortError(error)) throw error;
        applicationError = errorMessage(error);
      }
      emitProgress(dependencies, {
        type: "patch-applied",
        candidateIndex: selectedCandidate.candidateIndex,
        changed: applied,
      });
    }

    result = {
      baseCommit: repository.baseCommit,
      repoRoot: repository.repoRoot,
      candidates: frozenCandidates,
      eligibleCandidateIndices: eligible.map((candidate) => candidate.candidateIndex),
      selectedCandidateIndex: selectedCandidate.candidateIndex,
      ranking,
      verifierRunHash: selection.runHash,
      winnerPatchPath,
      applicationError,
      applied,
    };
  } catch (error) {
    primaryFailed = true;
    primaryError = error;
  }

  emitProgress(dependencies, { type: "cleanup-started" });
  let cleanupError: string | undefined;
  try {
    await repository.cleanup();
  } catch (error) {
    cleanupError = errorMessage(error);
  }
  emitProgress(dependencies, { type: "cleanup-finished", error: cleanupError });

  if (primaryFailed) {
    if (cleanupError) {
      throw new CleanupFailedError(primaryError, cleanupError);
    }
    throw primaryError;
  }
  if (!result) {
    throw new Error("LAV run completed without producing a result");
  }
  if (cleanupError) {
    result.cleanupError = cleanupError;
  }
  return result;
}

async function generateAndFreezeCandidates(
  config: LavRunConfig,
  dependencies: LavRunDependencies,
  repository: LavRepository,
  externalSignal: AbortSignal,
): Promise<FrozenCandidate[]> {
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort(externalSignal.reason);
  externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  if (externalSignal.aborted) controller.abort(externalSignal.reason);

  const results: Array<FrozenCandidate | undefined> = Array.from(
    { length: config.candidateCount },
    () => undefined,
  );
  let nextIndex = 0;
  let fatalError: unknown;

  const worker = async () => {
    while (!controller.signal.aborted && fatalError === undefined) {
      const candidateIndex = nextIndex;
      nextIndex += 1;
      if (candidateIndex >= repository.worktrees.length) return;
      const worktree = repository.worktrees[candidateIndex];
      emitProgress(dependencies, { type: "candidate-started", candidateIndex });

      const attempt = await runCandidateAttempt(dependencies, {
        task: config.task,
        candidateIndex,
        candidateCount: config.candidateCount,
        cwd: worktree.path,
        signal: controller.signal,
      });

      if (controller.signal.aborted) return;

      let frozen: FrozenRepositoryState = { patch: "", patchHash: "", status: "" };
      let candidateStatus = attempt.status;
      let candidateError = attempt.error;
      try {
        frozen = await repository.freeze(worktree, controller.signal);
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) {
          fatalError = error;
          controller.abort(error);
          return;
        }
        candidateStatus = "failed";
        const freezeError = errorMessage(error);
        candidateError = candidateError
          ? `${candidateError}; repository freeze failed: ${freezeError}`
          : `Repository freeze failed: ${freezeError}`;
      }

      const evidence = buildCandidateEvidence({
        task: config.task,
        candidateIndex,
        status: candidateStatus,
        baseCommit: repository.baseCommit,
        patch: frozen.patch,
        patchHash: frozen.patchHash,
        repositoryStatus: frozen.status,
        actions: attempt.execution?.actions ?? [],
        finalMessage: attempt.execution?.finalMessage ?? "",
        error: candidateError,
        repoRoot: repository.repoRoot,
        worktreePath: worktree.path,
      });
      results[candidateIndex] = {
        candidateIndex,
        status: candidateStatus,
        baseCommit: repository.baseCommit,
        patch: frozen.patch,
        patchHash: frozen.patchHash,
        repositoryStatus: frozen.status,
        actions: attempt.execution?.actions ?? [],
        finalMessage: attempt.execution?.finalMessage ?? "",
        error: candidateError,
        evidence: evidence.evidence,
      };
      emitProgress(dependencies, {
        type: "candidate-finished",
        candidateIndex,
        status: candidateStatus,
      });
    }
  };

  try {
    const workers = Array.from(
      { length: Math.min(config.candidateConcurrency, repository.worktrees.length) },
      worker,
    );
    await Promise.all(workers);
    if (fatalError !== undefined) throw fatalError;
    throwIfAborted(externalSignal);
    return results.map((candidate, candidateIndex) => {
      if (!candidate) {
        throw new Error(`Candidate ${candidateIndex + 1} did not produce a frozen result`);
      }
      return candidate;
    });
  } finally {
    externalSignal.removeEventListener("abort", onExternalAbort);
    controller.abort();
  }
}

async function runCandidateAttempt(
  dependencies: LavRunDependencies,
  input: Parameters<LavRunDependencies["candidateRunner"]["run"]>[0],
): Promise<CandidateAttempt> {
  try {
    const execution = await dependencies.candidateRunner.run(input);
    return { execution, status: execution.status, error: "" };
  } catch (error) {
    return {
      status: input.signal.aborted || isAbortError(error) ? "cancelled" : "failed",
      error: errorMessage(error),
    };
  }
}

function singletonSelection(): CandidateSelectionResult {
  return {
    index: 0,
    ranking: [0],
    meanPreferences: [0],
    wins: [0],
    counts: [0],
    pivots: [],
    ringPairs: [],
    pivotPairs: [],
    nComparisons: 0,
  };
}

function validateSelection(selection: CandidateSelectionResult, candidateCount: number): void {
  if (
    !Number.isInteger(selection.index) ||
    selection.index < 0 ||
    selection.index >= candidateCount
  ) {
    throw new Error(`Verifier selected invalid candidate index ${selection.index}`);
  }
  if (
    selection.ranking.length !== candidateCount ||
    new Set(selection.ranking).size !== candidateCount ||
    selection.ranking.some(
      (index) => !Number.isInteger(index) || index < 0 || index >= candidateCount,
    )
  ) {
    throw new Error("Verifier returned an invalid candidate ranking");
  }
}

function validateConfig(config: LavRunConfig): void {
  if (!config.task.trim()) throw new Error("LAV task must not be empty");
  if (!Number.isInteger(config.candidateCount) || config.candidateCount < 1) {
    throw new Error("candidateCount must be a positive integer");
  }
  if (
    !Number.isInteger(config.candidateConcurrency) ||
    config.candidateConcurrency < 1 ||
    config.candidateConcurrency > config.candidateCount
  ) {
    throw new Error("candidateConcurrency must be from 1 through candidateCount");
  }
  if (!Number.isInteger(config.verifierConcurrency) || config.verifierConcurrency < 1) {
    throw new Error("verifierConcurrency must be a positive integer");
  }
  if (!Number.isInteger(config.repetitions) || config.repetitions < 1) {
    throw new Error("repetitions must be a positive integer");
  }
  if (!Number.isInteger(config.pivots) || config.pivots < 0) {
    throw new Error("pivots must be a non-negative integer");
  }
  if (!Number.isSafeInteger(config.seed)) throw new Error("seed must be a safe integer");
  if (config.criteria.length < 1) throw new Error("Need at least one verifier criterion");
}

function emitProgress(dependencies: LavRunDependencies, event: LavProgressEvent): void {
  try {
    dependencies.onProgress?.(event);
  } catch {
    // Progress is advisory and must not alter run semantics or cleanup.
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatLavProgress(event: LavProgressEvent): string {
  switch (event.type) {
    case "repository-ready":
      return (
        `LAV: prepared ${event.candidateCount} isolated worktree(s) at ` +
        event.baseCommit.slice(0, 12)
      );
    case "preflight-started":
      return "LAV: probing verifier token-distribution capability";
    case "preflight-finished":
      return "LAV: verifier capability confirmed";
    case "candidate-started":
      return `LAV: candidate ${event.candidateIndex + 1} is running`;
    case "candidate-finished":
      return `LAV: candidate ${event.candidateIndex + 1} ${event.status}`;
    case "verification-started":
      return `LAV: verifying ${event.eligibleCandidateCount} frozen candidates`;
    case "verification-finished":
      return `LAV: selected candidate ${event.selectedCandidateIndex + 1}`;
    case "patch-applied":
      return event.changed
        ? `LAV: applied candidate ${event.candidateIndex + 1} patch`
        : `LAV: candidate ${event.candidateIndex + 1} patch was not applied`;
    case "cleanup-started":
      return "LAV: cleaning candidate worktrees";
    case "cleanup-finished":
      return event.error ? `LAV: cleanup failed: ${event.error}` : "LAV: cleanup complete";
  }
}
