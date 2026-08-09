import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AssistantMessage, Api, Message, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import { loadFusionConfig, validateFusionConfig } from "../pi-extensions/fusion/config.js";
import { createFusionDebugLogger } from "../pi-extensions/fusion/debug-log.js";
import { parseModelRef, resolveModelRef } from "../pi-extensions/fusion/model-ref.js";
import { completeWithTools } from "../pi-extensions/fusion/model-runner.js";
import { parseJudgeOutput, runFusion } from "../pi-extensions/fusion/orchestrator.js";
import {
  createProgressState,
  formatProgress,
  reduceProgress,
} from "../pi-extensions/fusion/progress.js";
import {
  buildJudgePrompt,
  buildMetaPrompt,
  buildPanelPrompt,
  computeConfidence,
  JUDGE_SYSTEM_PROMPT,
  PANEL_SYSTEM_PROMPT,
  parseMetaPromptOutput,
} from "../pi-extensions/fusion/prompts.js";
import { renderFusionPanelMarkdown, toFusionPanelMessage } from "../pi-extensions/fusion/render.js";
import type {
  CompletionClient,
  FusionConfig,
  FusionProgressEvent,
  FusionTool,
  ModelRegistryLike,
  ResolvedModel,
} from "../pi-extensions/fusion/types.js";

const FAKE_MODEL = {
  id: "model",
  provider: "provider",
} as unknown as Model<Api>;

function assistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages" as Api,
    provider: "test" as AssistantMessage["provider"],
    model: "test",
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
  };
}

function textMessage(text: string): AssistantMessage {
  return assistant([{ type: "text", text }], "stop");
}

function toolCallMessage(
  id: string,
  name: string,
  args: { [key: string]: unknown },
): AssistantMessage {
  return assistant([{ type: "toolCall", id, name, arguments: args }], "toolUse");
}

