import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EndpointTicket } from "@number0/iroh/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import remoteExtension from "../pi-extensions/remote/index.js";
import { startRemoteDaemon, type RemoteDaemon } from "../pi-extensions/remote/daemon.js";
import {
  bindEndpoint,
  closeEndpoint,
  connectEndpoint,
  finishSending,
  openStream,
  receiveEnvelopes,
  sendEnvelope,
  type RemoteBiStream,
  type RemoteEndpoint,
} from "../pi-extensions/remote/iroh-transport.js";
import type { Envelope } from "../pi-extensions/remote/protocol.js";

const runE2E = process.env.REMOTE_E2E === "1";
const describeIf = runE2E ? describe : describe.skip;
const handlers = new Map<string, (event: unknown, ctx: MockContext) => void | Promise<void>>();

type RegisteredCommand = { handler(args: string, ctx: MockContext): Promise<void> };
type MockContext = ReturnType<typeof createContext>;

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
      getSessionName: vi.fn(() => "Remote E2E"),
      sendUserMessage: vi.fn(),
    },
    command(name: string) {
      const command = commands.get(name);
      if (!command) throw new Error(`missing command: ${name}`);
      return command;
    },
  };
}

function createContext() {
  return {
    cwd: "/tmp/remote-e2e",
    abort: vi.fn(),
    ui: { notify: vi.fn() },
    sessionManager: {
      getSessionId: vi.fn(() => "session-1"),
      getSessionName: vi.fn(() => undefined),
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

describeIf("remote extension e2e", () => {
  let root = "";
  let originalRoot: string | undefined;
  let daemon: RemoteDaemon | undefined;
  let client: RemoteEndpoint | undefined;

  beforeEach(async () => {
    vi.restoreAllMocks();
    handlers.clear();
    originalRoot = process.env.PI_REMOTE_ROOT;
    root = await mkdtemp(join(tmpdir(), "pi-remote-e2e-"));
    process.env.PI_REMOTE_ROOT = root;
  });

  afterEach(async () => {
    process.env.PI_REMOTE_ROOT = originalRoot;
    if (client) await closeEndpoint(client);
    if (daemon) await daemon.close();
    await rm(root, { recursive: true, force: true });
  });

  it("pairs, lists, attaches, streams, prompts, and aborts end-to-end", async () => {
    daemon = await startRemoteDaemon({ remoteRoot: root, pairingCode: "123-456" });
    client = await bindEndpoint();
    const { pi, command } = createPi();
    const ctx = createContext();

    remoteExtension(pi as never);
    await command("remote").handler("", ctx);
    await daemon.ipc.waitForSession("session-1");

    await expect(exchange(client, daemon.ticket, [pairFrame()])).resolves.toEqual([
      { sessionId: null, type: "pair", payload: { paired: true } },
    ]);
    await expect(exchange(client, daemon.ticket, [listFrame()])).resolves.toEqual([
      {
        sessionId: null,
        type: "list",
        payload: [{ sessionId: "session-1", name: "Remote E2E", cwd: "/tmp/remote-e2e" }],
      },
    ]);

    const attach = await openRemoteStream(client, daemon.ticket, {
      sessionId: null,
      type: "attach",
      payload: { sessionId: "session-1", stream: true },
    });
    await expect(attach.readUntil((frame) => frame.type === "attach")).resolves.toMatchObject({
      payload: { attached: true, sessionId: "session-1" },
    });
    await expect(attach.readUntil((frame) => hasText(frame, "hello"))).resolves.toBeDefined();
    await expect(attach.readUntil((frame) => hasText(frame, "hi"))).resolves.toBeDefined();

    await handlers.get("message_end")?.(
      { type: "message_end", message: { role: "assistant", content: "live" } },
      ctx,
    );
    await expect(attach.readUntil((frame) => hasText(frame, "live"))).resolves.toBeDefined();

    await exchange(client, daemon.ticket, [
      { sessionId: "session-1", type: "prompt", payload: { text: "keep going" } },
    ]);
    await waitFor(() =>
      expect(pi.sendUserMessage).toHaveBeenCalledWith("keep going", { deliverAs: "steer" }),
    );

    await exchange(client, daemon.ticket, [{ sessionId: "session-1", type: "abort", payload: {} }]);
    await waitFor(() => expect(ctx.abort).toHaveBeenCalled());
  }, 60_000);
});

async function exchange(
  client: RemoteEndpoint,
  ticket: string,
  frames: Envelope[],
): Promise<Envelope[]> {
  const stream = await openRemoteStream(client, ticket, ...frames);
  return receiveEnvelopes(stream.stream);
}

async function openRemoteStream(client: RemoteEndpoint, ticket: string, ...frames: Envelope[]) {
  const addr = EndpointTicket.fromString(ticket).endpointAddr();
  const connection = await connectEndpoint(client, addr);
  const stream = await openStream(connection);
  for (const frame of frames) await sendEnvelope(stream, frame);
  await finishSending(stream);
  return new FrameReader(stream);
}

class FrameReader {
  #buffer = "";

  constructor(readonly stream: RemoteBiStream) {}

  async readUntil(predicate: (frame: Envelope) => boolean): Promise<Envelope> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const frame = await this.readNext();
      if (predicate(frame)) return frame;
    }
    throw new Error("timed out waiting for remote frame");
  }

  async readNext(): Promise<Envelope> {
    while (!this.#buffer.includes("\n")) {
      const chunk = await this.stream.recv.read(1024 * 1024);
      if (chunk.length === 0) throw new Error("remote stream ended before the next frame");
      this.#buffer += Buffer.from(chunk).toString("utf8");
    }
    const newline = this.#buffer.indexOf("\n");
    const line = this.#buffer.slice(0, newline);
    this.#buffer = this.#buffer.slice(newline + 1);
    return JSON.parse(line) as Envelope;
  }
}

function pairFrame(): Envelope {
  return { sessionId: null, type: "pair", payload: { code: "123-456" } };
}

function listFrame(): Envelope {
  return { sessionId: null, type: "list", payload: {} };
}

function hasText(frame: Envelope, text: string): boolean {
  return (
    typeof frame.payload === "object" &&
    frame.payload !== null &&
    "text" in frame.payload &&
    frame.payload.text === text
  );
}

async function waitFor(assertion: () => void): Promise<void> {
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
