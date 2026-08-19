export const VERIFIER_IMPLEMENTATION = "pi-llm-verifier";
export const VERIFIER_VERSION = "0.1.0-dev";
export const PAIRWISE_PROMPT_VERSION = "pairwise-v0.2.0-layout-1";
export const PROGRESS_PROMPT_VERSION = "progress-v0.2.0-layout-1";
export const SCORE_SCALE_VERSION = "letters-a-through-t-v1";

export interface Criterion {
  id: string;
  name: string;
  description: string;
}

export interface DirectedPair {
  a: number;
  b: number;
}

/** Rewards mapped back into directed candidate order, not prompt-slot order. */
export interface DirectedPairReward {
  candidateA: number;
  candidateB: number;
}

/** Rewards in the literal A/B slots used by one verifier prompt. */
export interface SlotPairReward {
  slotA: number;
  slotB: number;
}

export interface TokenAlternative {
  token: string;
  logprob: number;
}

/** One generated token and the provider's alternatives at that position. */
export interface TokenPositionDistribution {
  token: string;
  logprob?: number;
  alternatives: readonly TokenAlternative[];
}

export interface VerifierCompletion {
  text: string;
  positions: readonly TokenPositionDistribution[];
}

export interface ScaleProbability {
  letter: string;
  probability: number;
}

export interface ScaleExpectation {
  value: number;
  scaleTokenCount: number;
  probabilities: readonly ScaleProbability[];
}

export interface PairwiseEvaluationJob {
  pair: DirectedPair;
  criterion: Criterion;
  repetition: number;
  swapped: boolean;
  slotAIndex: number;
  slotBIndex: number;
}

export interface TournamentResult {
  index: number;
  ranking: number[];
  /** Count-normalized soft wins. These are preferences, not correctness probabilities. */
  meanPreferences: number[];
  wins: number[];
  counts: number[];
  pivots: number[];
  ringPairs: DirectedPair[];
  pivotPairs: DirectedPair[];
  nComparisons: number;
}
