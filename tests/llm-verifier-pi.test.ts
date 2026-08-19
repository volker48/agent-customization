import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import type { PairScoreCache } from "../pi-extensions/llm-verifier/core/cache.js";
import type { Criterion, DirectedPairReward } from "../pi-extensions/llm-verifier/core/types.js";
import {
  PiVerifierModelClient,
  requirePiModelRegistry,
  type PiModelRegistryLike,
  type VerifierCompletionOptions,
} from "../pi-extensions/llm-verifier/pi/model-client.js";
import {
  buildRunFingerprint,
  selectWithNativeVerifier,
} from "../pi-extensions/llm-verifier/pi/native-selection.js";
import { parseOpenAiSseLogprobs } from "../pi-extensions/llm-verifier/pi/openai-logprob-capture.js";
import {
  partitionPrefixWarmup,
  PiPairwiseBatchScorer,
  type PendingPairwiseEvaluation,
} from "../pi-extensions/llm-verifier/pi/pairwise-batch-scorer.js";

const criterion: Criterion = {
  id: "correctness",
  name: "Correctness",
  description: "Judge correctness.",
};

const fakeModel = {
  id: "verifier",
  provider: "local",
  api: "openai-completions",
  baseUrl: "http://localhost:8000/v1",
  maxTokens: 32768,
} as unknown as Model<Api>;

function assistant(text: string, stopReason: AssistantMessage["stopReason"] = "stop") {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: fakeModel.api,
    provider: fakeModel.provider,
    model: fakeModel.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  } satisfies AssistantMessage;
}

