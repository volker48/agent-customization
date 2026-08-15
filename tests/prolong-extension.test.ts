import { beforeEach, describe, expect, it, vi } from "vitest";
import prolongExtension, {
  registerProlongExtension,
  type ProlongMemoryPort,
} from "../pi-extensions/prolong.js";

type MockContext = ReturnType<typeof createContext>["context"];
type Handler = (event: unknown, context: MockContext) => unknown;
type Command = {
  handler: (argumentsText: string, context: MockContext) => Promise<void>;
};

function createMemory(): ProlongMemoryPort {
  return {
    directoryPath: "/runtime/pi-prolong/session-1",
    logPath: "/runtime/pi-prolong/session-1/active-branch.jsonl",
    sync: vi.fn(async (entries) => ({
      mode: "rebuild" as const,
      entryCount: entries.length,
      byteSize: 123,
      elapsedMs: 1.5,
    })),
    cleanup: vi.fn(async () => undefined),
  };
}

function createPi(options: { flag?: boolean; defaultEnabled?: boolean } = {}) {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Command>();
  const flags = new Map<string, boolean | string | undefined>([["prolong", options.flag]]);
  const registeredFlags = new Map<string, { type: string; description?: string }>();
  const branch: Array<{ id: string; type: string; customType?: string; data?: unknown }> = [];
  const memory = createMemory();

  const pi = {
    on: vi.fn((name: string, handler: Handler) => handlers.set(name, handler)),
    registerFlag: vi.fn((name: string, definition: { type: string; description?: string }) =>
      registeredFlags.set(name, definition),
    ),
    getFlag: vi.fn((name: string) => flags.get(name)),
    registerCommand: vi.fn((name: string, command: Command) => commands.set(name, command)),
    appendEntry: vi.fn((customType: string, data?: unknown) => {
      branch.push({
        type: "custom",
        id: `custom-${branch.length + 1}`,
        customType,
        data,
      });
    }),
  };

  registerProlongExtension(pi as never, {
    createMemory: () => memory,
    defaultEnabled: () => options.defaultEnabled ?? false,
  });

  return { pi, handlers, commands, registeredFlags, branch, memory };
}

function createContext(branch: unknown[] = []) {
  const notifications: Array<{ message: string; level?: string }> = [];
  return {
    context: {
      sessionManager: {
        getSessionId: () => "session-1",
        getBranch: () => branch,
      },
      ui: {
        notify: (message: string, level?: string) => notifications.push({ message, level }),
      },
    },
    notifications,
  };
}

async function callHandler(
  handlers: Map<string, Handler>,
  name: string,
  event: unknown,
  context: ReturnType<typeof createContext>,
) {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`${name} handler was not registered`);
  return handler(event, context.context);
}

