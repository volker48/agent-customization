import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EndpointTicket } from "@number0/iroh/index.js";
import { afterEach, describe, expect, it } from "vitest";

import { connectIpcExtension } from "../pi-extensions/remote/ipc.js";
import { startRemoteDaemon } from "../pi-extensions/remote/daemon.js";
import type { Envelope } from "../pi-extensions/remote/protocol.js";
import {
  bindEndpoint,
  closeEndpoint,
  connectEndpoint,
  finishSending,
  openStream,
  receiveEnvelopes,
  sendEnvelope,
} from "../pi-extensions/remote/iroh-transport.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-remote-daemon-"));
  roots.push(root);
  return root;
}

describe("remote daemon", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("pairs, lists, and attaches to a stub session over real iroh", async () => {
    const root = await tempRoot();
    const daemon = await startRemoteDaemon({ remoteRoot: root, pairingCode: "123-456" });
    const extension = await connectIpcExtension(daemon.socketPath, {
      sessionId: "session-1",
      name: "Work session",
      cwd: "/repo",
    });
    const client = await bindEndpoint();

    try {
      await daemon.ipc.waitForSession("session-1");

      const responses = await exchange(client, daemon.ticket, [
        { sessionId: null, type: "pair", payload: { code: "123-456" } },
        { sessionId: null, type: "list", payload: {} },
        { sessionId: null, type: "attach", payload: { sessionId: "session-1" } },
      ]);

      expect(responses).toEqual([
        { sessionId: null, type: "pair", payload: { paired: true } },
        {
          sessionId: null,
          type: "list",
          payload: [{ sessionId: "session-1", name: "Work session", cwd: "/repo" }],
        },
        { sessionId: null, type: "attach", payload: { attached: true, sessionId: "session-1" } },
      ]);
      await expect(extension.readNext()).resolves.toEqual({
        sessionId: "session-1",
        type: "attach",
        payload: {},
      });
      await expect(
        exchange(client, daemon.ticket, [{ sessionId: null, type: "list", payload: {} }]),
      ).resolves.toEqual([
        {
          sessionId: null,
          type: "list",
          payload: [{ sessionId: "session-1", name: "Work session", cwd: "/repo" }],
        },
      ]);
    } finally {
      await closeEndpoint(client);
      await extension.close();
      await daemon.close();
    }
  }, 30_000);

  it("persists a stable iroh node id across restarts", async () => {
    const root = await tempRoot();
    const first = await startRemoteDaemon({ remoteRoot: root, pairingCode: "123-456" });
    const firstNodeId = first.nodeId;
    await first.close();

    const second = await startRemoteDaemon({ remoteRoot: root, pairingCode: "123-456" });

    try {
      expect(second.nodeId).toBe(firstNodeId);
    } finally {
      await second.close();
    }
  }, 30_000);

  it("cleans stale daemon sockets and rejects a second live instance", async () => {
    const root = await tempRoot();
    const socketPath = join(root, "daemon.sock");
    await writeFile(socketPath, "");

    const daemon = await startRemoteDaemon({ remoteRoot: root, pairingCode: "123-456" });

    try {
      await expect(startRemoteDaemon({ remoteRoot: root, pairingCode: "123-456" })).rejects.toThrow(
        "remote daemon is already running",
      );
      await expect(connectSocket(socketPath)).resolves.toBeDefined();
    } finally {
      await daemon.close();
    }
  }, 30_000);

  it("routes detach to a stub session over real iroh", async () => {
    const root = await tempRoot();
    const daemon = await startRemoteDaemon({ remoteRoot: root, pairingCode: "123-456" });
    const extension = await connectIpcExtension(daemon.socketPath, {
      sessionId: "session-1",
      name: "Work session",
      cwd: "/repo",
    });
    const client = await bindEndpoint();

    try {
      await daemon.ipc.waitForSession("session-1");

      const responses = await exchange(client, daemon.ticket, [
        { sessionId: null, type: "pair", payload: { code: "123-456" } },
        { sessionId: null, type: "detach", payload: { sessionId: "session-1" } },
      ]);

      expect(responses).toEqual([
        { sessionId: null, type: "pair", payload: { paired: true } },
        { sessionId: null, type: "detach", payload: { detached: true, sessionId: "session-1" } },
      ]);
      await expect(extension.readNext()).resolves.toEqual({
        sessionId: "session-1",
        type: "detach",
        payload: {},
      });
    } finally {
      await closeEndpoint(client);
      await extension.close();
      await daemon.close();
    }
  }, 30_000);

  it("ignores attach and session frames for unknown sessions without crashing", async () => {
    const root = await tempRoot();
    const daemon = await startRemoteDaemon({ remoteRoot: root, pairingCode: "123-456" });
    const client = await bindEndpoint();

    try {
      const responses = await exchange(client, daemon.ticket, [
        { sessionId: null, type: "pair", payload: { code: "123-456" } },
        { sessionId: null, type: "attach", payload: { sessionId: "missing" } },
        { sessionId: "missing", type: "prompt", payload: { text: "hello" } },
      ]);

      expect(responses).toEqual([{ sessionId: null, type: "pair", payload: { paired: true } }]);
      await expect(
        exchange(client, daemon.ticket, [{ sessionId: null, type: "list", payload: {} }]),
      ).resolves.toEqual([{ sessionId: null, type: "list", payload: [] }]);
    } finally {
      await closeEndpoint(client);
      await daemon.close();
    }
  }, 30_000);

  it("does not let clients drain daemon-internal session_ended notifications", async () => {
    const root = await tempRoot();
    const daemon = await startRemoteDaemon({ remoteRoot: root, pairingCode: "123-456" });
    const extension = await connectIpcExtension(daemon.socketPath, {
      sessionId: "session-1",
      name: "Work session",
      cwd: "/repo",
    });
    const client = await bindEndpoint();

    try {
      await daemon.ipc.waitForSession("session-1");
      await extension.send({ sessionId: "session-1", type: "session_shutdown", payload: {} });
      await daemon.ipc.waitForSessionEnd("session-1");
      await exchange(client, daemon.ticket, [
        { sessionId: null, type: "pair", payload: { code: "123-456" } },
      ]);

      await expect(
        exchange(client, daemon.ticket, [{ sessionId: null, type: "session_ended", payload: {} }]),
      ).resolves.toEqual([]);
    } finally {
      await closeEndpoint(client);
      await extension.close();
      await daemon.close();
    }
  }, 30_000);

  it("writes persisted remote credentials with owner-only permissions", async () => {
    const root = await tempRoot();
    const daemon = await startRemoteDaemon({ remoteRoot: root, pairingCode: "123-456" });
    const client = await bindEndpoint();

    try {
      await exchange(client, daemon.ticket, [
        { sessionId: null, type: "pair", payload: { code: "123-456" } },
      ]);

      expect((await stat(join(root, "iroh-secret-key.json"))).mode & 0o777).toBe(0o600);
      expect((await stat(join(root, "allowed-node-ids.json"))).mode & 0o777).toBe(0o600);
    } finally {
      await closeEndpoint(client);
      await daemon.close();
    }
  }, 30_000);

  it("rejects frames whose type is inconsistent with their channel", async () => {
    const root = await tempRoot();
    const daemon = await startRemoteDaemon({ remoteRoot: root, pairingCode: "123-456" });
    const extension = await connectIpcExtension(daemon.socketPath, {
      sessionId: "session-1",
      name: "Work session",
      cwd: "/repo",
    });
    const client = await bindEndpoint();

    try {
      await daemon.ipc.waitForSession("session-1");
      await exchange(client, daemon.ticket, [
        { sessionId: null, type: "pair", payload: { code: "123-456" } },
      ]);

      const responses = await exchange(client, daemon.ticket, [
        { sessionId: "session-1", type: "list", payload: {} },
        { sessionId: null, type: "prompt", payload: { text: "bad" } },
      ] as Envelope[]);

      expect(responses).toEqual([]);
      expect(extension.receivedCount()).toBe(0);
    } finally {
      await closeEndpoint(client);
      await extension.close();
      await daemon.close();
    }
  }, 30_000);
});

async function exchange(
  client: Awaited<ReturnType<typeof bindEndpoint>>,
  ticket: string,
  frames: Envelope[],
): Promise<Envelope[]> {
  const addr = EndpointTicket.fromString(ticket).endpointAddr();
  const connection = await connectEndpoint(client, addr);
  const stream = await openStream(connection);
  for (const frame of frames) {
    await sendEnvelope(stream, frame);
  }
  await finishSending(stream);
  return receiveEnvelopes(stream);
}

function connectSocket(socketPath: string): Promise<ReturnType<typeof createConnection>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}
