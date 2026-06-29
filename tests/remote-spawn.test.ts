import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

type RegisteredCommand = { handler(args: string, ctx: MockContext): Promise<void> };
type MockContext = ReturnType<typeof createContext>;

function createPi() {
  const commands = new Map<string, RegisteredCommand>();
  return {
    pi: {
      on: vi.fn(),
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
    ui: { notify: vi.fn() },
    sessionManager: {
      getSessionId: vi.fn(() => "session-1"),
      getSessionName: vi.fn(() => undefined),
      getBranch: vi.fn(() => []),
    },
  };
}

function createSocket(mode: "connect" | "missing") {
  const socket = new EventEmitter() as EventEmitter & {
    destroyed: boolean;
    end: () => void;
    destroy: () => void;
    write: (data: string, callback?: (error?: Error) => void) => void;
  };
  socket.destroyed = false;
  socket.end = vi.fn();
  socket.destroy = vi.fn(() => {
    socket.destroyed = true;
  });
  socket.write = vi.fn((_data: string, callback?: (error?: Error) => void) => {
    callback?.();
  });
  queueMicrotask(() => {
    if (mode === "missing") {
      const error = new Error("connect ENOENT") as Error & { code: string };
      error.code = "ENOENT";
      socket.emit("error", error);
      return;
    }
    socket.emit("connect");
  });
  return socket;
}

describe("remote daemon spawn", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("waits past slow cold-starts before reporting daemon startup failure", async () => {
    const spawned = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> };
    spawned.unref = vi.fn();
    const spawn = vi.fn(() => spawned);
    let connections = 0;
    const createConnection = vi.fn(() => {
      connections += 1;
      return createSocket(connections < 45 ? "missing" : "connect");
    });

    vi.doMock("node:child_process", () => ({ spawn }));
    vi.doMock("node:net", () => ({ createConnection }));

    const originalRoot = process.env.PI_REMOTE_ROOT;
    const root = await mkdtemp(join(tmpdir(), "pi-remote-spawn-"));
    process.env.PI_REMOTE_ROOT = root;
    await writeFile(join(root, "allowed-node-ids.json"), `${JSON.stringify(["node"])}\n`);

    try {
      const { default: remoteExtension } = await import("../pi-extensions/remote/index.js");
      const { pi, command } = createPi();
      const ctx = createContext();
      const started = Date.now();

      remoteExtension(pi as never);
      await command("remote").handler("", ctx);

      expect(Date.now() - started).toBeGreaterThanOrEqual(2_000);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(ctx.ui.notify).toHaveBeenCalledWith("Remote session registered", "info");
    } finally {
      if (originalRoot === undefined) {
        delete process.env.PI_REMOTE_ROOT;
      } else {
        process.env.PI_REMOTE_ROOT = originalRoot;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("starts the TypeScript daemon through Node, not a PATH-dependent tsx binary", async () => {
    const spawned = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> };
    spawned.unref = vi.fn();
    const spawn = vi.fn(() => spawned);
    const createConnection = vi
      .fn()
      .mockImplementationOnce(() => createSocket("missing"))
      .mockImplementationOnce(() => createSocket("connect"))
      .mockImplementationOnce(() => createSocket("connect"));

    vi.doMock("node:child_process", () => ({ spawn }));
    vi.doMock("node:net", () => ({ createConnection }));

    const originalRoot = process.env.PI_REMOTE_ROOT;
    const root = await mkdtemp(join(tmpdir(), "pi-remote-spawn-"));
    process.env.PI_REMOTE_ROOT = root;
    await writeFile(join(root, "allowed-node-ids.json"), `${JSON.stringify(["node"])}\n`);

    try {
      const { default: remoteExtension } = await import("../pi-extensions/remote/index.js");
      const { pi, command } = createPi();
      const ctx = createContext();

      remoteExtension(pi as never);
      await command("remote").handler("", ctx);

      const daemonEntry = join(process.cwd(), "pi-extensions/remote/daemon-entry.ts");
      expect(spawn).toHaveBeenCalledWith(
        process.execPath,
        ["--import", expect.stringContaining("tsx"), daemonEntry],
        { detached: true, stdio: "ignore" },
      );
      expect(spawn).not.toHaveBeenCalledWith("tsx", expect.anything(), expect.anything());
      expect(spawned.unref).toHaveBeenCalledTimes(1);
    } finally {
      if (originalRoot === undefined) {
        delete process.env.PI_REMOTE_ROOT;
      } else {
        process.env.PI_REMOTE_ROOT = originalRoot;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