async function callCommand(
  commands: Map<string, Command>,
  argumentsText: string,
  context: ReturnType<typeof createContext>,
): Promise<void> {
  const command = commands.get("prolong");
  if (!command) throw new Error("prolong command was not registered");
  await command.handler(argumentsText, context.context);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("PRO-LONG Pi extension", () => {
  it("registers opt-in controls and has no disabled-by-default prompt or sync effect", async () => {
    const runtime = createPi();
    const context = createContext(runtime.branch);

    await callHandler(runtime.handlers, "session_start", { type: "session_start" }, context);
    const result = await callHandler(
      runtime.handlers,
      "before_agent_start",
      { type: "before_agent_start", systemPrompt: "base prompt" },
      context,
    );

    expect(runtime.registeredFlags.get("prolong")).toMatchObject({ type: "boolean" });
    expect(runtime.commands.has("prolong")).toBe(true);
    expect(runtime.memory.sync).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it("exports a standard Pi extension factory", () => {
    expect(prolongExtension).toBeTypeOf("function");
  });

  it("synchronizes enabled sessions before startup and every provider-bound context", async () => {
    const runtime = createPi({ defaultEnabled: true });
    const context = createContext(runtime.branch);

    await callHandler(runtime.handlers, "session_start", { type: "session_start" }, context);
    expect(runtime.memory.sync).toHaveBeenCalledTimes(1);

    const promptResult = await callHandler(
      runtime.handlers,
      "before_agent_start",
      { type: "before_agent_start", systemPrompt: "base prompt" },
      context,
    );

    expect(runtime.memory.sync).toHaveBeenCalledTimes(2);
    expect(promptResult).toBeUndefined();

    const contextResult = await callHandler(
      runtime.handlers,
      "context",
      { type: "context", messages: [{ role: "user", content: "hello" }] },
      context,
    );
    expect(contextResult).toMatchObject({
      messages: [
        { role: "user", content: "hello" },
        {
          role: "custom",
          customType: "prolong-context-hint",
          content: expect.stringContaining(runtime.memory.logPath),
          display: false,
        },
      ],
    });
    expect(runtime.memory.sync).toHaveBeenCalledTimes(3);
  });

  it("lets the latest active-branch state override process defaults", async () => {
    const disabled = createPi({ defaultEnabled: true });
    disabled.branch.push({
      type: "custom",
      id: "state-off",
      customType: "prolong-state",
      data: { enabled: false },
    });
    const disabledContext = createContext(disabled.branch);

    await callHandler(
      disabled.handlers,
      "session_start",
      { type: "session_start" },
      disabledContext,
    );
    expect(disabled.memory.sync).not.toHaveBeenCalled();
    expect(
      await callHandler(
        disabled.handlers,
        "before_agent_start",
        { type: "before_agent_start", systemPrompt: "base" },
        disabledContext,
      ),
    ).toBeUndefined();

    const enabled = createPi({ defaultEnabled: false });
    enabled.branch.push({
      type: "custom",
      id: "state-on",
      customType: "prolong-state",
      data: { enabled: true },
    });
    const enabledContext = createContext(enabled.branch);

    await callHandler(enabled.handlers, "session_start", { type: "session_start" }, enabledContext);
    expect(enabled.memory.sync).toHaveBeenCalledTimes(1);
  });

  it("persists on and off controls, reports status, forces refresh, and removes the projection", async () => {
    const runtime = createPi();
    const context = createContext(runtime.branch);
    await callHandler(runtime.handlers, "session_start", { type: "session_start" }, context);

    await callCommand(runtime.commands, "on", context);
    expect(runtime.pi.appendEntry).toHaveBeenLastCalledWith("prolong-state", { enabled: true });
    expect(runtime.memory.sync).toHaveBeenCalledTimes(1);
    expect(context.notifications.at(-1)?.message).toContain("enabled");
    expect(context.notifications.at(-1)?.message).toContain(runtime.memory.logPath);

    await callCommand(runtime.commands, "status", context);
    const status = context.notifications.at(-1)?.message ?? "";
    expect(status).toContain("PRO-LONG: on");
    expect(status).toContain(runtime.memory.logPath);
    expect(status).toContain("Entries: 1");
    expect(status).toContain("Bytes: 123");
    expect(status).toContain("Last sync: rebuild");

    await callCommand(runtime.commands, "refresh", context);
    expect(runtime.memory.sync).toHaveBeenLastCalledWith(runtime.branch, { forceRebuild: true });
    expect(context.notifications.at(-1)?.message).toContain("refreshed");

    await callCommand(runtime.commands, "off", context);
    expect(runtime.pi.appendEntry).toHaveBeenLastCalledWith("prolong-state", { enabled: false });
    expect(runtime.memory.cleanup).toHaveBeenCalledTimes(1);
    expect(context.notifications.at(-1)?.message).toContain("disabled");
    expect(
      await callHandler(
        runtime.handlers,
        "before_agent_start",
        { type: "before_agent_start", systemPrompt: "base" },
        context,
      ),
    ).toBeUndefined();
  });

  it("cleans the previous session projection before replacing its memory handle", async () => {
    const runtime = createPi({ defaultEnabled: true });
    const context = createContext(runtime.branch);

    await callHandler(
      runtime.handlers,
      "session_start",
      { type: "session_start", reason: "startup" },
      context,
    );
    expect(runtime.memory.cleanup).not.toHaveBeenCalled();

    await callHandler(
      runtime.handlers,
      "session_start",
      { type: "session_start", reason: "resume", previousSessionFile: "/old/session.jsonl" },
      context,
    );

    expect(runtime.memory.cleanup).toHaveBeenCalledTimes(1);
  });

  it("keeps the branch enabled and does not persist off when cleanup fails", async () => {
    const runtime = createPi();
    const context = createContext(runtime.branch);
    await callHandler(runtime.handlers, "session_start", { type: "session_start" }, context);
    await callCommand(runtime.commands, "on", context);
    vi.mocked(runtime.memory.cleanup).mockRejectedValueOnce(new Error("permission denied"));

    await callCommand(runtime.commands, "off", context);

    expect(runtime.branch.at(-1)?.data).toEqual({ enabled: true });
    expect(context.notifications.at(-1)).toMatchObject({ level: "error" });
    expect(context.notifications.at(-1)?.message).toContain("still enabled");

    await callCommand(runtime.commands, "off", context);
    expect(runtime.branch.at(-1)?.data).toEqual({ enabled: false });
  });

  it("reconciles enablement after tree navigation and cleans up on shutdown", async () => {
    const runtime = createPi({ defaultEnabled: false });
    runtime.branch.push({
      type: "custom",
      id: "state-on",
      customType: "prolong-state",
      data: { enabled: true },
    });
    const context = createContext(runtime.branch);
    await callHandler(runtime.handlers, "session_start", { type: "session_start" }, context);
    expect(runtime.memory.sync).toHaveBeenCalledTimes(1);

    runtime.branch.splice(0);
    await callHandler(runtime.handlers, "session_tree", { type: "session_tree" }, context);
    expect(runtime.memory.cleanup).toHaveBeenCalledTimes(1);
    expect(
      await callHandler(
        runtime.handlers,
        "before_agent_start",
        { type: "before_agent_start", systemPrompt: "base" },
        context,
      ),
    ).toBeUndefined();

    runtime.branch.push({
      type: "custom",
      id: "state-on-again",
      customType: "prolong-state",
      data: { enabled: true },
    });
    await callHandler(runtime.handlers, "session_tree", { type: "session_tree" }, context);
    expect(runtime.memory.sync).toHaveBeenCalledTimes(2);

    await callHandler(runtime.handlers, "session_shutdown", { type: "session_shutdown" }, context);
    expect(runtime.memory.cleanup).toHaveBeenCalledTimes(2);
  });

  it("warns once and omits the hint while stale, then recovers on a later successful sync", async () => {
    const runtime = createPi({ defaultEnabled: true });
    const context = createContext(runtime.branch);
    const sync = vi.mocked(runtime.memory.sync);
    sync.mockRejectedValue(new Error("runtime directory unavailable"));

    await callHandler(runtime.handlers, "session_start", { type: "session_start" }, context);
    expect(context.notifications.filter((item) => item.level === "warning")).toHaveLength(1);

    expect(
      await callHandler(
        runtime.handlers,
        "before_agent_start",
        { type: "before_agent_start", systemPrompt: "base" },
        context,
      ),
    ).toBeUndefined();
    expect(context.notifications.filter((item) => item.level === "warning")).toHaveLength(1);
    expect(runtime.pi.appendEntry).not.toHaveBeenCalled();

    sync.mockResolvedValue({ mode: "rebuild", entryCount: 0, byteSize: 0, elapsedMs: 2 });
    expect(
      await callHandler(
        runtime.handlers,
        "before_agent_start",
        { type: "before_agent_start", systemPrompt: "base" },
        context,
      ),
    ).toBeUndefined();
    const recovered = await callHandler(
      runtime.handlers,
      "context",
      { type: "context", messages: [{ role: "user", content: "hello" }] },
      context,
    );
    expect(recovered).toMatchObject({
      messages: [
        { role: "user", content: "hello" },
        { role: "custom", content: expect.stringContaining(runtime.memory.logPath) },
      ],
    });

    sync.mockRejectedValue(new Error("second failure"));
    const stale = await callHandler(
      runtime.handlers,
      "context",
      { type: "context", messages: [{ role: "user", content: "next" }] },
      context,
    );
    expect(stale).toBeUndefined();
    expect(context.notifications.filter((item) => item.level === "warning")).toHaveLength(2);
  });
});
