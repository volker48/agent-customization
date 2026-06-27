import { mkdtemp, rm } from "node:fs/promises";
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

describe("remote daemon readiness", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    vi.doUnmock("../pi-extensions/remote/iroh-transport.js");
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
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
