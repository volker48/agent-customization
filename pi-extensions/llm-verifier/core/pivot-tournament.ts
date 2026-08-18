import type { DirectedPair, DirectedPairReward } from "./types.js";

export interface RandomSource {
  next(): number;
  integerBelow?(exclusiveMaximum: number): number;
}

/** Python-compatible MT19937, matching random.Random(integerSeed). */
export function createSeededRandom(seed: number): RandomSource {
  if (!Number.isSafeInteger(seed)) {
    throw new Error(`seed must be a safe integer, got ${seed}`);
  }
  return new PythonRandom(seed);
}

class PythonRandom implements RandomSource {
  private static readonly stateSize = 624;
  private static readonly middleWord = 397;
  private readonly state = new Uint32Array(PythonRandom.stateSize);
  private index = PythonRandom.stateSize;

  constructor(seed: number) {
    this.initializeByArray(splitSeed(Math.abs(seed)));
  }

  next(): number {
    const upper = this.nextUint32() >>> 5;
    const lower = this.nextUint32() >>> 6;
    return (upper * 67108864 + lower) / 9007199254740992;
  }

  integerBelow(exclusiveMaximum: number): number {
    if (!Number.isSafeInteger(exclusiveMaximum) || exclusiveMaximum < 1) {
      throw new Error(
        `exclusiveMaximum must be a positive safe integer: ${exclusiveMaximum}`,
      );
    }
    const bitCount = bitLength(exclusiveMaximum);
    while (true) {
      const value = this.getRandomBits(bitCount);
      if (value < exclusiveMaximum) return value;
    }
  }

  private getRandomBits(bitCount: number): number {
    if (bitCount < 1 || bitCount > 32) {
      throw new Error(
        `Python-compatible getRandomBits supports 1..32 bits, got ${bitCount}`,
      );
    }
    return this.nextUint32() >>> (32 - bitCount);
  }

  private initialize(seed: number): void {
    this.state[0] = seed >>> 0;
    for (let index = 1; index < PythonRandom.stateSize; index += 1) {
      const previous = this.state[index - 1];
      this.state[index] =
        (Math.imul(previous ^ (previous >>> 30), 1812433253) + index) >>> 0;
    }
    this.index = PythonRandom.stateSize;
  }

  private initializeByArray(key: readonly number[]): void {
    this.initialize(19650218);
    let stateIndex = 1;
    let keyIndex = 0;
    let remaining = Math.max(PythonRandom.stateSize, key.length);
    while (remaining > 0) {
      const previous = this.state[stateIndex - 1];
      this.state[stateIndex] =
        ((this.state[stateIndex] ^
          Math.imul(previous ^ (previous >>> 30), 1664525)) +
          key[keyIndex] +
          keyIndex) >>>
        0;
      stateIndex += 1;
      keyIndex += 1;
      if (stateIndex >= PythonRandom.stateSize) {
        this.state[0] = this.state[PythonRandom.stateSize - 1];
        stateIndex = 1;
      }
      if (keyIndex >= key.length) keyIndex = 0;
      remaining -= 1;
    }

    remaining = PythonRandom.stateSize - 1;
    while (remaining > 0) {
      const previous = this.state[stateIndex - 1];
      this.state[stateIndex] =
        ((this.state[stateIndex] ^
          Math.imul(previous ^ (previous >>> 30), 1566083941)) -
          stateIndex) >>>
        0;
      stateIndex += 1;
      if (stateIndex >= PythonRandom.stateSize) {
        this.state[0] = this.state[PythonRandom.stateSize - 1];
        stateIndex = 1;
      }
      remaining -= 1;
    }
    this.state[0] = 0x80000000;
  }

  private nextUint32(): number {
    if (this.index >= PythonRandom.stateSize) this.twist();
    let value = this.state[this.index];
    this.index += 1;
    value ^= value >>> 11;
    value ^= (value << 7) & 0x9d2c5680;
    value ^= (value << 15) & 0xefc60000;
    value ^= value >>> 18;
    return value >>> 0;
  }

  private twist(): void {
    const upperMask = 0x80000000;
    const lowerMask = 0x7fffffff;
    for (let index = 0; index < PythonRandom.stateSize; index += 1) {
      const nextIndex = (index + 1) % PythonRandom.stateSize;
      const middleIndex =
        (index + PythonRandom.middleWord) % PythonRandom.stateSize;
      const combined =
        (this.state[index] & upperMask) | (this.state[nextIndex] & lowerMask);
      const matrix = combined & 1 ? 0x9908b0df : 0;
      this.state[index] =
        (this.state[middleIndex] ^ (combined >>> 1) ^ matrix) >>> 0;
    }
    this.index = 0;
  }
}

