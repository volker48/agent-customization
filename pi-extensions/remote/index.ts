import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { defaultRemoteRoot } from "./authorization.js";
import { connectIpcExtension, type IpcEnvelope, type IpcExtensionClient } from "./ipc.js";
import { projectTranscriptEvent, projectTranscriptMessage } from "./transcript-projection.js";

const DAEMON_SOCKET_FILE = "daemon.sock";
const LIVE_EVENT_TYPES = [
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "turn_start",
  "turn_end",
  "agent_end",
] as const;

type LiveEventType = (typeof LIVE_EVENT_TYPES)[number];
type RemoteState = {
  client: IpcExtensionClient;
  sessionId: string;
  ctx: ExtensionContext;
  attached: boolean;
  desiredAttached: boolean;
  backfilling: boolean;
  pendingLiveEvents: unknown[];
  closed: boolean;
};

export default function remoteExtension(pi: ExtensionAPI): void {
  let state: RemoteState | undefined;

  pi.registerCommand("remote", {
    description: "Expose this Pi session to the remote daemon",
    handler: async (args, ctx) => {
      const action = args.trim();
      if (action === "status") {
        await showStatus(ctx, socketPath());
        return;
      }
      if (action === "stop") {
        await stopDaemon(ctx, socketPath());
        return;
      }

      if (state && !state.closed) {
        await shutdownState(state);
      }

      const sessionId = ctx.sessionManager.getSessionId();
      const client = await connectOrSpawn(socketPath(), {
        sessionId,
        name: sessionName(pi, ctx),
        cwd: ctx.cwd,
      });
      state = {
        client,
        sessionId,
        ctx,
        attached: false,
        desiredAttached: false,
        backfilling: false,
        pendingLiveEvents: [],
        closed: false,
      };
      void readInbound(pi, state);
      ctx.ui.notify("Remote session registered", "info");
    },
  });

  const onLiveEvent = pi.on as (
    event: LiveEventType,
    handler: (
      event: Parameters<typeof projectTranscriptEvent>[0],
      ctx: ExtensionContext,
    ) => Promise<void>,
  ) => void;
  for (const eventType of LIVE_EVENT_TYPES) {
    onLiveEvent(eventType, async (event, ctx) => {
      if (!state || state.closed) {
        return;
      }
      state.ctx = ctx;
      const payload = projectTranscriptEvent(event);
      if (state.backfilling) {
        if (state.desiredAttached) {
          state.pendingLiveEvents.push(payload);
        }
        return;
      }
      if (!state.attached) {
        return;
      }
      await state.client.send({ sessionId: state.sessionId, type: "event", payload });
    });
  }

  pi.on("session_shutdown", async (_event, _ctx) => {
    if (!state || state.closed) {
      return;
    }
    await shutdownState(state);
  });
}

async function connectOrSpawn(
  path: string,
  registration: Parameters<typeof connectIpcExtension>[1],
): Promise<IpcExtensionClient> {
  try {
    return await connectIpcExtension(path, registration);
  } catch (error) {
    if (!isMissingSocket(error)) {
      throw error;
    }
  }

  spawnDaemon();
  await waitForDaemon(path);
  return connectIpcExtension(path, registration);
}

async function readInbound(pi: ExtensionAPI, state: RemoteState): Promise<void> {
  try {
    while (!state.closed) {
      const envelope = await state.client.readNext();
      if (envelope.type === "attach") {
        void applyInbound(pi, state, envelope).catch((error) => handleInboundError(state, error));
        continue;
      }
      await applyInbound(pi, state, envelope);
    }
  } catch (error) {
    handleInboundError(state, error);
  }
}

async function applyInbound(
  pi: ExtensionAPI,
  state: RemoteState,
  envelope: IpcEnvelope,
): Promise<void> {
  if (envelope.type === "attach") {
    state.desiredAttached = true;
    state.attached = false;
    state.backfilling = true;
    state.pendingLiveEvents = [];
    await sendBackfill(state);
    await allowInboundFrames();
    if (!state.desiredAttached) {
      state.pendingLiveEvents = [];
      state.backfilling = false;
      return;
    }
    await flushPendingLiveEvents(state);
    state.backfilling = false;
    state.attached = state.desiredAttached;
    return;
  }
  if (envelope.type === "detach") {
    state.desiredAttached = false;
    state.attached = false;
    state.pendingLiveEvents = [];
    return;
  }
  if (envelope.type === "prompt") {
    pi.sendUserMessage(promptText(envelope.payload), { deliverAs: "steer" });
    return;
  }
  if (envelope.type === "abort") {
    state.ctx.abort();
  }
}

