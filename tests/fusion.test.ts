import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AssistantMessage, Api, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  loadFusionConfig,
  validateFusionConfig,
} from "../pi-extensions/fusion/config.js";
import { createFusionDebugLogger } from "../pi-extensions/fusion/debug-log.js";
import {
  parseModelRef,
  resolveModelRef,
} from "../pi-extensions/fusion/model-ref.js";
import { completeWithTools } from "../pi-extensions/fusion/model-runner.js";
import { runFusion } from "../pi-extensions/fusion/orchestrator.js";
import {
  buildJudgePrompt,
  buildPanelPrompt,
  JUDGE_SYSTEM_PROMPT,
  PANEL_SYSTEM_PROMPT,
} from "../pi-extensions/fusion/prompts.js";
import {
  renderFusionPanelMarkdown,
  toFusionPanelMessage,
} from "../pi-extensions/fusion/render.js";
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
  args: Record<string, unknown>,
): AssistantMessage {
  return assistant(
    [{ type: "toolCall", id, name, arguments: args }],
    "toolUse",
  );
}

function resolved(ref: string): ResolvedModel {
  return { ref, model: FAKE_MODEL, apiKey: "key" };
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
    expect(() => validateFusionConfig({ judge: "a/b", models: [] })).toThrow(
      /non-empty/,
    );
  });

  it("rejects too-large panel", () => {
    const models = Array.from({ length: 9 }, (_, i) => `p/m${i}`);
    expect(() => validateFusionConfig({ judge: "a/b", models })).toThrow(
      /at most 8/,
    );
  });

  it("rejects an invalid model ref", () => {
    expect(() =>
      validateFusionConfig({ judge: "noslash", models: ["a/b"] }),
    ).toThrow(/provider\/model/);
  });

  it("defaults maxToolCalls when omitted", () => {
    const config = validateFusionConfig({ judge: "a/b", models: ["c/d"] });
    expect(config.maxToolCalls).toBe(8);
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
    expect(() =>
      validateFusionConfig({ judge: "a/b", models: ["c/d"], debugLogPath: 42 }),
    ).toThrow(/debugLogPath/);
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
    await expect(loadFusionConfig("/no/such/fusion.json")).rejects.toThrow(
      /Could not read/,
    );
  });

  it("throws a clear error for invalid JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fusion-config-"));
    const path = join(dir, "fusion.json");
    await writeFile(path, "{ not json");
    try {
      await expect(loadFusionConfig(path)).rejects.toThrow(
        /Invalid Fusion config JSON/,
      );
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
    await expect(
      resolveModelRef(registry({ find: () => undefined }), "a/b"),
    ).rejects.toThrow(/not found/);
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
      client: client([
        toolCallMessage("c1", "web_search", { query: "x" }),
        textMessage("done"),
      ]),
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

  it("fails instead of looping when the tool budget is exhausted", async () => {
    const tool = echoTool();
    const execute = vi.spyOn(tool, "execute");
    let completions = 0;
    const loopingClient: CompletionClient = {
      complete: async () => {
        completions += 1;
        return toolCallMessage(`c${completions}`, "web_search", { query: "x" });
      },
    };

    await expect(
      completeWithTools({
        model: resolved("a/b"),
        systemPrompt: "s",
        userPrompt: "u",
        tools: [tool],
        maxToolCalls: 0,
        signal: new AbortController().signal,
        client: loopingClient,
      }),
    ).rejects.toThrow(/Tool-call budget exceeded/);
    expect(execute).not.toHaveBeenCalled();
    expect(completions).toBe(1);
  });
});

describe("prompt builders", () => {
  it("panel prompt contains only the command args, no session context", () => {
    expect(buildPanelPrompt("compare X and Y")).toBe("compare X and Y");
    expect(PANEL_SYSTEM_PROMPT).toMatch(
      /Do not assume access to prior conversation/i,
    );
  });

  it("judge prompt includes the task, panel responses, and failed models", () => {
    const prompt = buildJudgePrompt({
      prompt: "the task",
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
    expect(prompt).toContain("panel says hello");
    expect(prompt).toContain("anthropic/claude-opus-4-8: rate limited");
    expect(JUDGE_SYSTEM_PROMPT).not.toContain("finalAnswer");
    expect(JUDGE_SYSTEM_PROMPT).toContain("calling model");
  });
});

describe("orchestrator", () => {
  const judgeJson = JSON.stringify({
    analysis: {
      consensus: ["both agree"],
      contradictions: [],
      partialCoverage: [],
      uniqueInsights: [],
      blindSpots: [],
      sourceQuality: [],
      risks: [],
    },
    confidence: "high",
  });

  function registry(): ModelRegistryLike {
    return {
      find: () => FAKE_MODEL,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }),
    };
  }

  function scriptedClient(
    handler: (systemPrompt: string, userPrompt: string) => string,
  ) {
    const judgeInputs: string[] = [];
    const client: CompletionClient = {
      complete: async (args) => {
        if (args.systemPrompt === JUDGE_SYSTEM_PROMPT) {
          const userText = args.messages
            .map((m) => (typeof m.content === "string" ? m.content : ""))
            .join("");
          judgeInputs.push(userText);
        }
        return textMessage(
          handler(args.systemPrompt, args.messages[0]?.content as string),
        );
      },
    };
    return { client, judgeInputs };
  }

  it("runs all panels, invokes the judge, and parses the judge output", async () => {
    const { client, judgeInputs } = scriptedClient((systemPrompt) =>
      systemPrompt === JUDGE_SYSTEM_PROMPT ? judgeJson : "panel response",
    );

    const result = await runFusion({
      prompt: "task",
      config: baseConfig,
      registry: registry(),
      signal: new AbortController().signal,
      client,
    });

    expect(result.status).toBe("ok");
    expect(result.judgeOutput?.confidence).toBe("high");
    expect(result.judgeOutput?.analysis.consensus).toContain("both agree");
    expect(result.responses).toHaveLength(2);
    expect(judgeInputs[0]).toContain("panel response");
  });

  it("degrades but still judges when one panel model fails", async () => {
    let panelCalls = 0;
    const client: CompletionClient = {
      complete: async (args) => {
        if (args.systemPrompt === JUDGE_SYSTEM_PROMPT)
          return textMessage(judgeJson);
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
    expect(result.judgeOutput?.confidence).toBe("high");
    expect(result.responses.some((r) => r.status === "error")).toBe(true);
  });

  it("fails without calling the judge when every panel model fails", async () => {
    const judge = vi.fn();
    const client: CompletionClient = {
      complete: async (args) => {
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

  it("reports progress for model resolution, panel runs, and judge synthesis", async () => {
    const events: FusionProgressEvent[] = [];
    const { client } = scriptedClient((systemPrompt) =>
      systemPrompt === JUDGE_SYSTEM_PROMPT ? judgeJson : "panel response",
    );

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
    judgeOutput: {
      analysis: {
        consensus: ["both agree"],
        contradictions: [],
        partialCoverage: [],
        uniqueInsights: [],
        blindSpots: [],
        sourceQuality: [],
        risks: [],
      },
      confidence: "high" as const,
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
    expect(collapsed).toContain("confidence high");
    expect(collapsed).not.toContain("You are the calling model");

    const expanded = renderFusionPanelMarkdown(message.details, true);
    expect(expanded).toContain("anthropic/claude-opus-4-8");
    expect(expanded).toContain("openai/gpt-5");
    expect(expanded).toContain("both agree");
  });
});
