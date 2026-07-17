import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import remoteExtension from "../pi-extensions/remote/index.js";
import { startIpcDaemonServer, type IpcEnvelope } from "../pi-extensions/remote/ipc.js";

type RegisteredCommand = { handler(args: string, ctx: MockContext): Promise<void> };
type MockContext = ReturnType<typeof createContext>;

const handlers = new Map<string, (event: unknown, ctx: MockContext) => void | Promise<void>>();

function createPi() {
  const commands = new Map<string, RegisteredCommand>();
  return {
    pi: {
      on: vi.fn((event: string, handler: (event: unknown, ctx: MockContext) => void) => {
        handlers.set(event, handler);
      }),
      registerCommand: vi.fn((name: string, command: RegisteredCommand) => {
        commands.set(name, command);
      }),
      getSessionName: vi.fn(() => "Remote test"),
      sendUserMessage: vi.fn(),
    },
    command(name: string) {
      const command = commands.get(name);
      if (!command) {
        throw new Error(`missing command: ${name}`);
      }
      return command;
    },
  };
}

function createContext() {
  return {
    cwd: "/tmp/project",
    abort: vi.fn(),
    ui: {
      notify: vi.fn(),
    },
    sessionManager: {
      getSessionId: vi.fn(() => "session-1"),
      getSessionName: vi.fn(() => undefined),
      getSessionFile: vi.fn(() => "/tmp/project/session.jsonl"),
      getBranch: vi.fn(() => [
        entry("1", { role: "user", content: "hello" }),
        entry("2", { role: "assistant", content: [{ type: "text", text: "hi" }] }),
      ]),
    },
  };
}

function entry(id: string, message: unknown) {
  return { type: "message", id, parentId: null, timestamp: new Date().toISOString(), message };
}

async function waitForFrame(frames: IpcEnvelope[], predicate: (frame: IpcEnvelope) => boolean) {
  let found: IpcEnvelope | undefined;
  await waitFor(() => {
    found = frames.find(predicate);
    expect(found).toBeDefined();
  });
  return found;
}