function sseDataUrl(positions: unknown[]): string {
  const body = [
    `data: ${JSON.stringify({ choices: [{ logprobs: { content: positions } }] })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  return `data:text/event-stream;charset=utf-8,${encodeURIComponent(body)}`;
}

function position(token: string, alternatives: readonly { token: string; logprob: number }[]) {
  return {
    token,
    logprob: alternatives[0]?.logprob ?? 0,
    top_logprobs: alternatives,
  };
}

function registryWithComplete(
  complete: (
    model: Model<Api>,
    context: Context,
    options: VerifierCompletionOptions,
  ) => Promise<AssistantMessage>,
): PiModelRegistryLike {
  return {
    find: () => fakeModel,
    complete,
  };
}

describe("OpenAI-compatible logprob observation", () => {
  it("parses chosen positions and top alternatives from SSE", () => {
    const sse = [
      'data: {"choices":[{"logprobs":{"content":[{"token":"<score_A>","logprob":-0.1,"top_logprobs":[]}]}}]}',
      "",
      'data: {"choices":[{"logprobs":{"content":[{"token":" A","logprob":-0.2,"top_logprobs":[{"token":" A","logprob":-0.2},{"token":"T","logprob":-1.2}]}]}}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const positions = parseOpenAiSseLogprobs(sse);
    expect(positions).toHaveLength(2);
    expect(positions[1].alternatives.map((item) => item.token)).toEqual([" A", "T"]);
  });

  it("scores direct tags through Pi request customization without sampled fallback", async () => {
    const payloads: object[] = [];
    const registry = registryWithComplete(async (model, _context, options) => {
      const payload = await options.onPayload?.({ model: model.id, stream: true }, model);
      if (payload && typeof payload === "object") payloads.push(payload);
      await options.fetch?.(
        sseDataUrl([
          position("<score_A>", []),
          position(" A", [
            { token: " A", logprob: -0.1 },
            { token: "T", logprob: -2.1 },
          ]),
          position("</score_A>\n<score_B>", []),
          position(" T", [
            { token: "A", logprob: -2.1 },
            { token: " T", logprob: -0.1 },
          ]),
        ]),
      );
      return assistant("<score_A> A </score_A>\n<score_B> T </score_B>");
    });
    const client = new PiVerifierModelClient(registry, {
      model: { ...fakeModel, provider: "deepseek" } as Model<Api>,
      extractionMode: "direct-tags",
    });
    const result = await client.scorePair({
      problem: "P",
      trajectoryA: "A",
      trajectoryB: "B",
      criterion,
    });
    expect(result.slotA).toBeGreaterThan(0.87);
    expect(result.slotB).toBeLessThan(0.13);
    expect(payloads[0]).toMatchObject({ logprobs: true, top_logprobs: 20 });
  });

  it("preserves sequential prefill conditioning for score B", async () => {
    const prefixes: string[] = [];
    const payloads: object[] = [];
    const registry = registryWithComplete(async (model, context, options) => {
      const finalMessage = context.messages.at(-1);
      if (finalMessage?.role !== "assistant") return assistant("Reasoned analysis.");
      const prefix = finalMessage.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      prefixes.push(prefix);
      const scoreA = prefix.endsWith("<score_A>");
      const sampled = scoreA ? " A" : " T";
      const alternatives = scoreA
        ? [
            { token: " A", logprob: -0.1 },
            { token: "T", logprob: -2.1 },
          ]
        : [
            { token: "A", logprob: -2.1 },
            { token: " T", logprob: -0.1 },
          ];
      const payload = await options.onPayload?.({ model: model.id, stream: true }, model);
      if (payload && typeof payload === "object") payloads.push(payload);
      await options.fetch?.(sseDataUrl([position(sampled, alternatives)]));
      return assistant(sampled);
    });
    const client = new PiVerifierModelClient(registry, {
      model: fakeModel,
      extractionMode: "prefill",
    });
    const result = await client.scorePair({
      problem: "P",
      trajectoryA: "A",
      trajectoryB: "B",
      criterion,
    });
    expect(prefixes).toHaveLength(2);
    expect(prefixes[1]).toContain("<score_A>A</score_A>");
    expect(result.slotA).toBeGreaterThan(0.87);
    expect(result.slotB).toBeLessThan(0.13);
    expect(payloads[0]).toMatchObject({
      logprobs: true,
      top_logprobs: 20,
      continue_final_message: true,
      add_generation_prompt: false,
    });
  });

  it("fails clearly on unsupported Pi/provider capability", async () => {
    expect(() => requirePiModelRegistry({ find() {} })).toThrow(/0\.84\.2/);
    expect(
      () =>
        new PiVerifierModelClient(
          registryWithComplete(async () => assistant("")),
          { model: { ...fakeModel, api: "google-vertex" } as Model<Api> },
        ),
    ).toThrow(/sampled labels are not accepted/);

    const client = new PiVerifierModelClient(
      registryWithComplete(async () => assistant("<score_A> A </score_A>")),
      { model: fakeModel, extractionMode: "direct-tags" },
    );
    await expect(
      client.scorePair({
        problem: "P",
        trajectoryA: "A",
        trajectoryB: "B",
        criterion,
      }),
    ).rejects.toThrow(/did not route.*fetch/i);
  });
});

describe("cached Pi batch scorer", () => {
  it("warms one job per slot prefix before the remaining criteria", () => {
    const makeEvaluation = (
      repetition: number,
      slotAIndex: number,
      slotBIndex: number,
    ): PendingPairwiseEvaluation => ({
      job: {
        pair: { a: 0, b: 1 },
        criterion,
        repetition,
        swapped: repetition % 2 === 1,
        slotAIndex,
        slotBIndex,
      },
      evaluationKey: String(repetition),
      cacheKey: String(repetition),
    });
    const split = partitionPrefixWarmup([
      makeEvaluation(0, 0, 1),
      makeEvaluation(2, 0, 1),
      makeEvaluation(1, 1, 0),
      makeEvaluation(3, 1, 0),
    ]);
    expect(split.warm.map((item) => item.evaluationKey)).toEqual(["0", "1"]);
    expect(split.rest.map((item) => item.evaluationKey)).toEqual(["2", "3"]);
  });

  it("caches directed criterion/repetition scores and maps odd slots back", async () => {
    const entries = new Map<string, DirectedPairReward>();
    const cache: PairScoreCache = {
      async get(key) {
        return entries.get(key);
      },
      async set(key, value) {
        entries.set(key, value);
      },
    };
    const seen: Array<[string, string]> = [];
    const scorer = new PiPairwiseBatchScorer(
      {
        async scorePair(input) {
          seen.push([input.trajectoryA, input.trajectoryB]);
          return input.trajectoryA === "left"
            ? { slotA: 0.8, slotB: 0.2 }
            : { slotA: 0.2, slotB: 0.8 };
        },
      },
      {
        problem: "P",
        candidates: ["left", "right"],
        criteria: [criterion],
        repetitions: 2,
        cache,
        maxConcurrency: 2,
      },
    );
    const first = await scorer.scorePairs([{ a: 0, b: 1 }]);
    expect(first.get("0->1")).toEqual({ candidateA: 0.8, candidateB: 0.2 });
    expect(seen).toEqual([
      ["left", "right"],
      ["right", "left"],
    ]);
    await scorer.scorePairs([{ a: 0, b: 1 }]);
    expect(seen).toHaveLength(2);
    await scorer.scorePairs([{ a: 1, b: 0 }]);
    expect(seen).toHaveLength(4);
  });
});

describe("native selection facade", () => {
  it("uses the one-candidate fast path without invoking verifier inference", async () => {
    let calls = 0;
    const client = new PiVerifierModelClient(
      registryWithComplete(async () => {
        calls += 1;
        return assistant("");
      }),
      { model: fakeModel, extractionMode: "prefill" },
    );
    const options = {
      problem: "P",
      candidates: ["only"],
      criteria: [criterion],
      repetitions: 2,
      pivots: 2,
      seed: 0,
      client,
    };
    const result = await selectWithNativeVerifier(options);
    expect(result.index).toBe(0);
    expect(result.nComparisons).toBe(0);
    expect(calls).toBe(0);
    expect(buildRunFingerprint(options).scoring.extractionMode).toBe("prefill");
  });
});
