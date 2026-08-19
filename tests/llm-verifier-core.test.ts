import { describe, expect, it } from "vitest";

import {
  expectedScaleValue,
  extractTaggedExpectation,
  findPositionAfterTag,
  MissingScoreDistributionError,
  parseTaggedSampledLetter,
} from "../pi-extensions/llm-verifier/core/expected-value.js";
import {
  averageDirectedRewards,
  mapSlotRewardToCandidateOrder,
  planPairwiseEvaluations,
  scoreDirectedPair,
} from "../pi-extensions/llm-verifier/core/pairwise.js";
import {
  bradleyTerry,
  createSeededRandom,
  directedPairKey,
  exactComparisonCount,
  pivotRoundPairs,
  rankByMeanPreference,
  ringCycle,
  selectPivots,
} from "../pi-extensions/llm-verifier/core/pivot-tournament.js";
import {
  buildPairwisePrompt,
  buildProgressPrompt,
  formatProgressSteps,
} from "../pi-extensions/llm-verifier/core/prompt.js";
import {
  pairwiseScaleValue,
  progressScaleValue,
} from "../pi-extensions/llm-verifier/core/scale.js";
import { selectBestCandidate } from "../pi-extensions/llm-verifier/core/select.js";
import type { Criterion } from "../pi-extensions/llm-verifier/core/types.js";

const criterion: Criterion = {
  id: "correctness",
  name: "Correctness",
  description: "Judge correctness.",
};

describe("score scales and expectations", () => {
  it("points pairwise and progress in opposite directions", () => {
    expect(pairwiseScaleValue("A")).toBe(1);
    expect(pairwiseScaleValue("T")).toBe(0);
    expect(progressScaleValue("A")).toBe(0);
    expect(progressScaleValue("T")).toBe(1);
  });

  it("renormalizes visible scale-token mass", () => {
    const expectation = expectedScaleValue(
      [
        { token: " A", logprob: Math.log(0.75) },
        { token: "T", logprob: Math.log(0.25) },
        { token: "not-a-score", logprob: 0 },
      ],
      { direction: "pairwise" },
    );
    expect(expectation?.scaleTokenCount).toBe(2);
    expect(expectation?.value).toBeCloseTo(0.75, 12);
  });

  it("deduplicates token aliases by maximum logprob", () => {
    const expectation = expectedScaleValue(
      [
        { token: "A", logprob: -3 },
        { token: " a", logprob: -1 },
        { token: ">T", logprob: -1 },
      ],
      { direction: "pairwise" },
    );
    expect(expectation?.scaleTokenCount).toBe(2);
    expect(expectation?.value).toBeCloseTo(0.5, 12);
  });

  it("uses the last verdict tag across exact and fused tokenizations", () => {
    const positions = [
      { token: "<score_A>", alternatives: [] },
      { token: " T", alternatives: [{ token: " T", logprob: 0 }] },
      { token: "</score_A> analysis <score_A", alternatives: [] },
      {
        token: ">A",
        alternatives: [
          { token: ">A", logprob: 0 },
          { token: ">T", logprob: -4 },
        ],
      },
    ];
    expect(findPositionAfterTag(positions, "<score_A>")).toBe(positions[3]);
    expect(
      extractTaggedExpectation({ text: "", positions }, "<score_A>", {
        direction: "pairwise",
        minScaleTokens: 2,
      }).value,
    ).toBeGreaterThan(0.98);
  });

  it("throws on missing distributions instead of manufacturing a neutral tie", () => {
    expect(() =>
      extractTaggedExpectation({ text: "<score_A> A </score_A>", positions: [] }, "<score_A>", {
        direction: "pairwise",
        minScaleTokens: 2,
      }),
    ).toThrow(MissingScoreDistributionError);
    expect(parseTaggedSampledLetter("<score_A> b </score_A>", "<score_A>")).toBe("B");
  });
});

describe("prompt behavior", () => {
  it("keeps criterion-specific pairwise text at the tail for prefix caching", () => {
    const first = buildPairwisePrompt({
      problem: "P",
      trajectoryA: "A",
      trajectoryB: "B",
      criterion,
    });
    const second = buildPairwisePrompt({
      problem: "P",
      trajectoryA: "A",
      trajectoryB: "B",
      criterion: { id: "fit", name: "Fit", description: "Judge fit." },
    });
    const firstCriterion = first.indexOf("**Evaluation Guideline");
    const secondCriterion = second.indexOf("**Evaluation Guideline");
    expect(first.slice(0, firstCriterion)).toBe(second.slice(0, secondCriterion));
    expect(first.indexOf("**Trajectory B:**")).toBeLessThan(firstCriterion);
    expect(first.indexOf("**Rating Scale:**")).toBeLessThan(firstCriterion);
  });

  it("numbers progress steps and preserves skeptical calibration", () => {
    const steps = formatProgressSteps(["ran command", "observed output"]);
    expect(steps).toMatch(/=== Agent Step 2 ===/);
    const prompt = buildProgressPrompt({
      problem: "Fix it",
      trajectoryText: steps,
      stepCount: 2,
      checkpointSteps: [1, 2],
    });
    expect(prompt).toMatch(/Trust observed output/);
    expect(prompt).toMatch(/DECREASE the score/);
    expect(prompt).toMatch(/<c2>LETTER<\/c2>/);
  });
});