function resolved(ref: string): ResolvedModel {
  return { ref, model: FAKE_MODEL, apiKey: "key" };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const baseConfig: FusionConfig = {
  judge: "anthropic/claude-opus-4-8",
  models: ["openai/gpt-5", "anthropic/claude-opus-4-8"],
  maxToolCalls: 4,
};

describe("config validation", () => {
  it("rejects non-object config", () => {
    expect(() => validateFusionConfig([])).toThrow(/must be a JSON object/);
  });

  it("rejects missing judge", () => {
    expect(() => validateFusionConfig({ models: ["a/b"] })).toThrow(/judge/);
  });

  it("rejects empty panel", () => {
    expect(() => validateFusionConfig({ judge: "a/b", models: [] })).toThrow(/non-empty/);
  });

  it("rejects too-large panel", () => {
    const models = Array.from({ length: 9 }, (_, i) => `p/m${i}`);
    expect(() => validateFusionConfig({ judge: "a/b", models })).toThrow(/at most 8/);
  });

  it("rejects duplicate panel models", () => {
    expect(() => validateFusionConfig({ judge: "a/b", models: ["c/d", "c/d"] })).toThrow(
      /duplicates/,
    );
  });

  it("rejects an invalid model ref", () => {
    expect(() => validateFusionConfig({ judge: "noslash", models: ["a/b"] })).toThrow(
      /provider\/model/,
    );
  });

  it("defaults maxToolCalls and maxBinaryQuestions when omitted", () => {
    const config = validateFusionConfig({ judge: "a/b", models: ["c/d"] });
    expect(config.maxToolCalls).toBe(8);
    expect(config.maxBinaryQuestions).toBe(15);
  });

  it.each([0, -1, 1.5, 65])("rejects invalid maxBinaryQuestions %s", (maxBinaryQuestions) => {
    expect(() =>
      validateFusionConfig({ judge: "a/b", models: ["c/d"], maxBinaryQuestions }),
    ).toThrow(/maxBinaryQuestions/);
  });

  it("accepts valid maxBinaryQuestions", () => {
    const config = validateFusionConfig({
      judge: "a/b",
      models: ["c/d"],
      maxBinaryQuestions: 10,
    });
    expect(config.maxBinaryQuestions).toBe(10);
  });

  it("rejects an unknown reasoning effort", () => {
    expect(() =>
      validateFusionConfig({
        judge: "a/b",
        models: ["c/d"],
        reasoning: { effort: "extreme" },
      }),
    ).toThrow(/reasoning.effort/);
  });

  it("validates optional debug log paths", () => {
    const config = validateFusionConfig({
      judge: "a/b",
      models: ["c/d"],
      debugLogPath: "/tmp/fusion-debug.jsonl",
    });
    expect(config.debugLogPath).toBe("/tmp/fusion-debug.jsonl");
    expect(() => validateFusionConfig({ judge: "a/b", models: ["c/d"], debugLogPath: 42 })).toThrow(
      /debugLogPath/,
    );
  });

  it("rejects unknown config fields", () => {
    expect(() => validateFusionConfig({ judge: "a/b", models: ["c/d"], bogus: true })).toThrow(
      /unknown field: bogus/,
    );
    expect(() =>
      validateFusionConfig({ judge: "a/b", models: ["c/d"], webSearch: { type: "fast" } }),
    ).toThrow(/webSearch.*unknown field: type/);
    expect(() =>
      validateFusionConfig({ judge: "a/b", models: ["c/d"], webfetch: { mode: "probe" } }),
    ).toThrow(/webfetch.*unknown field: mode/);
  });

  it("rejects malformed web policy objects", () => {
    expect(() => validateFusionConfig({ judge: "a/b", models: ["c/d"], webSearch: [] })).toThrow(
      /webSearch must be a JSON object/,
    );
    expect(() =>
      validateFusionConfig({ judge: "a/b", models: ["c/d"], webfetch: "smart" }),
    ).toThrow(/webfetch must be a JSON object/);
  });

  it("validates web search policy fields", () => {
    const config = validateFusionConfig({
      judge: "a/b",
      models: ["c/d"],
      webSearch: { numResults: 3, textMaxCharacters: 500, excludedDomains: ["example.com"] },
    });
    expect(config.webSearch).toEqual({
      numResults: 3,
      textMaxCharacters: 500,
      excludedDomains: ["example.com"],
    });
    expect(() =>
      validateFusionConfig({ judge: "a/b", models: ["c/d"], webSearch: { numResults: 0 } }),
    ).toThrow(/webSearch\.numResults/);
    expect(() =>
      validateFusionConfig({
        judge: "a/b",
        models: ["c/d"],
        webSearch: { textMaxCharacters: 100 },
      }),
    ).toThrow(/webSearch\.textMaxCharacters/);
    expect(() =>
      validateFusionConfig({
        judge: "a/b",
        models: ["c/d"],
        webSearch: { excludedDomains: [""] },
      }),
    ).toThrow(/webSearch\.excludedDomains/);
  });

  it("validates webfetch policy fields", () => {
    const config = validateFusionConfig({
      judge: "a/b",
      models: ["c/d"],
      webfetch: { strategy: "smart", maxChars: 30000, blockedDomains: ["localhost"] },
    });
    expect(config.webfetch).toEqual({
      strategy: "smart",
      maxChars: 30000,
      blockedDomains: ["localhost"],
    });
    expect(() =>
      validateFusionConfig({ judge: "a/b", models: ["c/d"], webfetch: { strategy: "auto" } }),
    ).toThrow(/webfetch\.strategy/);
    expect(() =>
      validateFusionConfig({ judge: "a/b", models: ["c/d"], webfetch: { maxChars: 999 } }),
    ).toThrow(/webfetch\.maxChars/);
    expect(() =>
      validateFusionConfig({ judge: "a/b", models: ["c/d"], webfetch: { blockedDomains: [1] } }),
    ).toThrow(/webfetch\.blockedDomains/);
  });

  it("loads and validates from a file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fusion-config-"));
    const path = join(dir, "fusion.json");
    await writeFile(path, JSON.stringify(baseConfig));
    try {
      const config = await loadFusionConfig(path);
      expect(config.judge).toBe(baseConfig.judge);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws a clear error for a missing config file", async () => {
    await expect(loadFusionConfig("/no/such/fusion.json")).rejects.toThrow(/Could not read/);
  });

  it("throws a clear error for invalid JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fusion-config-"));
    const path = join(dir, "fusion.json");
    await writeFile(path, "{ not json");
    try {
      await expect(loadFusionConfig(path)).rejects.toThrow(/Invalid Fusion config JSON/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("debug logging", () => {
  it("writes structured JSONL entries without raw prompt or response content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fusion-log-"));
    const path = join(dir, "debug.jsonl");
    try {
      const logger = createFusionDebugLogger(path, "run-1");
      logger.log("command-started", { promptChars: 12, model: "a/b" });
      logger.log("result", { confidence: "high", status: "ok" });
      await logger.flush();

      const lines = (await readFile(path, "utf8")).trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0])).toMatchObject({
        runId: "run-1",
        sequence: 0,
        event: "command-started",
        promptChars: 12,
      });
      expect(lines.join("\n")).not.toContain("the raw prompt");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("model ref parsing", () => {
  it("splits on the first slash so OpenRouter ids keep their slashes", () => {
    expect(parseModelRef("openrouter/deepseek/deepseek-v4-pro")).toEqual({
      provider: "openrouter",
      modelId: "deepseek/deepseek-v4-pro",
    });
  });

  it("rejects refs without a provider or model", () => {
    expect(() => parseModelRef("noslash")).toThrow();
    expect(() => parseModelRef("trailing/")).toThrow();
    expect(() => parseModelRef("/leading")).toThrow();
  });
});

describe("model resolution", () => {
  function registry(overrides: Partial<ModelRegistryLike>): ModelRegistryLike {
    return {
      find: () => FAKE_MODEL,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "api-key" }),
      ...overrides,
    };
  }

  it("throws when the model is not found", async () => {
    await expect(resolveModelRef(registry({ find: () => undefined }), "a/b")).rejects.toThrow(
      /not found/,
    );
  });

  it("resolves an API-key-backed model", async () => {
    const result = await resolveModelRef(registry({}), "openai/gpt-5");
    expect(result.apiKey).toBe("api-key");
  });

  it("resolves an OAuth/subscription token returned as the api key", async () => {
    const result = await resolveModelRef(
      registry({
        getApiKeyAndHeaders: async () => ({
          ok: true,
          apiKey: "sk-ant-oat-token",
        }),
        isUsingOAuth: () => true,
      }),
      "anthropic/claude-opus-4-8",
    );
    expect(result.apiKey).toBe("sk-ant-oat-token");
  });

  it("reports a subscription-specific hint when an OAuth token is unavailable", async () => {
    await expect(
      resolveModelRef(
        registry({
          getApiKeyAndHeaders: async () => ({ ok: true }),
          isUsingOAuth: () => true,
        }),
        "anthropic/claude-opus-4-8",
      ),
    ).rejects.toThrow(/OAuth\/subscription/);
  });
});

