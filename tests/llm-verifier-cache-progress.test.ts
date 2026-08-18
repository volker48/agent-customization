import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  canonicalText,
  computeRunHash,
  JsonPairScoreCache,
  scoreCacheEntryKey,
  stableStringify,
} from "../pi-extensions/llm-verifier/core/cache.js";
import {
  averageProgressRepetitions,
  extractProgressScores,
} from "../pi-extensions/llm-verifier/core/progress.js";
import type { Criterion } from "../pi-extensions/llm-verifier/core/types.js";

const criterion: Criterion = {
  id: "correctness",
  name: "Correctness",
  description: "Judge correctness.",
};

describe("content-addressed cache", () => {
  it("hashes relevant content and keeps directed entries distinct", async () => {
    const base = {
      implementation: {
        name: "pi-llm-verifier",
        version: "0.1",
        upstreamVersion: "0.2.0",
        pairwisePromptVersion: "p1",
        progressPromptVersion: "g1",
        scoreScaleVersion: "s1",
      },
      model: { provider: "deepseek", model: "v4", api: "openai-completions" },
      problem: "Fix it\r\n",
      candidateEvidence: ["patch A  ", "patch B"],
      criteria: [criterion],
      groundTruthNote: "",
      scoring: {
        repetitions: 2,
        pivots: 2,
        seed: 0,
        temperature: 1,
        topLogprobs: 20,
        extractionMode: "direct-tags",
        minimumScaleTokens: 2,
      },
    };
    const first = computeRunHash(base);
    expect(computeRunHash({ ...base, problem: "Fix it\n" })).toBe(first);
    expect(computeRunHash({ ...base, candidateEvidence: ["different", "patch B"] })).not.toBe(
      first,
    );
    expect(computeRunHash({ ...base, model: { ...base.model, model: "v5" } })).not.toBe(
      first,
    );
    expect(scoreCacheEntryKey("c", 0, 1, 0)).not.toBe(
      scoreCacheEntryKey("c", 1, 0, 0),
    );
    expect(canonicalText(" a  \r\n b\n")).toBe("a\n b");
    expect(stableStringify({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');

    const directory = await mkdtemp(join(tmpdir(), "lav-cache-"));
    try {
      const path = join(directory, "scores.json");
      const cache = new JsonPairScoreCache(path, first);
      const key = scoreCacheEntryKey("c", 0, 1, 0);
      await cache.set(key, { candidateA: 0.8, candidateB: 0.2 });
      expect(await cache.get(key)).toMatchObject({ candidateA: 0.8, candidateB: 0.2 });
      expect(JSON.parse(await readFile(path, "utf8")).schemaVersion).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("progress scoring", () => {
  it("uses the opposite scale and leaves unreadable checkpoints explicit", () => {
    const completion = {
      text: "",
      positions: [
        { token: "<c1>", alternatives: [] },
        {
          token: "A",
          alternatives: [
            { token: "A", logprob: 0 },
            { token: "T", logprob: -4 },
          ],
        },
        { token: "</c1>\n<c2>", alternatives: [] },
        {
          token: "T",
          alternatives: [
            { token: "A", logprob: -4 },
            { token: "T", logprob: 0 },
          ],
        },
      ],
    };
    const scores = extractProgressScores(completion, 2, 2);
    expect(scores[0]).toBeLessThan(0.02);
    expect(scores[1]).toBeGreaterThan(0.98);
    expect(averageProgressRepetitions([[0, null], [1, null]])).toEqual([0.5, null]);
  });
});

