import {
  computeRunHash,
  JsonPairScoreCache,
  type RunFingerprintInput,
} from "../core/cache.js";
import { selectBestCandidate } from "../core/select.js";
import type { Criterion, TournamentResult } from "../core/types.js";
import {
  PAIRWISE_PROMPT_VERSION,
  PROGRESS_PROMPT_VERSION,
  SCORE_SCALE_VERSION,
  VERIFIER_IMPLEMENTATION,
  VERIFIER_VERSION,
} from "../core/types.js";
import { PiVerifierModelClient } from "./model-client.js";
import { PiPairwiseBatchScorer } from "./pairwise-batch-scorer.js";

export interface NativeVerifierSelectionOptions {
  problem: string;
  candidates: readonly string[];
  criteria: readonly Criterion[];
  groundTruthNote?: string;
  repetitions: number;
  pivots: number;
  seed: number;
  client: PiVerifierModelClient;
  cachePath?: string;
  maxConcurrency?: number;
  signal?: AbortSignal;
  preflight?: boolean;
}

export interface NativeVerifierSelectionResult extends TournamentResult {
  runHash: string;
}

export async function selectWithNativeVerifier(
  options: NativeVerifierSelectionOptions,
): Promise<NativeVerifierSelectionResult> {
  if (options.candidates.length < 1) throw new Error("Need at least one candidate");
  if (options.criteria.length < 1) throw new Error("Need at least one verifier criterion");

  const runHash = computeRunHash(buildRunFingerprint(options));
  const cache = options.cachePath
    ? new JsonPairScoreCache(options.cachePath, runHash)
    : undefined;
  const scorer = new PiPairwiseBatchScorer(options.client, {
    problem: options.problem,
    candidates: options.candidates,
    criteria: options.criteria,
    groundTruthNote: options.groundTruthNote,
    repetitions: options.repetitions,
    maxConcurrency: options.maxConcurrency,
    signal: options.signal,
    cache,
  });

  if (options.candidates.length > 1 && options.preflight !== false) {
    await options.client.assertCapabilities(options.signal);
  }
  const result = await selectBestCandidate({
    candidateCount: options.candidates.length,
    pivots: options.pivots,
    seed: options.seed,
    scorer,
  });
  return { ...result, runHash };
}

export function buildRunFingerprint(
  options: NativeVerifierSelectionOptions,
): RunFingerprintInput {
  const client = options.client.fingerprint();
  return {
    implementation: {
      name: VERIFIER_IMPLEMENTATION,
      version: VERIFIER_VERSION,
      upstreamVersion: "0.2.0",
      pairwisePromptVersion: PAIRWISE_PROMPT_VERSION,
      progressPromptVersion: PROGRESS_PROMPT_VERSION,
      scoreScaleVersion: SCORE_SCALE_VERSION,
    },
    model: client.model,
    problem: options.problem,
    candidateEvidence: options.candidates,
    criteria: options.criteria,
    groundTruthNote: options.groundTruthNote ?? "",
    scoring: {
      repetitions: options.repetitions,
      pivots: options.pivots,
      seed: options.seed,
      temperature: client.scoring.temperature,
      topLogprobs: client.scoring.topLogprobs,
      extractionMode: client.scoring.extractionMode,
      minimumScaleTokens: client.scoring.minimumScaleTokens,
      maxAnalysisTokens: client.scoring.maxAnalysisTokens,
      directTagMaxTokens: client.scoring.directTagMaxTokens,
      reasoningEffort: client.scoring.reasoningEffort,
    },
  };
}