describe("bounded tool loop", () => {
  function client(responses: AssistantMessage[]): CompletionClient {
    let call = 0;
    return {
      complete: async () => responses[Math.min(call++, responses.length - 1)],
    };
  }

  function echoTool(): FusionTool {
    return {
      name: "web_search",
      description: "echo",
      parameters: {},
      execute: async (toolCall) => ({
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: "tool ran" }],
        isError: false,
        timestamp: Date.now(),
      }),
    };
  }

  it("returns text when the model makes no tool calls", async () => {
    const result = await completeWithTools({
      model: resolved("a/b"),
      systemPrompt: "s",
      userPrompt: "u",
      tools: [echoTool()],
      maxToolCalls: 4,
      signal: new AbortController().signal,
      client: client([textMessage("final answer")]),
    });
    expect(result.content).toBe("final answer");
    expect(result.toolCalls).toHaveLength(0);
  });

  it("executes an allowed tool then returns the follow-up answer", async () => {
    const result = await completeWithTools({
      model: resolved("a/b"),
      systemPrompt: "s",
      userPrompt: "u",
      tools: [echoTool()],
      maxToolCalls: 4,
      signal: new AbortController().signal,
      client: client([toolCallMessage("c1", "web_search", { query: "x" }), textMessage("done")]),
    });
    expect(result.content).toBe("done");
    expect(result.toolCalls).toEqual([{ name: "web_search", ok: true }]);
  });

  it("rejects empty model responses instead of treating them as success", async () => {
    await expect(
      completeWithTools({
        model: resolved("a/b"),
        systemPrompt: "s",
        userPrompt: "u",
        tools: [echoTool()],
        maxToolCalls: 4,
        signal: new AbortController().signal,
        client: client([textMessage("")]),
      }),
    ).rejects.toThrow(/Empty response/);
  });

  it("includes provider error diagnostics for errored assistant messages", async () => {
    const message = textMessage("");
    message.stopReason = "error";
    message.errorMessage = "provider said no";
    message.diagnostics = [
      {
        type: "provider_transport_failure",
        timestamp: 1,
        error: { name: "Error", message: "socket closed", code: "ECONNRESET" },
      },
    ];

    await expect(
      completeWithTools({
        model: resolved("a/b"),
        systemPrompt: "s",
        userPrompt: "u",
        tools: [echoTool()],
        maxToolCalls: 4,
        signal: new AbortController().signal,
        client: client([message]),
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("provider said no"),
      details: expect.objectContaining({ diagnostics: message.diagnostics }),
    });
  });

  it("does not execute a tool that is not on the allowlist", async () => {
    const forbidden = vi.fn();
    const result = await completeWithTools({
      model: resolved("a/b"),
      systemPrompt: "s",
      userPrompt: "u",
      tools: [echoTool()],
      maxToolCalls: 4,
      signal: new AbortController().signal,
      client: client([
        toolCallMessage("c1", "read_file", { path: "/etc/passwd" }),
        textMessage("x"),
      ]),
    });
    expect(forbidden).not.toHaveBeenCalled();
    expect(result.toolCalls).toEqual([{ name: "read_file", ok: false }]);
  });

  it("injects a budget error and allows a final answer when tool budget is exhausted", async () => {
    const tool = echoTool();
    const execute = vi.spyOn(tool, "execute");
    const seenToolCounts: number[] = [];
    const seenMessages: Message[][] = [];
    const client: CompletionClient = {
      complete: async (args) => {
        seenToolCounts.push(args.tools.length);
        seenMessages.push([...args.messages]);
        if (seenToolCounts.length === 1) {
          return toolCallMessage("c1", "web_search", { query: "x" });
        }
        return textMessage("final from partial context");
      },
    };

    const result = await completeWithTools({
      model: resolved("a/b"),
      systemPrompt: "s",
      userPrompt: "u",
      tools: [tool],
      maxToolCalls: 0,
      signal: new AbortController().signal,
      client,
    });

    expect(result.content).toBe("final from partial context");
    expect(result.toolCalls).toEqual([{ name: "web_search", ok: false }]);
    expect(execute).not.toHaveBeenCalled();
    expect(seenToolCounts).toEqual([1, 0]);
    expect(JSON.stringify(seenMessages[1])).toContain("Tool-call budget exceeded");
  });
});

