import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  connectIpcExtension,
  startIpcDaemonServer,
  type IpcEnvelope,
} from "../pi-extensions/remote/ipc.js";

const roots: string[] = [];

async function tempSocketPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-remote-ipc-"));
  roots.push(root);
  return join(root, "daemon.sock");
}

describe("remote Unix-socket IPC", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("registers an extension session over JSONL on a Unix socket", async () => {
    const socketPath = await tempSocketPath();
    const daemon = await startIpcDaemonServer(socketPath);

    try {
      const extension = await connectIpcExtension(socketPath, {
        sessionId: "session-1",
        name: "Work session",
        cwd: "/repo",
      });
      await daemon.waitForSession("session-1");

      expect(daemon.registry.get("session-1")).toMatchObject({
        name: "Work session",
        cwd: "/repo",
      });
      await extension.close();
    } finally {
      await daemon.close();
    }
  });

  it("routes per-session frames to the matching extension socket", async () => {
    const socketPath = await tempSocketPath();
    const daemon = await startIpcDaemonServer(socketPath);

    try {
      const first = await connectIpcExtension(socketPath, {
        sessionId: "session-1",
        name: "First",
        cwd: "/repo/one",
      });
      const second = await connectIpcExtension(socketPath, {
        sessionId: "session-2",
        name: "Second",
        cwd: "/repo/two",
      });
      await daemon.waitForSession("session-1");
      await daemon.waitForSession("session-2");
      const frame: IpcEnvelope = {
        sessionId: "session-2",
        type: "prompt",
        payload: { text: "hello" },
      };

      await daemon.sendToSession(frame);

      await expect(second.readNext()).resolves.toEqual(frame);
      expect(first.receivedCount()).toBe(0);
      await first.close();
      await second.close();
    } finally {
      await daemon.close();
    }
  });

  it("drops a session on shutdown and emits a session_ended control frame", async () => {
    const socketPath = await tempSocketPath();
    const controlFrames: IpcEnvelope[] = [];
    const daemon = await startIpcDaemonServer(socketPath, {
      onControlFrame: (frame) => controlFrames.push(frame),
    });

    try {
      const extension = await connectIpcExtension(socketPath, {
        sessionId: "session-1",
        name: "Work session",
        cwd: "/repo",
      });
      await daemon.waitForSession("session-1");

      await extension.send({ sessionId: "session-1", type: "session_shutdown", payload: {} });
      await daemon.waitForSessionEnd("session-1");

      expect(daemon.registry.get("session-1")).toBeUndefined();
      expect(controlFrames).toEqual([
        { sessionId: null, type: "session_ended", payload: { sessionId: "session-1" } },
      ]);
      await extension.close();
    } finally {
      await daemon.close();
    }
  });

  it("handles extension socket errors and keeps accepting sessions", async () => {
    const socketPath = await tempSocketPath();
    const daemon = await startIpcDaemonServer(socketPath);

    try {
      const first = await connectIpcExtension(socketPath, {
        sessionId: "session-1",
        name: "First",
        cwd: "/repo/one",
      });
      const entry = await daemon.waitForSession("session-1");

      entry.socket.emit("error", new Error("simulated client socket failure"));
      const second = await connectIpcExtension(socketPath, {
        sessionId: "session-2",
        name: "Second",
        cwd: "/repo/two",
      });

      await expect(daemon.waitForSession("session-2")).resolves.toMatchObject({
        name: "Second",
        cwd: "/repo/two",
      });
      await first.close();
      await second.close();
    } finally {
      await daemon.close();
    }
  });

  it("ignores malformed frames and keeps accepting sessions", async () => {
    const socketPath = await tempSocketPath();
    const daemon = await startIpcDaemonServer(socketPath);

    try {
      const rawClient = await connectRawSocket(socketPath);
      await writeRawFrame(rawClient, "not-json\n");
      rawClient.destroy();

      const extension = await connectIpcExtension(socketPath, {
        sessionId: "session-1",
        name: "Work session",
        cwd: "/repo",
      });

      await expect(daemon.waitForSession("session-1")).resolves.toMatchObject({
        name: "Work session",
        cwd: "/repo",
      });
      await extension.close();
    } finally {
      await daemon.close();
    }
  });

  it("rejects a pending session waiter when the daemon closes", async () => {
    const socketPath = await tempSocketPath();
    const daemon = await startIpcDaemonServer(socketPath);
    const waiter = daemon.waitForSession("missing-session");

    await daemon.close();

    await expect(waiter).rejects.toThrow("IPC daemon closed before session registered");
  });

  it("rejects a pending extension reader when its socket closes", async () => {
    const socketPath = await tempSocketPath();
    const daemon = await startIpcDaemonServer(socketPath);

    try {
      const extension = await connectIpcExtension(socketPath, {
        sessionId: "session-1",
        name: "Work session",
        cwd: "/repo",
      });
      await daemon.waitForSession("session-1");
      const reader = extension.readNext();

      await extension.close();

      await expect(reader).rejects.toThrow("IPC extension socket closed before receiving a frame");
    } finally {
      await daemon.close();
    }
  });

  it("keeps multiple concurrent sessions in the registry", async () => {
    const socketPath = await tempSocketPath();
    const daemon = await startIpcDaemonServer(socketPath);

    try {
      const first = await connectIpcExtension(socketPath, {
        sessionId: "session-1",
        name: "First",
        cwd: "/repo/one",
      });
      const second = await connectIpcExtension(socketPath, {
        sessionId: "session-2",
        name: "Second",
        cwd: "/repo/two",
      });
      await daemon.waitForSession("session-1");
      await daemon.waitForSession("session-2");

      expect([...daemon.registry.entries()].map(([sessionId]) => sessionId).sort()).toEqual([
        "session-1",
        "session-2",
      ]);
      await first.close();
      await second.close();
    } finally {
      await daemon.close();
    }
  });
});

function connectRawSocket(socketPath: string): Promise<ReturnType<typeof createConnection>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function writeRawFrame(socket: ReturnType<typeof createConnection>, frame: string): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(frame, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}
