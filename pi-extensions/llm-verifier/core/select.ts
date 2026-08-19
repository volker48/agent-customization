import {
  accumulate,
  createSeededRandom,
  directedPairKey,
  meanPreferences,
  pivotRoundPairs,
  rankByMeanPreference,
  ringCycle,
  selectPivots,
} from "./pivot-tournament.js";
import type { DirectedPair, DirectedPairReward, TournamentResult } from "./types.js";

export interface DirectedPairBatchScorer {
  scorePairs(
    pairs: readonly DirectedPair[],
  ): Promise<ReadonlyMap<string, DirectedPairReward>>;
}

export async function selectBestCandidate(args: {
  candidateCount: number;
  pivots: number;
  seed: number;
  scorer: DirectedPairBatchScorer;
}): Promise<TournamentResult> {
  if (!Number.isInteger(args.candidateCount) || args.candidateCount < 1) {
    throw new Error("Need at least one candidate");
  }
  if (!Number.isInteger(args.pivots) || args.pivots < 0) {
    throw new Error("pivots must be a non-negative integer");
  }
  if (args.candidateCount === 1) {
    return {
      index: 0,
      ranking: [0],
      meanPreferences: [0],
      wins: [0],
      counts: [0],
      pivots: args.pivots > 0 ? [0] : [],
      ringPairs: [],
      pivotPairs: [],
      nComparisons: 0,
    };
  }

  const ringPairs = ringCycle(args.candidateCount, createSeededRandom(args.seed));
  const ringScores = await args.scorer.scorePairs(ringPairs);
  assertAllScores(ringPairs, ringScores, "ring pass");

  const ringWins = Array<number>(args.candidateCount).fill(0);
  const ringCounts = Array<number>(args.candidateCount).fill(0);
  accumulate(
    ringPairs,
    (pair) => requireScore(ringScores, pair, "ring pass"),
    ringWins,
    ringCounts,
  );
  const pivots = selectPivots(ringWins, ringCounts, args.pivots);

  const pivotPairs = pivotRoundPairs(args.candidateCount, pivots);
  const uncachedPivotPairs = pivotPairs.filter((pair) => !ringScores.has(directedPairKey(pair)));
  const newPivotScores = await args.scorer.scorePairs(uncachedPivotPairs);
  assertAllScores(uncachedPivotPairs, newPivotScores, "pivot round");
  const pivotScores = new Map<string, DirectedPairReward>(ringScores);
  for (const [key, reward] of newPivotScores) pivotScores.set(key, reward);

  const wins = Array<number>(args.candidateCount).fill(0);
  const counts = Array<number>(args.candidateCount).fill(0);
  accumulate(
    ringPairs,
    (pair) => requireScore(ringScores, pair, "ring pass"),
    wins,
    counts,
  );
  accumulate(
    pivotPairs,
    (pair) => requireScore(pivotScores, pair, "pivot round"),
    wins,
    counts,
  );

  const ranking = rankByMeanPreference(wins, counts);
  return {
    index: ranking[0],
    ranking,
    meanPreferences: meanPreferences(wins, counts),
    wins,
    counts,
    pivots,
    ringPairs,
    pivotPairs,
    nComparisons: ringPairs.length + pivotPairs.length,
  };
}

function assertAllScores(
  pairs: readonly DirectedPair[],
  scores: ReadonlyMap<string, DirectedPairReward>,
  phase: string,
): void {
  for (const pair of pairs) requireScore(scores, pair, phase);
}

function requireScore(
  scores: ReadonlyMap<string, DirectedPairReward>,
  pair: DirectedPair,
  phase: string,
): DirectedPairReward {
  const score = scores.get(directedPairKey(pair));
  if (!score) {
    throw new Error(
      `Verifier materially failed: missing ${phase} score for ${directedPairKey(pair)}`,
    );
  }
  return score;
}