describe("prompt builders", () => {
  it("panel prompt contains only the command args, no session context", () => {
    expect(buildPanelPrompt("compare X and Y")).toBe("compare X and Y");
    expect(PANEL_SYSTEM_PROMPT).toMatch(/Do not assume access to prior conversation/i);
  });

  it("meta prompt includes the task, cap, and JSON shape", () => {
    const prompt = buildMetaPrompt("the task", 7);
    expect(prompt).toContain("the task");
    expect(prompt).toContain("at most 7");
    expect(prompt).toContain("dimensions");
  });

  it("parses meta-prompt output defensively and enforces the question cap", () => {
    expect(
      parseMetaPromptOutput(
        '{"dimensions":[{"name":"Quality","questions":["OK?","Complete?"]}]}',
        1,
      ),
    ).toEqual([{ name: "Quality", questions: ["OK?"] }]);
    expect(parseMetaPromptOutput("not json")).toEqual([]);
  });

  it("computes confidence from pass rates", () => {
    expect(computeConfidence({ a: { Quality: [true, true, true, false] } })).toBe("medium");
    expect(computeConfidence({ a: { Quality: [true, true, true, true, false] } })).toBe("medium");
    expect(computeConfidence({ a: { Quality: [true, true, true, true, true, false] } })).toBe(
      "high",
    );
    expect(computeConfidence({ a: { Quality: [true, true, true, true, true] } })).toBe("high");
    expect(computeConfidence({ a: { Quality: [true, false, false] } })).toBe("low");
    expect(computeConfidence({})).toBe("low");
  });

  it("judge prompt includes the task, questions, panel responses, and failed models", () => {
    const prompt = buildJudgePrompt({
      prompt: "the task",
      questions: [{ name: "Quality", questions: ["Is it correct?"] }],
      responses: [
        {
          model: "openai/gpt-5",
          runId: "1",
          status: "ok",
          content: "panel says hello",
          elapsedMs: 1,
          toolCalls: [],
        },
        {
          model: "anthropic/claude-opus-4-8",
          runId: "2",
          status: "error",
          error: "rate limited",
          elapsedMs: 1,
        },
      ],
    });
    expect(prompt).toContain("the task");
    expect(prompt).toContain("Is it correct?");
    expect(prompt).toContain("panel says hello");
    expect(prompt).toContain("anthropic/claude-opus-4-8: rate limited");
    expect(JUDGE_SYSTEM_PROMPT).not.toContain("finalAnswer");
    expect(JUDGE_SYSTEM_PROMPT).toContain("calling model");
    expect(JUDGE_SYSTEM_PROMPT).toContain("panelScores");
    expect(JUDGE_SYSTEM_PROMPT).toContain('"contradictions": ["..."]');
    expect(JUDGE_SYSTEM_PROMPT).not.toContain('"confidence"');
  });
});

