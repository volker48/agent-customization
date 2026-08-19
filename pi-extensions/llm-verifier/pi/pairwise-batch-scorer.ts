import type { PairScoreCache } from "../core/cache.js";
import { scoreCacheEntryKey } from "../core/cache.js";
import {
  averageDirectedRewards,
  mapSlotRewardToCandidateOrder,
  pairEvaluationKey,
  planPairwiseEvaluations,
} from "../core/pairwise.js";
import type { PairwisePromptInput } from "../core/prompt.js";
import { directedPairKey } from "../core/pivot-tournament.js";
import type { DirectedPairBatchScorer } from "../core/select.js";
import type {
  Criterion,
  DirectedPair,
  DirectedPairReward,
  PairwiseEvaluationJob,
  SlotPairReward,
} from "../core/types.js";

export interface PairwiseVerifierClient {
  scorePair(input: PairwisePromptInput, signal?: AbortSignal): Promise<SlotPairReward>;
}

export interface PiPairwiseBatchScorerOptions {
  problem: string;
  candidates: readonly string[];
  criteria: readonly Criterion[];
  groundTruthNote?: string;
  repetitions: number;
  maxConcurrency?: number;
  signal?: AbortSignal;
  cache?: PairScoreCache;
}

export interface PendingPairwiseEvaluation {
  job: PairwiseEvaluationJob;
  evaluationKey: string;
  cacheKey: string;
}

export class PiPairwiseBatchScorer implements DirectedPairBatchScorer {
  private readonly maxConcurrency: number;

  constructor(
    private readonly client: PairwiseVerifierClient,
    private readonly options: PiPairwiseBatchScorerOptions,
  ) {
    if (options.candidates.length < 1) throw new Error("Need at least one candidate");
    if (options.criteria.length < 1) throw new Error("Need at least one verifier criterion");
    this.maxConcurrency = positiveInteger(options.maxConcurrency ?? 16, "maxConcurrency");
  }

  async scorePairs(
    pairs: readonly DirectedPair[],
  ): Promise<ReadonlyMap<string, DirectedPairReward>> {
    throwIfAborted(this.options.signal);
    const uniquePairs = deduplicatePairs(pairs);
    validatePairs(uniquePairs, this.options.candidates.length);
    const jobs = planPairwiseEvaluations(
      uniquePairs,
      this.options.criteria,
      this.options.repetitions,
    );
    const rewards = new Map<string, DirectedPairReward>();
    const pending = await this.loadCachedJobs(jobs, rewards);
    const { warm, rest } = partitionPrefixWarmup(pending);

    await mapWithConcurrency(warm, this.maxConcurrency, (evaluation) =>
      this.scoreEvaluation(evaluation, rewards),
    );
    await mapWithConcurrency(rest, this.maxConcurrency, (evaluation) =>
      this.scoreEvaluation(evaluation, rewards),
    );

    const output = new Map<string, DirectedPairReward>();
    for (const pair of uniquePairs) {
      const pairRewards: DirectedPairReward[] = [];
      for (const criterion of this.options.criteria) {
        for (let repetition = 0; repetition < this.options.repetitions; repetition += 1) {
          const evaluationKey = pairEvaluationKey(criterion.id, pair, repetition);
          const reward = rewards.get(evaluationKey);
          if (!reward) {
            throw new Error(
              `Verifier materially failed: missing score for ${directedPairKey(pair)}, ` +
                `criterion ${criterion.id}, repetition ${repetition}`,
            );
          }
          pairRewards.push(reward);
        }
      }
      output.set(directedPairKey(pair), averageDirectedRewards(pairRewards));
    }
    return output;
  }

  private async loadCachedJobs(
    jobs: readonly PairwiseEvaluationJob[],
    rewards: Map<string, DirectedPairReward>,
  ): Promise<PendingPairwiseEvaluation[]> {
    const lookups = await Promise.all(
      jobs.map(async (job): Promise<PendingPairwiseEvaluation | undefined> => {
        const evaluationKey = pairEvaluationKey(job.criterion.id, job.pair, job.repetition);
        const cacheKey = scoreCacheEntryKey(
          job.criterion.id,
          job.pair.a,
          job.pair.b,
          job.repetition,
        );
        const cached = await this.options.cache?.get(cacheKey);
        if (cached) {
          rewards.set(evaluationKey, cached);
          return undefined;
        }
        return { job, evaluationKey, cacheKey };
      }),
    );
    return lookups.filter(
      (evaluation): evaluation is PendingPairwiseEvaluation => evaluation !== undefined,
    );
  }

  private async scoreEvaluation(
    evaluation: PendingPairwiseEvaluation,
    rewards: Map<string, DirectedPairReward>,
  ): Promise<void> {
    throwIfAborted(this.options.signal);
    const { job } = evaluation;
    const trajectoryA = this.options.candidates[job.slotAIndex];
    const trajectoryB = this.options.candidates[job.slotBIndex];
    if (trajectoryA === undefined || trajectoryB === undefined) {
      throw new Error(`Pair index out of range: ${job.slotAIndex}, ${job.slotBIndex}`);
    }
    const slotReward = await this.client.scorePair(
      {
        problem: this.options.problem,
        trajectoryA,
        trajectoryB,
        criterion: job.criterion,
        groundTruthNote: this.options.groundTruthNote,
      },
      this.options.signal,
    );
    const reward = mapSlotRewardToCandidateOrder(job, slotReward);
    rewards.set(evaluation.evaluationKey, reward);
    try {
      await this.options.cache?.set(evaluation.cacheKey, reward);
    } catch {
      // Cache persistence is an optimization; a completed verifier score stays valid.
    }
  }
}

export function partitionPrefixWarmup(evaluations: readonly PendingPairwiseEvaluation[]): {
  warm: PendingPairwiseEvaluation[];
  rest: PendingPairwiseEvaluation[];
} {
  const prefixes = new Set<string>();
  const warm: PendingPairwiseEvaluation[] = [];
  const rest: PendingPairwiseEvaluation[] = [];
  for (const evaluation of evaluations) {
    const prefixKey = `${evaluation.job.slotAIndex}->${evaluation.job.slotBIndex}`;
    if (prefixes.has(prefixKey)) rest.push(evaluation);
    else {
      prefixes.add(prefixKey);
      warm.push(evaluation);
    }
  }
  return { warm, rest };
}

function deduplicatePairs(pairs: readonly DirectedPair[]): DirectedPair[] {
  const output: DirectedPair[] = [];
  const seen = new Set<string>();
  for (const pair of pairs) {
    const key = directedPairKey(pair);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(pair);
  }
  return output;
}

function validatePairs(pairs: readonly DirectedPair[], candidateCount: number): void {
  for (const pair of pairs) {
    if (
      !Number.isInteger(pair.a) ||
      !Number.isInteger(pair.b) ||
      pair.a < 0 ||
      pair.b < 0 ||
      pair.a >= candidateCount ||
      pair.b >= candidateCount
    ) {
      throw new Error(`Pair index out of range: ${pair.a}, ${pair.b}`);
    }
    if (pair.a === pair.b) throw new Error(`Cannot score self-comparison ${pair.a}`);
  }
}

async function mapWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  let firstFailure: unknown;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      if (firstFailure !== undefined) return;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      try {
        await operation(values[index]);
      } catch (error) {
        firstFailure ??= error;
        return;
      }
    }
  });
  await Promise.all(workers);
  if (firstFailure !== undefined) throw firstFailure;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Verifier scoring aborted");
}
