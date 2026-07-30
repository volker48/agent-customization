import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";

const model: Model<never> = {
  id: "grok-4.5",
  name: "Cursor Grok 4.5",
  api: "cursor-bridge" as never,
  provider: "cursor",
  baseUrl: "cursor-sdk://local",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
};

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cursor-extension-test-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("CURSOR_API_KEY", "test-key");
  vi.stubEnv("PI_CURSOR_TRANSPORT", "sdk");
  vi.resetModules();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  await rm(home, { recursive: true, force: true });
});

function finishedRun() {
  return {
    supports: () => true,
    cancel: vi.fn(async () => undefined),
    wait: vi.fn(async () => ({ status: "finished" as const })),
  };
}

async function loadSdkProvider(
  agent: {
    agentId: string;
    send: ReturnType<typeof vi.fn>;
    [Symbol.asyncDispose]?: () => Promise<void>;
  },
  options: { resumeError?: Error; createAgent?: () => Promise<typeof agent> } = {},
) {
  const sdk = {
    Agent: {
      create: vi.fn(options.createAgent ?? (async () => agent)),
      resume: vi.fn(async () => {
        if (options.resumeError) throw options.resumeError;
        return agent;
      }),
    },
    Cursor: {
      models: {
        list: vi.fn(async () => [{ id: model.id, displayName: model.name }]),
      },
    },
  };
  vi.doMock("@cursor/sdk", () => sdk);

  let provider: { streamSimple: Function } | undefined;
  const commands = new Map<string, { handler: Function }>();
  const { default: cursorExtension } = await import("../pi-extensions/cursor/index.js");
  await cursorExtension({
    registerProvider(id: string, config: unknown) {
      if (id === "cursor") provider = config as { streamSimple: Function };
    },
    registerCommand(name: string, command: { handler: Function }) {
      commands.set(name, command);
    },
    exec: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })),
  } as never);

  if (!provider) throw new Error("cursor provider was not registered");
  return { provider, commands, sdk };
}

function cursorAssistant(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

async function loadCliProvider(cursorAgentBin: string) {
  vi.stubEnv("PI_CURSOR_TRANSPORT", "cli");
  vi.stubEnv("CURSOR_AGENT_BIN", cursorAgentBin);
  vi.resetModules();

  let provider: { baseUrl: string; streamSimple: Function } | undefined;
  const { default: cursorExtension } = await import("../pi-extensions/cursor/index.js");
  await cursorExtension({
    registerProvider(id: string, config: unknown) {
      if (id === "cursor") {
        provider = config as { baseUrl: string; streamSimple: Function };
      }
    },
    registerCommand: vi.fn(),
    exec: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })),
  } as never);

  if (!provider) throw new Error("cursor provider was not registered");
  return provider;
}

async function collectEvents(stream: AsyncIterable<AssistantMessageEvent>) {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(structuredClone(event));
  return events;
}