describe("orchestrator", () => {
  const metaJson = JSON.stringify({
    dimensions: [{ name: "Quality", questions: ["Is it correct?", "Is it complete?"] }],
  });
  const judgeJson = JSON.stringify({
    questions: [{ name: "Quality", questions: ["Is it correct?", "Is it complete?"] }],
    panelScores: {
      "openai/gpt-5": { Quality: [true, true] },
      "anthropic/claude-opus-4-8": { Quality: [true, true] },
    },
    analysis: {
      consensus: ["both agree"],
      contradictions: [],
      partialCoverage: [],
      uniqueInsights: [],
      blindSpots: [],
      sourceQuality: [],
      risks: [],
    },
  });

  function registry(): ModelRegistryLike {
    return {
      find: () => FAKE_MODEL,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }),
    };
  }

  function scriptedClient(handler: (systemPrompt: string, userPrompt: string) => string) {
    const judgeInputs: string[] = [];
    const client: CompletionClient = {
      complete: async (args) => {
        const userPrompt = args.messages[0]?.content as string;
        if (args.systemPrompt === JUDGE_SYSTEM_PROMPT && !userPrompt.includes("Decompose")) {
          const userText = args.messages
            .map((m) => (typeof m.content === "string" ? m.content : ""))
            .join("");
          judgeInputs.push(userText);
        }
        return textMessage(handler(args.systemPrompt, userPrompt));
      },
    };
    return { client, judgeInputs };
  }

  it("runs all panels, invokes the judge, and parses the judge output", async () => {
    const { client, judgeInputs } = scriptedClient((systemPrompt, userPrompt) => {
      if (userPrompt.includes("Decompose")) return metaJson;
      return systemPrompt === JUDGE_SYSTEM_PROMPT ? judgeJson : "panel response";
    });

    const result = await runFusion({
      prompt: "task",
      config: baseConfig,
      registry: registry(),
      signal: new AbortController().signal,
      client,
    });

    expect(result.status).toBe("ok");
    expect(result.confidence).toBe("high");
    expect(result.judgeOutput?.questions[0]?.name).toBe("Quality");
    expect(result.judgeOutput?.panelScores["openai/gpt-5"]?.Quality).toEqual([true, true]);
    expect(result.judgeOutput?.analysis.consensus).toContain("both agree");
    expect(result.responses).toHaveLength(2);
    expect(judgeInputs[0]).toContain("panel response");
    expect(judgeInputs[0]).toContain("Is it correct?");
  });

  it("degrades but still judges when one panel model fails", async () => {
    let panelCalls = 0;
    const client: CompletionClient = {
      complete: async (args) => {
        const userPrompt = args.messages[0]?.content as string;
        if (userPrompt.includes("Decompose")) return textMessage(metaJson);
        if (args.systemPrompt === JUDGE_SYSTEM_PROMPT) return textMessage(judgeJson);
        panelCalls += 1;
        if (panelCalls === 1) throw new Error("provider down");
        return textMessage("survivor response");
      },
    };

    const result = await runFusion({
      prompt: "task",
      config: baseConfig,
      registry: registry(),
      signal: new AbortController().signal,
      client,
    });

    expect(result.status).toBe("degraded");
    expect(result.confidence).toBe("high");
    expect(result.responses.some((r) => r.status === "error")).toBe(true);
  });

  it("fails without calling the judge when every panel model fails", async () => {
    const judge = vi.fn();
    const client: CompletionClient = {
      complete: async (args) => {
        const userPrompt = args.messages[0]?.content as string;
        if (userPrompt.includes("Decompose")) return textMessage(metaJson);
        if (args.systemPrompt === JUDGE_SYSTEM_PROMPT) {
          judge();
          return textMessage(judgeJson);
        }
        throw new Error("all down");
      },
    };

    const result = await runFusion({
      prompt: "task",
      config: baseConfig,
      registry: registry(),
      signal: new AbortController().signal,
      client,
    });

    expect(result.status).toBe("error");
    expect(result.error).toMatch(/all Fusion panel models failed/i);
    expect(judge).not.toHaveBeenCalled();
  });

  it("preserves successful panel responses when judge synthesis fails", async () => {
    const events: FusionProgressEvent[] = [];
    const client: CompletionClient = {
      complete: async (args) => {
        const userPrompt = args.messages[0]?.content as string;
        if (userPrompt.includes("Decompose")) return textMessage(metaJson);
        if (args.systemPrompt === JUDGE_SYSTEM_PROMPT) throw new Error("judge down");
        return textMessage(`panel response from ${args.model.ref}`);
      },
    };

    const result = await runFusion({
      prompt: "task",
      config: baseConfig,
      registry: registry(),
      signal: new AbortController().signal,
      client,
      onProgress: (event) => events.push(event),
    });

    expect(result.status).toBe("error");
    expect(result.error).toMatch(/Fusion judge failed/);
    expect(result.error).toContain("2/2 panel responses succeeded");
    expect(result.responses).toHaveLength(2);
    expect(result.responses.every((response) => response.status === "ok")).toBe(true);
    expect(result.judgeOutput).toBeUndefined();
    expect(events).toContainEqual(
      expect.objectContaining({ phase: "judge-failed", error: "judge down" }),
    );
  });

  it("does not give the meta-prompt a tool-call budget", async () => {
    const metaToolBudgets: number[] = [];
    const client: CompletionClient = {
      complete: async (args) => {
        const userPrompt = args.messages[0]?.content as string;
        if (userPrompt.includes("Decompose")) {
          metaToolBudgets.push(args.tools.length);
          return textMessage(metaJson);
        }
        if (args.systemPrompt === JUDGE_SYSTEM_PROMPT) return textMessage(judgeJson);
        return textMessage("panel response");
      },
    };

    await runFusion({
      prompt: "task",
      config: baseConfig,
      registry: registry(),
      signal: new AbortController().signal,
      client,
    });

    expect(metaToolBudgets[0]).toBe(0);
  });

  it("runs the meta-prompt concurrently with panel models", async () => {
    const calls: string[] = [];
    const meta = deferred<AssistantMessage>();
    const panel = deferred<AssistantMessage>();
    const client: CompletionClient = {
      complete: async (args) => {
        const userPrompt = args.messages[0]?.content as string;
        if (userPrompt.includes("Decompose")) {
          calls.push("meta-started");
          return meta.promise;
        }
        if (args.systemPrompt === JUDGE_SYSTEM_PROMPT) return textMessage(judgeJson);
        calls.push("panel-started");
        return panel.promise;
      },
    };

    const run = runFusion({
      prompt: "task",
      config: baseConfig,
      registry: registry(),
      signal: new AbortController().signal,
      client,
    });

    await vi.waitFor(() => expect(calls).toContain("panel-started"));
    expect(calls).toContain("meta-started");
    meta.resolve(textMessage(metaJson));
    panel.resolve(textMessage("panel response"));
    await run;
  });

  it("falls back to empty questions and emits progress when the meta-prompt fails", async () => {
    const events: FusionProgressEvent[] = [];
    const client: CompletionClient = {
      complete: async (args) => {
        const userPrompt = args.messages[0]?.content as string;
        if (userPrompt.includes("Decompose")) throw new Error("meta down");
        if (args.systemPrompt === JUDGE_SYSTEM_PROMPT) {
          return textMessage(JSON.stringify({ analysis: {}, panelScores: {} }));
        }
        return textMessage("panel response");
      },
    };

    const result = await runFusion({
      prompt: "task",
      config: baseConfig,
      registry: registry(),
      signal: new AbortController().signal,
      client,
      onProgress: (event) => events.push(event),
    });

    expect(result.status).toBe("ok");
    expect(result.judgeOutput?.questions).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({ phase: "meta-failed", error: "meta down" }),
    );
  });

  it("logs a meta-prompt fallback when generated questions are empty", async () => {
    const events: FusionProgressEvent[] = [];
    const client: CompletionClient = {
      complete: async (args) => {
        const userPrompt = args.messages[0]?.content as string;
        if (userPrompt.includes("Decompose")) return textMessage('{"dimensions":[]}');
        if (args.systemPrompt === JUDGE_SYSTEM_PROMPT) {
          return textMessage(JSON.stringify({ analysis: {}, panelScores: {} }));
        }
        return textMessage("panel response");
      },
    };

    const result = await runFusion({
      prompt: "task",
      config: baseConfig,
      registry: registry(),
      signal: new AbortController().signal,
      client,
      onProgress: (event) => events.push(event),
    });

    expect(result.status).toBe("ok");
    expect(result.judgeOutput?.questions).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({
        phase: "meta-failed",
        error: "meta-prompt returned no binary questions",
      }),
    );
  });

  it("parses malformed judge panelScores defensively", () => {
    const output = parseJudgeOutput(JSON.stringify({ analysis: {}, panelScores: [] }));
    expect(output.panelScores).toEqual({});
  });

  it("filters and canonicalizes judge panelScores to real models and dimensions", () => {
    const output = parseJudgeOutput(
      JSON.stringify({
        analysis: {},
        panelScores: {
          "openai/gpt-5": { code_quality: [true, null, false], Bogus: [true] },
          "anthropic/claude-opus-4-8": { Bogus: [true] },
          "unknown/model": { "Code Quality": [true] },
        },
      }),
      [{ name: "Code Quality", questions: ["A?", "B?", "C?"] }],
      ["openai/gpt-5", "anthropic/claude-opus-4-8"],
    );
    expect(output.panelScores).toEqual({
      "openai/gpt-5": { "Code Quality": [true, false, false] },
    });
  });

  it("parses judge analysis as flat string arrays", () => {
    const output = parseJudgeOutput(
      JSON.stringify({
        panelScores: {},
        analysis: {
          consensus: ["shared fix", { claim: "object should be dropped" }],
          contradictions: ["different APIs proposed"],
          partialCoverage: ["tests missing", 42],
          uniqueInsights: ["one panel noted migration risk"],
          blindSpots: ["no rollback plan"],
          sourceQuality: ["official docs cited"],
          risks: ["broad rewrite risk"],
        },
      }),
    );

    expect(output.analysis).toEqual({
      consensus: ["shared fix"],
      contradictions: ["different APIs proposed"],
      partialCoverage: ["tests missing"],
      uniqueInsights: ["one panel noted migration risk"],
      blindSpots: ["no rollback plan"],
      sourceQuality: ["official docs cited"],
      risks: ["broad rewrite risk"],
    });
  });

  it("reports progress for model resolution, panel runs, and judge synthesis", async () => {
    const events: FusionProgressEvent[] = [];
    const { client } = scriptedClient((systemPrompt, userPrompt) => {
      if (userPrompt.includes("Decompose")) return metaJson;
      return systemPrompt === JUDGE_SYSTEM_PROMPT ? judgeJson : "panel response";
    });

    await runFusion({
      prompt: "task",
      config: baseConfig,
      registry: registry(),
      signal: new AbortController().signal,
      client,
      onProgress: (event) => events.push(event),
    });

    expect(events[0]).toMatchObject({ phase: "resolving-models" });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "panel-started",
          model: "openai/gpt-5",
        }),
        expect.objectContaining({
          phase: "panel-started",
          model: "anthropic/claude-opus-4-8",
        }),
        expect.objectContaining({
          phase: "panel-finished",
          model: "openai/gpt-5",
          status: "ok",
        }),
        expect.objectContaining({
          phase: "judge-started",
          model: baseConfig.judge,
        }),
        expect.objectContaining({
          phase: "judge-finished",
          model: baseConfig.judge,
          confidence: "high",
        }),
      ]),
    );
  });
});