describe("repeated pairwise evaluation", () => {
  it("swaps odd repetitions and maps scores back to candidate order", () => {
    const jobs = planPairwiseEvaluations([{ a: 1, b: 4 }], [criterion], 3);
    expect(jobs.map((job) => [job.repetition, job.slotAIndex, job.slotBIndex])).toEqual([
      [0, 1, 4],
      [1, 4, 1],
      [2, 1, 4],
    ]);
    expect(mapSlotRewardToCandidateOrder(jobs[1], { slotA: 0.2, slotB: 0.9 })).toEqual({
      candidateA: 0.9,
      candidateB: 0.2,
    });
  });

  it("averages criteria and repetitions in candidate order", async () => {
    const seen: Array<[number, string, string]> = [];
    const result = await scoreDirectedPair({
      pair: { a: 0, b: 1 },
      candidates: ["left", "right"],
      criteria: [criterion],
      repetitions: 2,
      async scoreSlots(job, candidateA, candidateB) {
        seen.push([job.repetition, candidateA, candidateB]);
        return job.swapped ? { slotA: 0.1, slotB: 0.8 } : { slotA: 0.8, slotB: 0.1 };
      },
    });
    expect(seen).toEqual([
      [0, "left", "right"],
      [1, "right", "left"],
    ]);
    expect(result).toEqual({ candidateA: 0.8, candidateB: 0.1 });
    expect(averageDirectedRewards([result, result])).toEqual(result);
  });
});

describe("Probabilistic Pivot Tournament", () => {
  it("matches Python random.Random(seed).shuffle fixtures and balances slots", () => {
    const ring = ringCycle(5, createSeededRandom(0));
    expect(ring).toEqual([
      { a: 2, b: 1 },
      { a: 1, b: 0 },
      { a: 0, b: 4 },
      { a: 4, b: 3 },
      { a: 3, b: 2 },
    ]);
    for (let candidate = 0; candidate < 5; candidate += 1) {
      expect(ring.filter((pair) => pair.a === candidate)).toHaveLength(1);
      expect(ring.filter((pair) => pair.b === candidate)).toHaveLength(1);
    }
  });

  it("preserves Bradley-Terry, pivot-pair, count, and tie semantics", () => {
    expect(bradleyTerry(0.5, 0.5)).toBe(0.5);
    expect(bradleyTerry(1, 0)).toBeGreaterThan(0.73);
    expect(selectPivots([1, 1, 0], [2, 2, 1], 2)).toEqual([0, 1]);
    expect(pivotRoundPairs(5, [3, 1])).toEqual([
      { a: 0, b: 3 },
      { a: 0, b: 1 },
      { a: 2, b: 3 },
      { a: 2, b: 1 },
      { a: 4, b: 3 },
      { a: 4, b: 1 },
      { a: 1, b: 3 },
    ]);
    expect(exactComparisonCount(5, 2)).toBe(12);
    expect(rankByMeanPreference([1, 1, 1], [2, 2, 2])).toEqual([0, 1, 2]);
  });

  it("reuses ring scores and reports exact directed comparisons", async () => {
    const calls: string[][] = [];
    const strength = [0.1, 0.9, 0.5, 0.2, 0.7];
    const result = await selectBestCandidate({
      candidateCount: 5,
      pivots: 2,
      seed: 0,
      scorer: {
        async scorePairs(pairs) {
          calls.push(pairs.map(directedPairKey));
          return new Map(
            pairs.map((pair) => [
              directedPairKey(pair),
              { candidateA: strength[pair.a], candidateB: strength[pair.b] },
            ]),
          );
        },
      },
    });
    expect(result.index).toBe(1);
    expect(result.nComparisons).toBe(12);
    expect(result.ranking[0]).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it("surfaces materially missing verifier work", async () => {
    await expect(
      selectBestCandidate({
        candidateCount: 3,
        pivots: 1,
        seed: 0,
        scorer: {
          async scorePairs() {
            return new Map();
          },
        },
      }),
    ).rejects.toThrow(/materially failed/);
  });
});
