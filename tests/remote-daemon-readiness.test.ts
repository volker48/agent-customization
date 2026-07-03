import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { connectIpcExtension } from "../pi-extensions/remote/ipc.js";

type EndpointStub = { id(): { toString(): string } };

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-remote-daemon-readiness-"));
  roots.push(root);
  return root;
}

function controlledEndpoint() {
  let resolve!: (endpoint: EndpointStub) => void;
  const promise = new Promise<EndpointStub>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function endpointStub(): EndpointStub {
  return { id: () => ({ toString: () => "daemon-node-id" }) };
}

function controlledConnection(nodeId: string) {
  let resolveAccepted!: () => void;
  let resolveClosed!: () => void;
  const connection = {
    close: vi.fn(() => resolveClosed()),
    closed: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveClosed = resolve;
        }),
    ),
    remoteId: () => ({ toString: () => nodeId }),
  };
  const promise = new Promise<typeof connection>((resolve) => {
    resolveAccepted = () => resolve(connection);
  });
  return { connection, promise, resolve: resolveAccepted, close: () => resolveClosed() };
}

describe("remote daemon readiness", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    vi.doUnmock("../pi-extensions/remote/iroh-transport.js");
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("closes silent unauthenticated streams after the read timeout", async () => {
    vi.useFakeTimers();
    const connection = {
      close: vi.fn(),
      closed: vi.fn(() => new Promise(() => {})),
      remoteId: () => ({ toString: () => "peer-node-id" }),
    };
    const stream = {};
    const acceptConnection = vi
      .fn()
      .mockResolvedValueOnce(connection)
      .mockReturnValue(new Promise(() => {}));
    const finishSending = vi.fn(() => Promise.resolve());
    const receiveEnvelopes = vi.fn(() => new Promise(() => {}));
    vi.doMock("../pi-extensions/remote/iroh-transport.js", () => ({
      acceptConnection,
      acceptStream: vi.fn(() => Promise.resolve(stream)),
      bindEndpoint: vi.fn(() => Promise.resolve(endpointStub())),
      closeEndpoint: vi.fn(),
      endpointTicket: vi.fn(() => "ticket-ready"),
      finishSending,
      receiveEnvelopes,
      sendEnvelope: vi.fn(),
    }));

    const root = await tempRoot();
    const { startRemoteDaemon } = await import("../pi-extensions/remote/daemon.js");
    const daemon = await startRemoteDaemon({ remoteRoot: root, pairingCode: "123-456" });

    try {
      await flushMicrotasks();
      expect(receiveEnvelopes).toHaveBeenCalledWith(stream);

      await vi.advanceTimersByTimeAsync(30_000);
      await flushMicrotasks();

      expect(connection.close).toHaveBeenCalled();
      expect(finishSending).toHaveBeenCalledWith(stream);
    } finally {
      await daemon.close();
      vi.useRealTimers();
    }
  });

  it("detaches only after the last streaming connection for a session closes", async () => {
    const first = controlledConnection("node-a");
    const second = controlledConnection("node-b");
    const firstStream = {};
    const secondStream = {};
    const acceptConnection = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
      .mockReturnValue(new Promise(() => {}));
    vi.doMock("../pi-extensions/remote/iroh-transport.js", () => ({
      acceptConnection,
      acceptStream: vi.fn((connection) =>
        Promise.resolve(connection === first.connection ? firstStream : secondStream),
      ),
      bindEndpoint: vi.fn(() => Promise.resolve(endpointStub())),
      closeEndpoint: vi.fn(),
      endpointTicket: vi.fn(() => "ticket-ready"),
      finishSending: vi.fn(() => Promise.resolve()),
      receiveEnvelopes: vi.fn(() =>
        Promise.resolve([
          {
            sessionId: null,
            type: "attach",
            payload: { sessionId: "session-1", stream: true },
          },
        ]),
      ),
      sendEnvelope: vi.fn(() => Promise.resolve()),
    }));

    const root = await tempRoot();
    await writeFile(join(root, "allowed-node-ids.json"), JSON.stringify(["node-a", "node-b"]));
    const { startRemoteDaemon } = await import("../pi-extensions/remote/daemon.js");
    const daemon = await startRemoteDaemon({ remoteRoot: root, pairingCode: "123-456" });
    const extension = await connectIpcExtension(daemon.socketPath, {
      sessionId: "session-1",
      name: "Work session",
      cwd: "/repo",
    });

    try {
      await daemon.ipc.waitForSession("session-1");
      first.resolve();
      await expect(extension.readNext()).resolves.toMatchObject({ type: "attach" });
      second.resolve();
      await expect(extension.readNext()).resolves.toMatchObject({ type: "attach" });

      first.close();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(extension.receivedCount()).toBe(0);
      second.close();

      await expect(extension.readNext()).resolves.toEqual({
        sessionId: "session-1",
        type: "detach",
        payload: {},
      });
    } finally {
      await extension.close();
      await daemon.close();
    }
  });

  it("does not open IPC before the endpoint ticket is ready", async () => {
    const endpoint = controlledEndpoint();
    vi.doMock("../pi-extensions/remote/iroh-transport.js", () => ({
      acceptConnection: vi.fn(() => new Promise(() => {})),
      acceptStream: vi.fn(),
      bindEndpoint: vi.fn(() => endpoint.promise),
      closeEndpoint: vi.fn(),
      endpointTicket: vi.fn(() => "ticket-ready"),
      finishSending: vi.fn(),
      receiveEnvelopes: vi.fn(),
      sendEnvelope: vi.fn(),
    }));

    const root = await tempRoot();
    const socketPath = join(root, "daemon.sock");
    const { startRemoteDaemon } = await import("../pi-extensions/remote/daemon.js");
    const starting = startRemoteDaemon({ remoteRoot: root, pairingCode: "123-456", socketPath });

    await new Promise((resolve) => setTimeout(resolve, 25));
    await expect(canConnect(socketPath)).resolves.toBe(false);

    endpoint.resolve(endpointStub());
    const daemon = await starting;
    const extension = await connectIpcExtension(socketPath, {
      sessionId: "session-1",
      name: "Work session",
      cwd: "/repo",
    });

    try {
      await extension.send({ sessionId: null, type: "pairing_info", payload: {} });

      await expect(extension.readNext()).resolves.toEqual({
        sessionId: null,
        type: "pairing_info",
        payload: { ticket: "ticket-ready", code: "123-456" },
      });
    } finally {
      await extension.close();
      await daemon.close();
    }
  });
});

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

function canConnect(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}