describe("panel message rendering", () => {
  const result = {
    status: "ok" as const,
    prompt: "task",
    judge: "anthropic/claude-opus-4-8",
    elapsedMs: 1234,
    responses: [
      {
        model: "openai/gpt-5",
        runId: "1",
        status: "ok" as const,
        content: "panel content",
        elapsedMs: 10,
        toolCalls: [],
      },
    ],
    confidence: "medium" as const,
    judgeOutput: {
      questions: [{ name: "Quality", questions: ["Is it correct?", "Is it complete?"] }],
      panelScores: { "openai/gpt-5": { Quality: [true, false] } },
      analysis: {
        consensus: ["both agree"],
        contradictions: ["models disagree on API shape"],
        partialCoverage: ["only one panel covered tests"],
        uniqueInsights: ["migration risk from openai/gpt-5"],
        blindSpots: ["no rollout plan"],
        sourceQuality: ["official docs cited"],
        risks: ["breaking config migration"],
      },
    },
  };

  it("carries the synthesis prompt as content for the calling model", () => {
    const message = toFusionPanelMessage(result);
    expect(message.customType).toBe("fusion-panel");
    expect(message.display).toBe(true);
    expect(message.content).toContain("You are the calling model");
    expect(message.content).toContain("task");
    expect(message.content).toContain("panel content");
    expect(message.details.judge).toBe("anthropic/claude-opus-4-8");
    expect(message.details.models).toEqual(["openai/gpt-5"]);
  });

  it("renders a compact panel card collapsed and details when expanded", () => {
    const message = toFusionPanelMessage(result);

    const collapsed = renderFusionPanelMarkdown(message.details, false);
    expect(collapsed).toContain("Fusion panel");
    expect(collapsed).toContain("confidence medium");
    expect(collapsed).not.toContain("You are the calling model");

    const expanded = renderFusionPanelMarkdown(message.details, true);
    expect(expanded).toContain("anthropic/claude-opus-4-8");
    expect(expanded).toContain("openai/gpt-5");
    expect(expanded).toContain("both agree");
    expect(expanded).toContain("models disagree on API shape");
    expect(expanded).toContain("only one panel covered tests");
    expect(expanded).toContain("migration risk from openai/gpt-5");
    expect(expanded).toContain("no rollout plan");
    expect(expanded).toContain("official docs cited");
    expect(expanded).toContain("breaking config migration");
    expect(expanded).toContain("Quality: 2 questions");
    expect(expanded).toContain("openai/gpt-5");
    expect(expanded).toContain("Quality: 1/2");
    expect(expanded).toContain("Confidence: medium (50% questions passed across panels)");
  });

  it("omits binary scores when questions are empty and keeps collapsed output unchanged", () => {
    const message = toFusionPanelMessage({
      ...result,
      judgeOutput: { ...result.judgeOutput, questions: [] },
    });
    expect(renderFusionPanelMarkdown(message.details, false)).not.toContain("Binary questions");
    expect(renderFusionPanelMarkdown(message.details, true)).not.toContain("Binary questions");
  });

  it("omits binary scores when panelScores are missing", () => {
    const message = toFusionPanelMessage(result);
    expect(
      renderFusionPanelMarkdown({ ...message.details, panelScores: undefined }, true),
    ).not.toContain("Binary questions");
  });

  it("handles mismatched binary score lengths without throwing or miscounting", () => {
    const message = toFusionPanelMessage({
      ...result,
      judgeOutput: {
        ...result.judgeOutput,
        panelScores: { "openai/gpt-5": { Quality: [true, true, false] } },
      },
    });
    const rendered = renderFusionPanelMarkdown(message.details, true);
    expect(rendered).toContain("Quality: 2/3");
  });

  it("carries judge failure details while preserving panel content for recovery", () => {
    const message = toFusionPanelMessage({
      ...result,
      status: "error",
      judgeOutput: undefined,
      confidence: undefined,
      error: "Fusion judge failed after 1/1 panel responses succeeded: judge down",
    });

    expect(message.content).toContain("Fusion recovery notice");
    expect(message.content).toContain("panel content");
    expect(message.content).toContain("judge down");
    expect(message.content.match(/Fusion judge failed after/g)).toHaveLength(1);
    expect(message.details.error).toContain("judge down");

    const collapsed = renderFusionPanelMarkdown(message.details, false);
    expect(collapsed).toContain("judge failed");

    const expanded = renderFusionPanelMarkdown(message.details, true);
    expect(expanded).toContain("Fusion judge failed");
    expect(expanded).toContain("openai/gpt-5");
  });
});

