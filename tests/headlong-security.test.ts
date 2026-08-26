import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerHeadlongExtension } from "../pi-extensions/headlong/index.js";

const roots: string[] = [];

function createContext(root: string) {
  return {
    cwd: join(root, "workspace"),
    isIdle: () => true,
    abort: vi.fn(),
    ui: { notify: vi.fn(), setStatus: vi.fn() },
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionFile: () => join(root, "session.jsonl"),
      getBranch: () => [],
    },
  };
}

type TestContext = ReturnType<typeof createContext>;
type EventHandler = (event: unknown, context: TestContext) => unknown;
type CommandHandler = (argumentsText: string, context: TestContext) => Promise<void>;

function createPi() {
  const handlers = new Map<string, EventHandler>();
  const commands = new Map<string, CommandHandler>();
  const allTools = [
    "read",
    "grep",
    "find",
    "ls",
    "edit",
    "write",
    "bash",
    "external_message",
    "headlong_checkpoint",
    "headlong_sleep",
    "headlong_complete",
    "headlong_blocked",
  ];
  const pi = {
    on: vi.fn((event: string, handler: EventHandler) => handlers.set(event, handler)),
    registerCommand: vi.fn(
      (_name: string, command: { handler: CommandHandler }) => commands.set("headlong", command.handler),
    ),
    registerTool: vi.fn(),
    sendUserMessage: vi.fn(),
    getActiveTools: vi.fn(() => ["read", "bash"]),
    getAllTools: vi.fn(() => allTools.map((name) => ({ name }))),
    setActiveTools: vi.fn(),
  };
  return { pi, handlers, commands };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Headlong unattended tool security", () => {
  it("exposes no model-facing filesystem tools by default, regardless of path shape", async () => {
    const root = await mkdtemp(join(tmpdir(), "headlong-security-default-"));
    roots.push(root);
    vi.stubEnv("PI_HEADLONG_TOOLS", "read,grep,find,ls,edit,write,bash,external_message");
    vi.stubEnv("PI_HEADLONG_UNSANDBOXED_HOST", "0");
    const runtime = createPi();
    const context = createContext(root);
    const callbacks: Array<() => Promise<void> | void> = [];
    registerHeadlongExtension(runtime.pi as never, {
      stateRoot: join(root, "state"),
      setTimer: (callback: () => Promise<void> | void) => {
        callbacks.push(callback);
        return callbacks.length;
      },
      clearTimer: vi.fn(),
    });

    await runtime.handlers.get("session_start")?.({ type: "session_start" }, context);
    await runtime.commands.get("headlong")?.("start", context);
    await callbacks[0]?.();

    expect(runtime.pi.setActiveTools).toHaveBeenLastCalledWith([
      "headlong_checkpoint",
      "headlong_sleep",
      "headlong_complete",
      "headlong_blocked",
    ]);
    expect(runtime.pi.setActiveTools).toHaveBeenLastCalledWith(
      expect.not.arrayContaining(["read", "grep", "find", "ls", "edit", "write"]),
    );
    await runtime.handlers.get("session_shutdown")?.({ type: "session_shutdown" }, context);
  });

  it("enables only the fixed host-filesystem subset after explicit unsandboxed opt-in", async () => {
    const root = await mkdtemp(join(tmpdir(), "headlong-security-opt-in-"));
    roots.push(root);
    vi.stubEnv("PI_HEADLONG_TOOLS", "read,edit,bash,external_message");
    const runtime = createPi();
    const context = createContext(root);
    const callbacks: Array<() => Promise<void> | void> = [];
    registerHeadlongExtension(runtime.pi as never, {
      stateRoot: join(root, "state"),
      allowUnsandboxedHostTools: true,
      setTimer: (callback: () => Promise<void> | void) => {
        callbacks.push(callback);
        return callbacks.length;
      },
      clearTimer: vi.fn(),
    });

    await runtime.handlers.get("session_start")?.({ type: "session_start" }, context);
    await runtime.commands.get("headlong")?.("start", context);
    await callbacks[0]?.();

    expect(runtime.pi.setActiveTools).toHaveBeenLastCalledWith([
      "read",
      "edit",
      "headlong_checkpoint",
      "headlong_sleep",
      "headlong_complete",
      "headlong_blocked",
    ]);
    expect(runtime.pi.setActiveTools).toHaveBeenLastCalledWith(
      expect.not.arrayContaining(["bash", "external_message"]),
    );
    await runtime.handlers.get("session_shutdown")?.({ type: "session_shutdown" }, context);
  });
});