async function sendBackfill(state: RemoteState): Promise<void> {
  for (const entry of state.ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") {
      continue;
    }
    await state.client.send({
      sessionId: state.sessionId,
      type: "event",
      payload: projectTranscriptMessage(entry.message),
    });
  }
}

async function allowInboundFrames(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function flushPendingLiveEvents(state: RemoteState): Promise<void> {
  while (state.desiredAttached && state.pendingLiveEvents.length > 0) {
    const payload = state.pendingLiveEvents.shift();
    if (payload) {
      await state.client.send({ sessionId: state.sessionId, type: "event", payload });
    }
  }
}

async function shutdownState(state: RemoteState): Promise<void> {
  state.closed = true;
  await state.client.send({ sessionId: state.sessionId, type: "session_shutdown", payload: {} });
  await state.client.close();
}

function handleInboundError(state: RemoteState, error: unknown): void {
  if (!state.closed) {
    state.closed = true;
    state.ctx.ui.notify(`Remote inbound failed: ${errorMessage(error)}`, "error");
  }
}

async function showStatus(ctx: ExtensionContext, path: string): Promise<void> {
  try {
    const response = await requestDaemon(path, { sessionId: null, type: "list", payload: {} });
    const count = Array.isArray(response.payload) ? response.payload.length : 0;
    ctx.ui.notify(`Remote daemon running (${count} session${count === 1 ? "" : "s"})`, "info");
  } catch (error) {
    if (!isMissingSocket(error)) {
      throw error;
    }
    ctx.ui.notify("Remote daemon is not running", "info");
  }
}

async function stopDaemon(ctx: ExtensionContext, path: string): Promise<void> {
  try {
    await requestDaemon(path, { sessionId: null, type: "daemon_stop", payload: {} });
    ctx.ui.notify("Remote daemon stop requested", "info");
  } catch (error) {
    if (!isMissingSocket(error)) {
      throw error;
    }
    ctx.ui.notify("Remote daemon is not running", "info");
  }
}

function requestDaemon(path: string, envelope: IpcEnvelope): Promise<IpcEnvelope> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let buffered = "";
    let settled = false;
    let timeout: NodeJS.Timeout;
    const cleanup = () => {
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
    };
    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      cleanup();
      reject(error);
    };
    const succeed = (response: IpcEnvelope) => {
      if (settled) {
        return;
      }
      cleanup();
      resolve(response);
    };
    timeout = setTimeout(() => fail(new Error("remote daemon request timed out")), 2_000);

    socket.once("connect", () => socket.write(`${JSON.stringify(envelope)}\n`));
    socket.once("error", fail);
    socket.once("close", () => fail(new Error("remote daemon closed before responding")));
    socket.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      const newline = buffered.indexOf("\n");
      if (newline === -1) {
        return;
      }
      try {
        succeed(JSON.parse(buffered.slice(0, newline)) as IpcEnvelope);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

async function waitForDaemon(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await canConnect(path)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("remote daemon did not start");
}

function canConnect(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    socket.once("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

function spawnDaemon(): void {
  const entry = join(dirname(fileURLToPath(import.meta.url)), "daemon-entry.ts");
  spawn("tsx", [entry], { detached: true, stdio: "ignore" })
    .on("error", (error) => {
      console.error(`[remote] failed to spawn daemon: ${error.message}`);
    })
    .unref();
}

function socketPath(): string {
  return join(process.env.PI_REMOTE_ROOT ?? defaultRemoteRoot(), DAEMON_SOCKET_FILE);
}

function sessionName(pi: ExtensionAPI, ctx: ExtensionContext): string {
  return (
    pi.getSessionName() ?? ctx.sessionManager.getSessionName() ?? ctx.sessionManager.getSessionId()
  );
}

function promptText(payload: unknown): string {
  if (typeof payload === "object" && payload !== null && "text" in payload) {
    return typeof payload.text === "string" ? payload.text : "";
  }
  return typeof payload === "string" ? payload : "";
}

function isMissingSocket(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ECONNREFUSED" || error.code === "ENOTSOCK")
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