function splitSeed(seed: number): number[] {
  let remaining = BigInt(seed);
  const words: number[] = [];
  do {
    words.push(Number(remaining & 0xffffffffn));
    remaining >>= 32n;
  } while (remaining > 0n);
  return words;
}

function bitLength(value: number): number {
  return value === 0 ? 0 : Math.floor(Math.log2(value)) + 1;
}

export function ringCycle(n: number, random: RandomSource): DirectedPair[] {
  assertCandidateCount(n);
  if (n <= 1) return [];
  const permutation = Array.from({ length: n }, (_, index) => index);
  for (let index = permutation.length - 1; index > 0; index -= 1) {
    const swapIndex = random.integerBelow
      ? random.integerBelow(index + 1)
      : Math.floor(random.next() * (index + 1));
    [permutation[index], permutation[swapIndex]] = [
      permutation[swapIndex],
      permutation[index],
    ];
  }
  return permutation.map((candidate, index) => ({
    a: candidate,
    b: permutation[(index + 1) % permutation.length],
  }));
}

export function bradleyTerry(rewardA: number, rewardB: number): number {
  if (!Number.isFinite(rewardA) || !Number.isFinite(rewardB)) {
    throw new Error("Bradley-Terry rewards must be finite");
  }
  const difference = rewardA - rewardB;
  return difference >= 0
    ? 1 / (1 + Math.exp(-difference))
    : Math.exp(difference) / (1 + Math.exp(difference));
}

export function accumulate(
  pairs: readonly DirectedPair[],
  score: (pair: DirectedPair) => DirectedPairReward,
  wins: number[],
  counts: number[],
): void {
  for (const pair of pairs) {
    const reward = score(pair);
    const probability = bradleyTerry(reward.candidateA, reward.candidateB);
    wins[pair.a] += probability;
    counts[pair.a] += 1;
    wins[pair.b] += 1 - probability;
    counts[pair.b] += 1;
  }
}

export function meanPreferences(
  wins: readonly number[],
  counts: readonly number[],
): number[] {
  if (wins.length !== counts.length) throw new Error("wins and counts lengths differ");
  return wins.map((win, index) => (counts[index] ? win / counts[index] : 0));
}

export function rankByMeanPreference(
  wins: readonly number[],
  counts: readonly number[],
): number[] {
  const means = meanPreferences(wins, counts);
  return means
    .map((_, index) => index)
    .sort((left, right) => means[right] - means[left] || left - right);
}

export function selectPivots(
  wins: readonly number[],
  counts: readonly number[],
  requestedPivots: number,
): number[] {
  if (!Number.isInteger(requestedPivots) || requestedPivots < 0) {
    throw new Error("requestedPivots must be a non-negative integer");
  }
  return rankByMeanPreference(wins, counts).slice(
    0,
    Math.min(requestedPivots, wins.length),
  );
}

export function pivotRoundPairs(n: number, pivots: readonly number[]): DirectedPair[] {
  assertCandidateCount(n);
  const pivotSet = new Set(pivots);
  if (pivotSet.size !== pivots.length) throw new Error("pivots contains duplicates");
  for (const pivot of pivots) {
    if (!Number.isInteger(pivot) || pivot < 0 || pivot >= n) {
      throw new Error(`pivot index out of range: ${pivot}`);
    }
  }

  const pairs: DirectedPair[] = [];
  for (let candidate = 0; candidate < n; candidate += 1) {
    if (pivotSet.has(candidate)) continue;
    for (const pivot of pivots) pairs.push({ a: candidate, b: pivot });
  }

  const sortedPivots = [...pivots].sort((left, right) => left - right);
  for (let left = 0; left < sortedPivots.length; left += 1) {
    for (let right = left + 1; right < sortedPivots.length; right += 1) {
      pairs.push({ a: sortedPivots[left], b: sortedPivots[right] });
    }
  }
  return pairs;
}

export function exactComparisonCount(n: number, requestedPivots: number): number {
  assertCandidateCount(n);
  if (!Number.isInteger(requestedPivots) || requestedPivots < 0) {
    throw new Error("requestedPivots must be a non-negative integer");
  }
  const pivots = Math.min(requestedPivots, n);
  if (n <= 1) return 0;
  return n + pivots * (n - pivots) + (pivots * (pivots - 1)) / 2;
}

export function directedPairKey(pair: DirectedPair): string {
  return `${pair.a}->${pair.b}`;
}

function assertCandidateCount(n: number): void {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`candidate count must be a non-negative integer: ${n}`);
  }
}