describe("progress reducer", () => {
  it("starts in loading-config and seeds panels on resolving-models", () => {
    const empty = createProgressState();
    expect(empty.phase).toBe("loading config");
    expect(empty.panels.size).toBe(0);

    const seeded = reduceProgress(empty, {
      phase: "resolving-models",
      models: baseConfig.models,
      judge: baseConfig.judge,
    });
    expect(seeded.phase).toBe("resolving models");
    expect([...seeded.panels.keys()]).toEqual(baseConfig.models);
    expect(seeded.judge).toBe(baseConfig.judge);
  });

  it("holds before judge-started until the last panel and meta-prompt finish", () => {
    let state = createProgressState(baseConfig);
    state = reduceProgress(state, {
      phase: "panel-started",
      model: "openai/gpt-5",
      panelRunId: "a",
    });
    expect(state.phase).toBe("running panel");

    state = reduceProgress(state, {
      phase: "panel-finished",
      model: "openai/gpt-5",
      panelRunId: "a",
      status: "ok",
      elapsedMs: 1,
    });
    expect(state.phase).toBe("running panel");

    state = reduceProgress(state, {
      phase: "panel-finished",
      model: "anthropic/claude-opus-4-8",
      panelRunId: "b",
      status: "error",
      elapsedMs: 1,
    });
    expect(state.phase).toBe("waiting for judge");
  });

  it("marks the judge running then complete", () => {
    let state = createProgressState(baseConfig);
    state = reduceProgress(state, { phase: "judge-started", model: baseConfig.judge });
    expect(state.judgeStatus).toBe("running");

    state = reduceProgress(state, {
      phase: "judge-finished",
      model: baseConfig.judge,
      elapsedMs: 1,
      confidence: "high",
    });
    expect(state.phase).toBe("complete");
    expect(state.judgeStatus).toBe("ok");
  });

  it("marks judge failures without clearing panel progress", () => {
    let state = createProgressState(baseConfig);
    state = reduceProgress(state, {
      phase: "panel-finished",
      model: "openai/gpt-5",
      panelRunId: "a",
      status: "ok",
      elapsedMs: 1,
    });
    state = reduceProgress(state, {
      phase: "judge-failed",
      model: baseConfig.judge,
      elapsedMs: 1,
      error: "judge down",
    });

    expect(state.phase).toBe("judge failed");
    expect(state.judgeStatus).toBe("error");
    expect(state.panels.get("openai/gpt-5")).toBe("ok");
  });

  it("does not mutate the input state", () => {
    const state = createProgressState(baseConfig);
    const next = reduceProgress(state, {
      phase: "panel-started",
      model: "openai/gpt-5",
      panelRunId: "a",
    });
    expect(state.panels.get("openai/gpt-5")).toBe("pending");
    expect(next.panels.get("openai/gpt-5")).toBe("running");
    expect(next).not.toBe(state);
  });

  it("renders panel icons, completion count, and the judge line", () => {
    let state = createProgressState(baseConfig);
    state = reduceProgress(state, {
      phase: "panel-finished",
      model: "openai/gpt-5",
      panelRunId: "a",
      status: "ok",
      elapsedMs: 1,
    });
    state = reduceProgress(state, {
      phase: "panel-finished",
      model: "anthropic/claude-opus-4-8",
      panelRunId: "b",
      status: "error",
      elapsedMs: 1,
    });

    const text = formatProgress(state);
    expect(text).toContain("Panel: 2/2 complete");
    expect(text).toContain("✓ openai/gpt-5");
    expect(text).toContain("✗ anthropic/claude-opus-4-8");
    expect(text).toContain(`Judge: • ${baseConfig.judge}`);
  });
});
