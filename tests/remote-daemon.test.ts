import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EndpointTicket } from "@number0/iroh/index.js";
import { afterEach, describe, expect, it } from "vitest";

import { connectIpcExtension, type PairingInfo } from "../pi-extensions/remote/ipc.js";
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
      await armPairing(daemon.socketPath);

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

  it("returns capsules only to the same authorized node while it is attached", async () => {
    const root = await tempRoot();
    const daemon = await startRemoteDaemon({ remoteRoot: root, pairingCode: "123-456" });
    const extension = await connectIpcExtension(daemon.socketPath, {
      sessionId: "session-1",
      name: "Work session",
      cwd: "/repo",
      capabilities: ["context-capsule-v1"],
    });
    const client = await bindEndpoint();
    let attachConnection: Awaited<ReturnType<typeof connectEndpoint>> | undefined;

    try {
      await daemon.ipc.waitForSession("session-1");
      await expect(
        exchange(client, daemon.ticket, [
          {
            sessionId: null,
            type: "list",
            payload: { operation: "capsule", sessionId: "session-1" },
          },
        ]),
      ).resolves.toEqual([]);
      await armPairing(daemon.socketPath);
      await exchange(client, daemon.ticket, [
        { sessionId: null, type: "pair", payload: { code: "123-456" } },
      ]);

      await expect(
        exchange(client, daemon.ticket, [
          {
            sessionId: null,
            type: "list",
            payload: { operation: "capsule", sessionId: "session-1" },
          },
        ]),
      ).resolves.toMatchObject([
        {
          payload: {
            operation: "capsule",
            supported: true,
            error: { code: "not-attached" },
          },
        },
      ]);

      const addr = EndpointTicket.fromString(daemon.ticket).endpointAddr();
      attachConnection = await connectEndpoint(client, addr);
      const attachStream = await openStream(attachConnection);
      await sendEnvelope(attachStream, {
        sessionId: null,
        type: "attach",
        payload: { sessionId: "session-1", stream: true },
      });
      await finishSending(attachStream);
      await expect(extension.readNext()).resolves.toMatchObject({ type: "attach" });

      const capsuleRequest = exchange(client, daemon.ticket, [
        {
          sessionId: null,
          type: "list",
          payload: { operation: "capsule", sessionId: "session-1" },
        },
      ]);
      const ipcRequest = await extension.readNext();
      expect(ipcRequest).toMatchObject({
        sessionId: "session-1",
        type: "capsule",
        payload: { requestId: expect.any(String) },
      });
      const requestId = (ipcRequest.payload as { requestId: string }).requestId;
      await extension.send({
        sessionId: "session-1",
        type: "capsule",
        payload: {
          requestId,
          supported: true,
          capsule: { objective: "Host-generated brief", maxPayloadBytes: 32 * 1024 },
        },
      });

      await expect(capsuleRequest).resolves.toMatchObject([
        {
          payload: {
            operation: "capsule",
            requestId,
            supported: true,
            capsule: { objective: "Host-generated brief" },
          },
        },
      ]);
    } finally {
      attachConnection?.close(0n, []);
      await closeEndpoint(client);
      await extension.close();
      await daemon.close();
    }
  }, 30_000);

  it("reports capsule support explicitly when the session extension is older", async () => {
    const root = await tempRoot();
    const daemon = await startRemoteDaemon({ remoteRoot: root, pairingCode: "123-456" });
    const extension = await connectIpcExtension(daemon.socketPath, {
      sessionId: "session-1",
      name: "Older session",
      cwd: "/repo",
    });
    const client = await bindEndpoint();

    try {
      await daemon.ipc.waitForSession("session-1");
      await armPairing(daemon.socketPath);
      const responses = await exchange(client, daemon.ticket, [
        { sessionId: null, type: "pair", payload: { code: "123-456" } },
        {
          sessionId: null,
          type: "list",
          payload: { operation: "capsule", sessionId: "session-1" },
        },
      ]);

      expect(responses).toMatchObject([
        { payload: { paired: true } },
        {
          payload: {
            operation: "capsule",
            supported: false,
            capability: "context-capsule-v1",
          },
        },
      ]);
      expect(extension.receivedCount()).toBe(0);
    } finally {
      await closeEndpoint(client);
      await extension.close();
      await daemon.close();
    }
  }, 30_000);

  it("rejects pairing unless the window is armed and limits attempts per connection", async () => {
    const root = await tempRoot();
    const daemon = await startRemoteDaemon({ remoteRoot: root, pairingCode: "123-456" });
    const client = await bindEndpoint();

    try {
      await expect(
        exchange(client, daemon.ticket, [
          { sessionId: null, type: "pair", payload: { code: "123-456" } },
        ]),
      ).resolves.toEqual([]);

      await armPairing(daemon.socketPath);
      await expect(
        exchange(client, daemon.ticket, [
          { sessionId: null, type: "pair", payload: { code: "000-000" } },
          { sessionId: null, type: "pair", payload: { code: "123-456" } },
        ]),
      ).resolves.toEqual([]);

      await expect(
        exchange(client, daemon.ticket, [
          { sessionId: null, type: "pair", payload: { code: "123-456" } },
        ]),
      ).resolves.toEqual([{ sessionId: null, type: "pair", payload: { paired: true } }]);
    } finally {
      await closeEndpoint(client);
      await daemon.close();
    }
  }, 30_000);

  it("creates the daemon socket in an owner-only directory with owner-only access", async () => {
    const root = join(await tempRoot(), "remote");
    const daemon = await startRemoteDaemon({ remoteRoot: root, pairingCode: "123-456" });

    try {
      expect((await stat(root)).mode & 0o777).toBe(0o700);
      expect((await stat(daemon.socketPath)).mode & 0o777).toBe(0o600);
    } finally {
      await daemon.close();
    }
  }, 30_000);

  it("refuses a pre-existing socket directory that other users can access", async () => {
    const root = await tempRoot();
    await chmod(root, 0o755);

    await expect(startRemoteDaemon({ remoteRoot: root, pairingCode: "123-456" })).rejects.toThrow(
      "grants access to other users",
    );

    expect((await stat(root)).mode & 0o777).toBe(0o755);
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

  it("reclaims a stale daemon socket from a crashed prior process", async () => {
    const root = await tempRoot();
    const socketPath = join(root, "daemon.sock");
    await leaveStaleSocket(socketPath);

    const daemon = await startRemoteDaemon({ remoteRoot: root, pairingCode: "123-456" });

    try {
      const socket = await connectSocket(socketPath);
      socket.destroy();
    } finally {
      await daemon.close();
    }
  }, 30_000);

  it("reclaims a regular file at the daemon socket path", async () => {
    const root = await tempRoot();
    const socketPath = join(root, "daemon.sock");
    await writeFile(socketPath, "");

    const daemon = await startRemoteDaemon({ remoteRoot: root, pairingCode: "123-456" });

    try {
      const socket = await connectSocket(socketPath);
      socket.destroy();
    } finally {
      await daemon.close();
    }
  }, 30_000);

  it("rejects a second live instance without disrupting the running daemon", async () => {
    const root = await tempRoot();
    const socketPath = join(root, "daemon.sock");
    const daemon = await startRemoteDaemon({ remoteRoot: root, pairingCode: "123-456" });

    try {
      await expect(startRemoteDaemon({ remoteRoot: root, pairingCode: "123-456" })).rejects.toThrow(
        "remote daemon is already running",
      );
      const socket = await connectSocket(socketPath);
      socket.destroy();
    } finally {
      await daemon.close();
    }
  }, 30_000);

  it("detaches a streaming session when the remote connection closes", async () => {
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
      await armPairing(daemon.socketPath);
      const addr = EndpointTicket.fromString(daemon.ticket).endpointAddr();
      const connection = await connectEndpoint(client, addr);
      const stream = await openStream(connection);
      await sendEnvelope(stream, { sessionId: null, type: "pair", payload: { code: "123-456" } });
      await sendEnvelope(stream, {
        sessionId: null,
        type: "attach",
        payload: { sessionId: "session-1", stream: true },
      });
      await finishSending(stream);

      await expect(extension.readNext()).resolves.toEqual({
        sessionId: "session-1",
        type: "attach",
        payload: {},
      });
      connection.close(0n, []);

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
      await armPairing(daemon.socketPath);

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

  it("keeps accepting after a malformed iroh connection", async () => {
    const root = await tempRoot();
    const daemon = await startRemoteDaemon({ remoteRoot: root, pairingCode: "123-456" });
    const badClient = await bindEndpoint();
    const goodClient = await bindEndpoint();

    try {
      await dialWrongAlpn(badClient, daemon.ticket);
      await armPairing(daemon.socketPath);

      await expect(
        exchange(goodClient, daemon.ticket, [
          { sessionId: null, type: "pair", payload: { code: "123-456" } },
          { sessionId: null, type: "list", payload: {} },
        ]),
      ).resolves.toEqual([
        { sessionId: null, type: "pair", payload: { paired: true } },
        { sessionId: null, type: "list", payload: [] },
      ]);
    } finally {
      await closeEndpoint(goodClient);
      await closeEndpoint(badClient);
      await daemon.close();
    }
  }, 30_000);

  it("forwards session_ended to streaming attaches before closing", async () => {
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
      await armPairing(daemon.socketPath);
      const responses = exchange(client, daemon.ticket, [
        { sessionId: null, type: "pair", payload: { code: "123-456" } },
        { sessionId: null, type: "attach", payload: { sessionId: "session-1", stream: true } },
      ]);

      await expect(extension.readNext()).resolves.toEqual({
        sessionId: "session-1",
        type: "attach",
        payload: {},
      });
      await extension.send({ sessionId: "session-1", type: "session_shutdown", payload: {} });

      await expect(responses).resolves.toEqual([
        { sessionId: null, type: "pair", payload: { paired: true } },
        { sessionId: null, type: "attach", payload: { attached: true, sessionId: "session-1" } },
        { sessionId: null, type: "session_ended", payload: { sessionId: "session-1" } },
      ]);
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
      await armPairing(daemon.socketPath);
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
      await armPairing(daemon.socketPath);
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

  it("returns the daemon's real ticket and pairing code over pairing_info", async () => {
    const root = await tempRoot();
    const daemon = await startRemoteDaemon({ remoteRoot: root, pairingCode: "123-456" });

    try {
      const extension = await connectIpcExtension(daemon.socketPath, {
        sessionId: "session-1",
        name: "Work session",
        cwd: "/repo",
      });
      await daemon.ipc.waitForSession("session-1");

      await extension.send({ sessionId: null, type: "pairing_info", payload: {} });

      await expect(extension.readNext()).resolves.toEqual({
        sessionId: null,
        type: "pairing_info",
        payload: { ticket: daemon.ticket, code: "123-456" },
      });
      await extension.close();
    } finally {
      await daemon.close();
    }
  }, 30_000);

  it("writes persisted remote credentials with owner-only permissions", async () => {
    const root = await tempRoot();
    const daemon = await startRemoteDaemon({ remoteRoot: root, pairingCode: "123-456" });
    const client = await bindEndpoint();

    try {
      await armPairing(daemon.socketPath);
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
      await armPairing(daemon.socketPath);
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

async function armPairing(socketPath: string): Promise<PairingInfo> {
  const socket = await connectSocket(socketPath);
  try {
    socket.write(`${JSON.stringify({ sessionId: null, type: "pairing_info", payload: {} })}\n`);
    return await readPairingInfo(socket);
  } finally {
    socket.destroy();
  }
}

function readPairingInfo(socket: Socket): Promise<PairingInfo> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const timeout = setTimeout(() => reject(new Error("timed out reading pairing info")), 2000);
    socket.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      const newline = buffered.indexOf("\n");
      if (newline === -1) return;
      clearTimeout(timeout);
      resolve(pairingInfoFromLine(buffered.slice(0, newline)));
    });
    socket.once("error", reject);
  });
}

function pairingInfoFromLine(line: string): PairingInfo {
  const envelope = JSON.parse(line) as { payload: unknown };
  if (isPairingInfo(envelope.payload)) return envelope.payload;
  throw new Error(`daemon returned invalid pairing info: ${line}`);
}

function isPairingInfo(payload: unknown): payload is PairingInfo {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "ticket" in payload &&
    "code" in payload &&
    typeof payload.ticket === "string" &&
    typeof payload.code === "string"
  );
}

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

async function dialWrongAlpn(
  client: Awaited<ReturnType<typeof bindEndpoint>>,
  ticket: string,
): Promise<void> {
  const addr = EndpointTicket.fromString(ticket).endpointAddr();
  const wrongAlpn = Array.from(Buffer.from("pi/remote/wrong", "utf8"));
  await client.connect(addr, wrongAlpn).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 100));
}

async function leaveStaleSocket(socketPath: string): Promise<void> {
  const child = spawn(process.execPath, ["-e", STALE_SOCKET_PROCESS, socketPath], {
    stdio: "ignore",
  });
  try {
    const socket = await waitForSocket(socketPath);
    socket.destroy();
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }

  child.kill("SIGKILL");
  await waitForExit(child);
  await stat(socketPath);
}

async function waitForSocket(socketPath: string): Promise<Socket> {
  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await connectSocket(socketPath);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

function connectSocket(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
}

const STALE_SOCKET_PROCESS = `
const net = require("node:net");
const server = net.createServer();
server.listen(process.argv[1]);
setInterval(() => undefined, 1000);
`;