async function waitFor(assertion: () => void) {
  const deadline = Date.now() + 1_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

describe("remote extension", () => {
  let root = "";
  let originalRoot: string | undefined;

  beforeEach(async () => {
    vi.restoreAllMocks();
    handlers.clear();
    originalRoot = process.env.PI_REMOTE_ROOT;
    root = await mkdtemp(join(tmpdir(), "pi-remote-extension-"));
    process.env.PI_REMOTE_ROOT = root;
  });

  afterEach(async () => {
    process.env.PI_REMOTE_ROOT = originalRoot;
    await rm(root, { recursive: true, force: true });
  });

  it("registers, backfills on attach, streams live events, and applies inbound frames", async () => {
    const frames: IpcEnvelope[] = [];
    const daemon = await startIpcDaemonServer(join(root, "daemon.sock"), {
      onFrame: (frame) => frames.push(frame),
      getPairingInfo: () => ({ ticket: "ticket-stub", code: "123-456" }),
    });
    const { pi, command } = createPi();
    const ctx = createContext();

    try {
      remoteExtension(pi as never);
      await command("remote").handler("", ctx);

      await expect(daemon.waitForSession("session-1")).resolves.toMatchObject({
        name: "Remote test",
        cwd: "/tmp/project",
      });

      await daemon.sendToSession({ sessionId: "session-1", type: "attach", payload: {} });
      await waitForFrame(frames, (frame) => frame.type === "event" && hasText(frame, "hello"));
      await waitForFrame(frames, (frame) => frame.type === "event" && hasText(frame, "hi"));

      await handlers.get("message_end")?.(
        { type: "message_end", message: { role: "assistant", content: "live" } },
        ctx,
      );
      await waitForFrame(frames, (frame) => frame.type === "event" && hasText(frame, "live"));

      await daemon.sendToSession({
        sessionId: "session-1",
        type: "prompt",
        payload: { text: "keep going" },
      });
      await waitFor(() =>
        expect(pi.sendUserMessage).toHaveBeenCalledWith("keep going", { deliverAs: "steer" }),
      );

      await daemon.sendToSession({ sessionId: "session-1", type: "abort", payload: {} });
      await waitFor(() => expect(ctx.abort).toHaveBeenCalled());

      await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctx);
      await daemon.waitForSessionEnd("session-1");
      expect(daemon.registry.has("session-1")).toBe(false);
    } finally {
      await daemon.close();
    }
  });

  it("tears down the prior remote client before re-registering", async () => {
    const frames: IpcEnvelope[] = [];
    const daemon = await startIpcDaemonServer(join(root, "daemon.sock"), {
      onFrame: (frame) => frames.push(frame),
      getPairingInfo: () => ({ ticket: "ticket-stub", code: "123-456" }),
    });
    const { pi, command } = createPi();
    const ctx = createContext();

    try {
      remoteExtension(pi as never);
      await command("remote").handler("", ctx);
      await command("remote").handler("", ctx);

      await waitFor(() => {
        expect(frames.filter((frame) => frame.type === "register")).toHaveLength(2);
        expect(frames.filter((frame) => frame.type === "session_shutdown")).toHaveLength(1);
      });
      expect(daemon.registry.has("session-1")).toBe(true);
    } finally {
      await daemon.close();
    }
  });

  it("sends the full backfill before live events raised during attach", async () => {
    const frames: IpcEnvelope[] = [];
    const { pi, command } = createPi();
    const ctx = createContext();
    let triggeredLiveEvent = false;
    const daemon = await startIpcDaemonServer(join(root, "daemon.sock"), {
      onFrame: (frame) => {
        frames.push(frame);
        if (frame.type === "event" && hasText(frame, "hello") && !triggeredLiveEvent) {
          triggeredLiveEvent = true;
          void handlers.get("message_end")?.(
            { type: "message_end", message: { role: "assistant", content: "live during attach" } },
            ctx,
          );
        }
      },
      getPairingInfo: () => ({ ticket: "ticket-stub", code: "123-456" }),
    });

    try {
      remoteExtension(pi as never);
      await command("remote").handler("", ctx);
      await daemon.waitForSession("session-1");

      await daemon.sendToSession({ sessionId: "session-1", type: "attach", payload: {} });
      await waitForFrame(
        frames,
        (frame) => frame.type === "event" && hasText(frame, "live during attach"),
      );

      expect(eventTexts(frames)).toEqual(["hello", "hi", "live during attach"]);
    } finally {
      await daemon.close();
    }
  });

  it("keeps live events FIFO when new events arrive during pending flush", async () => {
    const frames: IpcEnvelope[] = [];
    const { pi, command } = createPi();
    const ctx = createContext();
    let queuedDuringBackfill = false;
    let queuedDuringFlush = false;
    const daemon = await startIpcDaemonServer(join(root, "daemon.sock"), {
      onFrame: (frame) => {
        frames.push(frame);
        if (frame.type === "event" && hasText(frame, "hello") && !queuedDuringBackfill) {
          queuedDuringBackfill = true;
          void handlers.get("message_end")?.(
            { type: "message_end", message: { role: "assistant", content: "buffered A" } },
            ctx,
          );
          void handlers.get("message_end")?.(
            { type: "message_end", message: { role: "assistant", content: "buffered B" } },
            ctx,
          );
        }
        if (frame.type === "event" && hasText(frame, "buffered A") && !queuedDuringFlush) {
          queuedDuringFlush = true;
          void handlers.get("message_end")?.(
            { type: "message_end", message: { role: "assistant", content: "buffered C" } },
            ctx,
          );
        }
      },
      getPairingInfo: () => ({ ticket: "ticket-stub", code: "123-456" }),
    });

    try {
      remoteExtension(pi as never);
      await command("remote").handler("", ctx);
      await daemon.waitForSession("session-1");

      await daemon.sendToSession({ sessionId: "session-1", type: "attach", payload: {} });
      await waitForFrame(frames, (frame) => frame.type === "event" && hasText(frame, "buffered C"));

      expect(eventTexts(frames)).toEqual(["hello", "hi", "buffered A", "buffered B", "buffered C"]);
    } finally {
      await daemon.close();
    }
  });

  it("honors detach received while attach backfill is in flight", async () => {
    const frames: IpcEnvelope[] = [];
    const { pi, command } = createPi();
    const ctx = createContext();
    let detachedDuringBackfill = false;
    const daemon = await startIpcDaemonServer(join(root, "daemon.sock"), {
      onFrame: (frame) => {
        frames.push(frame);
        if (frame.type === "event" && hasText(frame, "hello") && !detachedDuringBackfill) {
          detachedDuringBackfill = true;
          void (async () => {
            await daemon.sendToSession({ sessionId: "session-1", type: "detach", payload: {} });
            await handlers.get("message_end")?.(
              {
                type: "message_end",
                message: { role: "assistant", content: "drop during detach" },
              },
              ctx,
            );
          })();
        }
      },
      getPairingInfo: () => ({ ticket: "ticket-stub", code: "123-456" }),
    });

    try {
      remoteExtension(pi as never);
      await command("remote").handler("", ctx);
      await daemon.waitForSession("session-1");

      await daemon.sendToSession({ sessionId: "session-1", type: "attach", payload: {} });
      await waitForFrame(frames, (frame) => frame.type === "event" && hasText(frame, "hi"));
      await new Promise((resolve) => setTimeout(resolve, 50));
      await handlers.get("message_end")?.(
        { type: "message_end", message: { role: "assistant", content: "after detach" } },
        ctx,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(eventTexts(frames)).toEqual(["hello", "hi"]);
    } finally {
      await daemon.close();
    }
  });

  it("generates and redacts a bounded capsule projection on the execution host", async () => {
    const daemon = await startIpcDaemonServer(join(root, "daemon.sock"), {
      getPairingInfo: () => ({ ticket: "ticket-stub", code: "123-456" }),
    });
    const { pi, command } = createPi();
    const ctx = createContext();
    ctx.sessionManager.getBranch.mockReturnValue([
      entry("1", { role: "user", content: "Finish capsule retrieval with token=supersecret" }),
      entry("2", {
        role: "assistant",
        content: [{ type: "text", text: "Next action: run the tests" }],
      }),
    ]);

    try {
      remoteExtension(pi as never);
      await command("remote").handler("", ctx);
      await daemon.waitForSession("session-1");
      const response = daemon.requestFromSession({
        sessionId: "session-1",
        type: "capsule",
        payload: { requestId: "request-1" },
      });

      await expect(response).resolves.toMatchObject({
        sessionId: "session-1",
        type: "capsule",
        payload: {
          requestId: "request-1",
          supported: true,
          capsule: {
            objective: "Finish capsule retrieval with token=[REDACTED]",
            maxPayloadBytes: 32 * 1024,
            redactions: [
              { category: "secret", count: 1 },
              { category: "untrusted", count: 2 },
            ],
          },
        },
      });
      const payload = (await response).payload;
      expect(payload).not.toHaveProperty("capsule.source");
      expect(JSON.stringify(payload)).not.toContain("supersecret");
      expect(Buffer.byteLength(JSON.stringify(payload), "utf8")).toBeLessThanOrEqual(32 * 1024);
    } finally {
      await daemon.close();
    }
  });

  it("ignores empty remote prompts", async () => {
    const daemon = await startIpcDaemonServer(join(root, "daemon.sock"), {
      getPairingInfo: () => ({ ticket: "ticket-stub", code: "123-456" }),
    });
    const { pi, command } = createPi();
    const ctx = createContext();

    try {
      remoteExtension(pi as never);
      await command("remote").handler("", ctx);
      await daemon.waitForSession("session-1");

      await daemon.sendToSession({ sessionId: "session-1", type: "prompt", payload: {} });
      await daemon.sendToSession({
        sessionId: "session-1",
        type: "prompt",
        payload: { text: "  \n\t  " },
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(pi.sendUserMessage).not.toHaveBeenCalled();
    } finally {
      await daemon.close();
    }
  });

  it("registers status and stop command variants through /remote args", async () => {
    const stopped = vi.fn();
    const daemon = await startIpcDaemonServer(join(root, "daemon.sock"), { onStop: stopped });
    const { pi, command } = createPi();
    const ctx = createContext();

    try {
      remoteExtension(pi as never);
      expect(pi.registerCommand).toHaveBeenCalledWith("remote", expect.any(Object));

      await command("remote").handler("status", ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith("Remote daemon running (0 sessions)", "info");

      await command("remote").handler("stop", ctx);
      expect(stopped).toHaveBeenCalled();
    } finally {
      await daemon.close();
    }
  });

  it("renders the daemon pairing ticket and code through /remote pair", async () => {
    const daemon = await startIpcDaemonServer(join(root, "daemon.sock"), {
      getPairingInfo: () => ({ ticket: "ticket-stub", code: "654-321" }),
    });
    const { pi, command } = createPi();
    const ctx = createContext();

    try {
      remoteExtension(pi as never);

      await command("remote").handler("pair", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Ticket: ticket-stub"),
        "info",
      );
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Enter pairing code: 654-321"),
        "info",
      );
    } finally {
      await daemon.close();
    }
  });

  it("receives the stop response before the daemon closes", async () => {
    const { pi, command } = createPi();
    const ctx = createContext();
    let daemon = await startIpcDaemonServer(join(root, "daemon.sock"), {
      onStop: async () => daemon.close(),
    });

    remoteExtension(pi as never);
    await command("remote").handler("stop", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith("Remote daemon stop requested", "info");
  });

  it("reports status and stop as not running when the daemon is down", async () => {
    const { pi, command } = createPi();
    const ctx = createContext();

    remoteExtension(pi as never);

    await command("remote").handler("status", ctx);
    await command("remote").handler("stop", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith("Remote daemon is not running", "info");
    expect(ctx.ui.notify).toHaveBeenCalledTimes(2);
  });
});

function eventTexts(frames: IpcEnvelope[]): string[] {
  return frames.flatMap((frame) => {
    if (frame.type !== "event" || !hasPayloadText(frame)) {
      return [];
    }
    return [frame.payload.text];
  });
}

function hasText(frame: IpcEnvelope, text: string): boolean {
  return hasPayloadText(frame) && frame.payload.text === text;
}

function hasPayloadText(frame: IpcEnvelope): frame is IpcEnvelope & { payload: { text: string } } {
  return (
    typeof frame.payload === "object" &&
    frame.payload !== null &&
    "text" in frame.payload &&
    typeof frame.payload.text === "string"
  );
}