describe("Cursor provider", () => {
  it("starts Grok streams in a non-error state", async () => {
    const agent = {
      agentId: "agent-1",
      send: vi.fn(async () => finishedRun()),
    };
    const { provider } = await loadSdkProvider(agent);
    const context: Context = {
      messages: [{ role: "user", content: "Reply with OK", timestamp: Date.now() }],
    };

    const events = await collectEvents(
      provider.streamSimple(model, context, { apiKey: "test-key", sessionId: "session-1" }),
    );

    expect(events[0]).toMatchObject({
      type: "start",
      partial: { stopReason: "stop" },
    });
    expect(
      (events[0] as { partial: { errorMessage?: string } }).partial.errorMessage,
    ).toBeUndefined();
  });

  it("forwards Pi system instructions on the first Cursor turn", async () => {
    const agent = {
      agentId: "agent-1",
      send: vi.fn(async () => finishedRun()),
    };
    const { provider } = await loadSdkProvider(agent);
    const context: Context = {
      systemPrompt: "Never modify generated files.",
      messages: [{ role: "user", content: "Inspect the repository", timestamp: Date.now() }],
    };

    await collectEvents(
      provider.streamSimple(model, context, { apiKey: "test-key", sessionId: "session-1" }),
    );

    expect(agent.send).toHaveBeenCalledWith(
      expect.stringContaining("Never modify generated files."),
      expect.any(Object),
    );
  });

  it("starts a new SDK conversation after cursor-reset", async () => {
    const agent = {
      agentId: "agent-1",
      send: vi.fn(async () => finishedRun()),
      [Symbol.asyncDispose]: vi.fn(async () => undefined),
    };
    const { provider, commands, sdk } = await loadSdkProvider(agent);
    const options = { apiKey: "test-key", sessionId: "session-1" };

    await collectEvents(
      provider.streamSimple(
        model,
        { messages: [{ role: "user", content: "First", timestamp: Date.now() }] },
        options,
      ),
    );
    await commands.get("cursor-reset")?.handler("", {
      cwd: process.cwd(),
      sessionManager: { getSessionId: () => "session-1" },
      ui: { notify: vi.fn() },
    });
    await collectEvents(
      provider.streamSimple(
        model,
        {
          messages: [
            { role: "user", content: "First", timestamp: Date.now() },
            cursorAssistant("Response"),
            { role: "user", content: "Second", timestamp: Date.now() },
          ],
        },
        options,
      ),
    );

    expect(sdk.Agent.resume).not.toHaveBeenCalled();
    expect(sdk.Agent.create).toHaveBeenCalledTimes(2);
  });

  it("deletes persisted SDK state when reset runs before a resumed turn", async () => {
    const firstAgent = { agentId: "agent-1", send: vi.fn(async () => finishedRun()) };
    const first = await loadSdkProvider(firstAgent);
    const streamOptions = { apiKey: "test-key", sessionId: "session-1" };
    await collectEvents(
      first.provider.streamSimple(
        model,
        { messages: [{ role: "user", content: "First", timestamp: Date.now() }] },
        streamOptions,
      ),
    );

    vi.resetModules();
    const resetAgent = { agentId: "unused", send: vi.fn(async () => finishedRun()) };
    const resetInstance = await loadSdkProvider(resetAgent);
    await resetInstance.commands.get("cursor-reset")?.handler("", {
      cwd: process.cwd(),
      sessionManager: { getSessionId: () => "session-1" },
      ui: { notify: vi.fn() },
    });

    vi.resetModules();
    const freshAgent = { agentId: "agent-2", send: vi.fn(async () => finishedRun()) };
    const fresh = await loadSdkProvider(freshAgent);
    await collectEvents(
      fresh.provider.streamSimple(
        model,
        {
          messages: [
            { role: "user", content: "First", timestamp: Date.now() },
            cursorAssistant("Earlier response"),
            { role: "user", content: "Continue", timestamp: Date.now() },
          ],
        },
        streamOptions,
      ),
    );

    expect(fresh.sdk.Agent.resume).not.toHaveBeenCalled();
    expect(fresh.sdk.Agent.create).toHaveBeenCalledOnce();
  });

  it("replays prior context when a persisted SDK conversation is stale", async () => {
    const firstAgent = {
      agentId: "agent-1",
      send: vi.fn(async () => finishedRun()),
    };
    const first = await loadSdkProvider(firstAgent);
    const streamOptions = { apiKey: "test-key", sessionId: "session-1" };
    await collectEvents(
      first.provider.streamSimple(
        model,
        { messages: [{ role: "user", content: "First", timestamp: Date.now() }] },
        streamOptions,
      ),
    );

    vi.resetModules();
    const replacementAgent = {
      agentId: "agent-2",
      send: vi.fn(async () => finishedRun()),
    };
    const replacement = await loadSdkProvider(replacementAgent, {
      resumeError: new Error("stale agent"),
    });
    await collectEvents(
      replacement.provider.streamSimple(
        model,
        {
          messages: [
            { role: "user", content: "First", timestamp: Date.now() },
            cursorAssistant("Earlier response"),
            { role: "user", content: "Continue", timestamp: Date.now() },
          ],
        },
        streamOptions,
      ),
    );

    expect(replacement.sdk.Agent.resume).toHaveBeenCalledWith("agent-1", {
      apiKey: "test-key",
    });
    expect(replacementAgent.send).toHaveBeenCalledWith(
      expect.stringContaining("Earlier response"),
      expect.any(Object),
    );
  });

  it("does not start an SDK run after cancellation", async () => {
    const agent = { agentId: "agent-1", send: vi.fn(async () => finishedRun()) };
    const { provider } = await loadSdkProvider(agent);
    const controller = new AbortController();
    controller.abort();

    const events = await collectEvents(
      provider.streamSimple(
        model,
        { messages: [{ role: "user", content: "Run", timestamp: Date.now() }] },
        { apiKey: "test-key", sessionId: "session-1", signal: controller.signal },
      ),
    );

    expect(agent.send).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
  });

  it("discards an SDK agent created after cancellation", async () => {
    const controller = new AbortController();
    const sdkAgent = {
      agentId: "agent-1",
      send: vi.fn(async () => finishedRun()),
      [Symbol.asyncDispose]: vi.fn(async () => undefined),
    };
    let finishCreate: ((agent: typeof sdkAgent) => void) | undefined;
    const delayedCreate = new Promise<typeof sdkAgent>((resolve) => {
      finishCreate = resolve;
    });
    let createCalls = 0;
    const { provider, sdk } = await loadSdkProvider(sdkAgent, {
      createAgent: async () => {
        createCalls += 1;
        return createCalls === 1 ? delayedCreate : sdkAgent;
      },
    });
    const options = { apiKey: "test-key", sessionId: "session-1" };
    const abortedEventsPromise = collectEvents(
      provider.streamSimple(
        model,
        { messages: [{ role: "user", content: "First", timestamp: Date.now() }] },
        { ...options, signal: controller.signal },
      ),
    );
    await vi.waitFor(() => expect(sdk.Agent.create).toHaveBeenCalledOnce());
    controller.abort();
    finishCreate?.(sdkAgent);
    const abortedEvents = await abortedEventsPromise;

    await collectEvents(
      provider.streamSimple(
        model,
        {
          systemPrompt: "Preserve this instruction.",
          messages: [
            { role: "user", content: "First", timestamp: Date.now() },
            cursorAssistant("Earlier response"),
            { role: "user", content: "Continue", timestamp: Date.now() },
          ],
        },
        options,
      ),
    );

    expect(abortedEvents.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
    expect(sdkAgent[Symbol.asyncDispose]).toHaveBeenCalledOnce();
    expect(sdk.Agent.create).toHaveBeenCalledTimes(2);
    expect(sdkAgent.send).toHaveBeenCalledWith(
      expect.stringContaining("Earlier response"),
      expect.any(Object),
    );
  });

  it("cancels an SDK run when cancellation happens during send", async () => {
    const controller = new AbortController();
    const run = finishedRun();
    const agent = {
      agentId: "agent-1",
      send: vi.fn(async () => {
        controller.abort();
        return run;
      }),
    };
    const { provider } = await loadSdkProvider(agent);

    const events = await collectEvents(
      provider.streamSimple(
        model,
        { messages: [{ role: "user", content: "Run", timestamp: Date.now() }] },
        { apiKey: "test-key", sessionId: "session-1", signal: controller.signal },
      ),
    );

    expect(run.cancel).toHaveBeenCalledOnce();
    expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
  });

  it("does not spawn a CLI run after cancellation", async () => {
    const cursorAgentBin = join(home, "cursor-agent");
    const runMarker = join(home, "run-started");
    await writeFile(
      cursorAgentBin,
      [
        "#!/bin/bash",
        "set -euo pipefail",
        'if [[ "${1:-}" == "models" ]]; then printf "grok-4.5\\n"; exit 0; fi',
        `printf started > ${JSON.stringify(runMarker)}`,
        `printf '%s\\n' '${JSON.stringify({ type: "result", is_error: false })}'`,
      ].join("\n"),
    );
    await chmod(cursorAgentBin, 0o755);
    const provider = await loadCliProvider(cursorAgentBin);
    const controller = new AbortController();
    controller.abort();

    const events = await collectEvents(
      provider.streamSimple(
        model,
        { messages: [{ role: "user", content: "Run", timestamp: Date.now() }] },
        { sessionId: "session-1", signal: controller.signal },
      ),
    );

    await expect(readFile(runMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
  });

  it("reports CLI result errors through the provider stream", async () => {
    const cursorAgentBin = join(home, "cursor-agent");
    await writeFile(
      cursorAgentBin,
      [
        "#!/bin/bash",
        "set -euo pipefail",
        'if [[ "${1:-}" == "models" ]]; then printf "grok-4.5\\n"; exit 0; fi',
        `printf '%s\\n' '${JSON.stringify({
          type: "result",
          is_error: true,
          result: "simulated Grok failure",
        })}'`,
      ].join("\n"),
    );
    await chmod(cursorAgentBin, 0o755);
    const provider = await loadCliProvider(cursorAgentBin);
    expect(provider.baseUrl).toBe("cursor-agent://local");

    const events = await collectEvents(
      provider.streamSimple(
        model,
        { messages: [{ role: "user", content: "Run", timestamp: Date.now() }] },
        { sessionId: "session-1" },
      ),
    );

    expect(events.at(-1)).toMatchObject({
      type: "error",
      reason: "error",
      error: { errorMessage: "simulated Grok failure" },
    });
  });

  it("keeps persisted SDK conversations isolated by Pi session", async () => {
    const agentA = { agentId: "agent-a", send: vi.fn(async () => finishedRun()) };
    const firstSessionA = await loadSdkProvider(agentA);
    await collectEvents(
      firstSessionA.provider.streamSimple(
        model,
        { messages: [{ role: "user", content: "A", timestamp: Date.now() }] },
        { apiKey: "test-key", sessionId: "session-a" },
      ),
    );

    vi.resetModules();
    const agentB = { agentId: "agent-b", send: vi.fn(async () => finishedRun()) };
    const sessionB = await loadSdkProvider(agentB);
    await collectEvents(
      sessionB.provider.streamSimple(
        model,
        { messages: [{ role: "user", content: "B", timestamp: Date.now() }] },
        { apiKey: "test-key", sessionId: "session-b" },
      ),
    );

    vi.resetModules();
    const resumedAgentA = { agentId: "agent-a", send: vi.fn(async () => finishedRun()) };
    const resumedSessionA = await loadSdkProvider(resumedAgentA);
    await collectEvents(
      resumedSessionA.provider.streamSimple(
        model,
        {
          messages: [
            { role: "user", content: "A", timestamp: Date.now() },
            cursorAssistant("A response"),
            { role: "user", content: "Continue A", timestamp: Date.now() },
          ],
        },
        { apiKey: "test-key", sessionId: "session-a" },
      ),
    );

    expect(resumedSessionA.sdk.Agent.resume).toHaveBeenCalledWith("agent-a", {
      apiKey: "test-key",
    });
  });
});
