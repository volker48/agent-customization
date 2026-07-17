import { unlink } from "node:fs/promises";
import { createServer, createConnection, type Server, type Socket } from "node:net";

import { decodeFrames, type MessageType } from "./protocol.js";

export type IpcMessageType =
  | MessageType
  | "register"
  | "session_shutdown"
  | "daemon_stop"
  | "sync"
  | "pairing_info"
  | "capsule";

export type PairingInfo = { ticket: string; code: string };

export type IpcEnvelope = {
  sessionId: string | null;
  type: IpcMessageType;
  payload: unknown;
};

export type SessionRegistration = {
  sessionId: string;
  name: string;
  cwd: string;
  capabilities?: string[];
};

export type SessionRegistryEntry = {
  name: string;
  cwd: string;
  capabilities: string[];
  socket: Socket;
  generation: number;
};

export type IpcRequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type IpcDaemonServer = {
  registry: Map<string, SessionRegistryEntry>;
  sendToSession(envelope: IpcEnvelope): Promise<void>;
  requestFromSession(envelope: IpcEnvelope, options?: IpcRequestOptions): Promise<IpcEnvelope>;
  subscribe(listener: (envelope: IpcEnvelope) => void): () => void;
  waitForSession(sessionId: string): Promise<SessionRegistryEntry>;
  waitForSessionEnd(sessionId: string): Promise<void>;
  close(): Promise<void>;
};

export type IpcExtensionClient = {
  send(envelope: IpcEnvelope): Promise<void>;
  readNext(): Promise<IpcEnvelope>;
  receivedCount(): number;
  close(): Promise<void>;
};

export type IpcDaemonOptions = {
  onControlFrame?: (envelope: IpcEnvelope) => void;
  onFrame?: (envelope: IpcEnvelope) => void;
  onStop?: () => void | Promise<void>;
  getPairingInfo?: () => PairingInfo | undefined;
};

type Waiter<T> = {
  resolve(value: T): void;
  reject(error: Error): void;
};

type DaemonState = {
  registry: Map<string, SessionRegistryEntry>;
  sessionWaiters: Map<string, Waiter<SessionRegistryEntry>[]>;
  endWaiters: Map<string, Waiter<void>[]>;
  sockets: Set<Socket>;
  listeners: Set<(envelope: IpcEnvelope) => void>;
  requestWaiters: Map<
    string,
    { socket: Socket; generation: number; waiter: Waiter<IpcEnvelope>; cleanup(): void }
  >;
  nextGeneration: number;
};

export async function startIpcDaemonServer(
  socketPath: string,
  options: IpcDaemonOptions = {},
): Promise<IpcDaemonServer> {
  const state: DaemonState = {
    registry: new Map(),
    sessionWaiters: new Map(),
    endWaiters: new Map(),
    sockets: new Set(),
    listeners: new Set(),
    requestWaiters: new Map(),
    nextGeneration: 1,
  };
  const server = createServer((socket) => acceptDaemonSocket(socket, state, options));

  await listen(server, socketPath);

  return createDaemonFacade(server, state);
}

export async function connectIpcExtension(
  socketPath: string,
  registration: SessionRegistration,
): Promise<IpcExtensionClient> {
  const socket = createConnection(socketPath);
  const incoming: IpcEnvelope[] = [];
  const readers: Waiter<IpcEnvelope>[] = [];
  let buffered = "";

  socket.on("data", (chunk) => {
    const parsed = parseBufferedFrames(buffered + chunk.toString("utf8"));
    buffered = parsed.remaining;
    for (const envelope of parsed.envelopes) {
      const reader = readers.shift();
      if (reader) {
        reader.resolve(envelope);
      } else {
        incoming.push(envelope);
      }
    }
  });

  await onceConnect(socket);
  socket.on("error", (error) => rejectWaiters(readers, error));
  socket.on("close", () => {
    rejectWaiters(readers, new Error("IPC extension socket closed before receiving a frame"));
  });
  await writeEnvelope(socket, { sessionId: null, type: "register", payload: registration });

  return {
    send(envelope) {
      return writeEnvelope(socket, envelope);
    },
    readNext() {
      const next = incoming.shift();
      return next ? Promise.resolve(next) : addReader(readers);
    },
    receivedCount() {
      return incoming.length;
    },
    close() {
      return closeSocket(socket);
    },
  };
}

function acceptDaemonSocket(socket: Socket, state: DaemonState, options: IpcDaemonOptions): void {
  state.sockets.add(socket);
  let buffered = "";

  socket.on("data", (chunk) => {
    const parsed = parseBufferedFrames(buffered + chunk.toString("utf8"));
    buffered = parsed.remaining;
    for (const envelope of parsed.envelopes) {
      void handleReceivedEnvelope(envelope, socket, state, options);
    }
  });
  socket.on("error", () => socket.destroy());
  socket.on("close", () => {
    state.sockets.delete(socket);
    rejectSocketRequests(state, socket, new Error("IPC session socket closed"));
    removeSocketSessions(state, socket, options);
  });
}

function createDaemonFacade(server: Server, state: DaemonState): IpcDaemonServer {
  return {
    registry: state.registry,
    sendToSession(envelope) {
      const entry = state.registry.get(requireSessionId(envelope));
      if (!entry) {
        return Promise.reject(new Error(`IPC session is not registered: ${envelope.sessionId}`));
      }
      return writeEnvelope(entry.socket, envelope);
    },
    requestFromSession(envelope, options = {}) {
      const sessionId = requireSessionId(envelope);
      const requestId = requestIdFrom(envelope.payload);
      if (!requestId) return Promise.reject(new Error("IPC request is missing requestId"));
      const entry = state.registry.get(sessionId);
      if (!entry) {
        return Promise.reject(new Error(`IPC session is not registered: ${envelope.sessionId}`));
      }
      const key = requestKey(sessionId, requestId);
      if (state.requestWaiters.has(key)) {
        return Promise.reject(new Error(`IPC request is already pending: ${key}`));
      }
      if (options.signal?.aborted) return Promise.reject(abortError());
      return new Promise((resolve, reject) => {
        let timeout: NodeJS.Timeout | undefined;
        const onAbort = () => rejectPendingRequest(state, key, abortError());
        const cleanup = () => {
          if (timeout) clearTimeout(timeout);
          options.signal?.removeEventListener("abort", onAbort);
        };
        state.requestWaiters.set(key, {
          socket: entry.socket,
          generation: entry.generation,
          waiter: { resolve, reject },
          cleanup,
        });
        options.signal?.addEventListener("abort", onAbort, { once: true });
        if (options.timeoutMs !== undefined) {
          timeout = setTimeout(
            () => rejectPendingRequest(state, key, new Error("IPC session request timed out")),
            options.timeoutMs,
          );
        }
        void writeEnvelope(entry.socket, envelope).catch((error) => {
          rejectPendingRequest(state, key, error);
        });
      });
    },
    subscribe(listener) {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
    waitForSession(sessionId) {
      const entry = state.registry.get(sessionId);
      return entry ? Promise.resolve(entry) : addWaiter(state.sessionWaiters, sessionId);
    },
    waitForSessionEnd(sessionId) {
      return state.registry.has(sessionId)
        ? addWaiter(state.endWaiters, sessionId)
        : Promise.resolve();
    },
    async close() {
      const error = new Error("IPC daemon closed before session registered");
      rejectWaiterMap(state.sessionWaiters, error);
      rejectWaiterMap(state.endWaiters, error);
      rejectRequestWaiters(state, error);
      for (const socket of state.sockets) {
        socket.destroy();
      }
      await closeServer(server);
    },
  };
}

async function handleReceivedEnvelope(
  envelope: IpcEnvelope,
  socket: Socket,
  state: DaemonState,
  options: IpcDaemonOptions,
): Promise<void> {
  options.onFrame?.(envelope);
  if (resolveRequestWaiter(state, envelope, socket)) return;
  const emitted = await handleDaemonFrame(envelope, socket, state, options);
  state.listeners.forEach((listener) => listener(envelope));
  emitted.forEach((frame) => state.listeners.forEach((listener) => listener(frame)));
  resolveSessionWaiters(envelope, state.registry, state.sessionWaiters);
  resolveEndWaiters(envelope, state.endWaiters);
}

async function handleDaemonFrame(
  envelope: IpcEnvelope,
  socket: Socket,
  state: DaemonState,
  options: IpcDaemonOptions,
): Promise<IpcEnvelope[]> {
  const emitted: IpcEnvelope[] = [];
  const registry = state.registry;
  if (envelope.sessionId !== null) {
    const entry = registry.get(envelope.sessionId);
    if (!entry || entry.socket !== socket) return emitted;
  }
  if (isRegisterEnvelope(envelope)) {
    const existing = registry.get(envelope.payload.sessionId);
    if (existing && existing.socket !== socket) {
      return emitted;
    }
    registry.set(envelope.payload.sessionId, {
      name: envelope.payload.name,
      cwd: envelope.payload.cwd,
      capabilities: envelope.payload.capabilities ?? [],
      socket,
      generation: existing?.generation ?? state.nextGeneration++,
    });
  }

  if (envelope.type === "list" && envelope.sessionId === null) {
    await writeEnvelope(socket, {
      sessionId: null,
      type: "list",
      payload: [...registry.entries()].map(([sessionId, entry]) => ({
        sessionId,
        name: entry.name,
        cwd: entry.cwd,
      })),
    });
  }

  if (envelope.type === "session_shutdown" && envelope.sessionId !== null) {
    rejectSessionRequests(state, envelope.sessionId, new Error("IPC session shut down"));
    registry.delete(envelope.sessionId);
    const frame: IpcEnvelope = {
      sessionId: null,
      type: "session_ended",
      payload: { sessionId: envelope.sessionId },
    };
    options.onControlFrame?.(frame);
    emitted.push(frame);
  }

  if (envelope.type === "sync") {
    await writeEnvelope(socket, envelope);
  }

  if (envelope.type === "daemon_stop" && envelope.sessionId === null) {
    await writeEnvelope(socket, {
      sessionId: null,
      type: "daemon_stop",
      payload: { stopping: true },
    });
    await options.onStop?.();
  }

  if (envelope.type === "pairing_info" && envelope.sessionId === null) {
    await writeEnvelope(socket, {
      sessionId: null,
      type: "pairing_info",
      payload: options.getPairingInfo?.() ?? null,
    });
  }

  return emitted;
}

function requestIdFrom(payload: unknown): string | null {
  return typeof payload === "object" &&
    payload !== null &&
    "requestId" in payload &&
    typeof payload.requestId === "string"
    ? payload.requestId
    : null;
}

function requestKey(sessionId: string, requestId: string): string {
  return `${sessionId}:${requestId}`;
}

function resolveRequestWaiter(state: DaemonState, envelope: IpcEnvelope, socket: Socket): boolean {
  if (envelope.type !== "capsule" || envelope.sessionId === null) return false;
  const requestId = requestIdFrom(envelope.payload);
  if (!requestId) return false;
  const key = requestKey(envelope.sessionId, requestId);
  const pending = state.requestWaiters.get(key);
  const entry = state.registry.get(envelope.sessionId);
  if (!pending || !entry || pending.socket !== socket || pending.generation !== entry.generation) {
    return false;
  }
  state.requestWaiters.delete(key);
  pending.cleanup();
  pending.waiter.resolve(envelope);
  return true;
}

function rejectSocketRequests(state: DaemonState, socket: Socket, error: Error): void {
  for (const [key, pending] of state.requestWaiters) {
    if (pending.socket === socket) {
      state.requestWaiters.delete(key);
      pending.cleanup();
      pending.waiter.reject(error);
    }
  }
}

function rejectSessionRequests(state: DaemonState, sessionId: string, error: Error): void {
  for (const [key, pending] of state.requestWaiters) {
    if (key.startsWith(`${sessionId}:`)) {
      state.requestWaiters.delete(key);
      pending.cleanup();
      pending.waiter.reject(error);
    }
  }
}

function rejectRequestWaiters(state: DaemonState, error: Error): void {
  for (const pending of state.requestWaiters.values()) {
    pending.cleanup();
    pending.waiter.reject(error);
  }
  state.requestWaiters.clear();
}

function rejectPendingRequest(state: DaemonState, key: string, error: Error): void {
  const pending = state.requestWaiters.get(key);
  if (!pending) return;
  state.requestWaiters.delete(key);
  pending.cleanup();
  pending.waiter.reject(error);
}

function abortError(): Error {
  const error = new Error("IPC session request cancelled");
  error.name = "AbortError";
  return error;
}

function removeSocketSessions(state: DaemonState, socket: Socket, options: IpcDaemonOptions): void {
  const sessionIds = [...state.registry]
    .filter(([, entry]) => entry.socket === socket)
    .map(([sessionId]) => sessionId);
  for (const sessionId of sessionIds) {
    state.registry.delete(sessionId);
    const frame: IpcEnvelope = {
      sessionId: null,
      type: "session_ended",
      payload: { sessionId },
    };
    options.onControlFrame?.(frame);
    state.listeners.forEach((listener) => listener(frame));
    const waiters = state.endWaiters.get(sessionId) ?? [];
    waiters.forEach((waiter) => waiter.resolve());
    state.endWaiters.delete(sessionId);
  }
}

function parseBufferedFrames(input: string): { envelopes: IpcEnvelope[]; remaining: string } {
  const lastBreak = input.lastIndexOf("\n");
  if (lastBreak === -1) {
    return { envelopes: [], remaining: input };
  }

  const lines = input.slice(0, lastBreak).split("\n");
  return {
    envelopes: lines.flatMap(parseFrameLine),
    remaining: input.slice(lastBreak + 1),
  };
}

function parseFrameLine(line: string): IpcEnvelope[] {
  try {
    return decodeFrames(line) as IpcEnvelope[];
  } catch {
    return [];
  }
}

function resolveSessionWaiters(
  envelope: IpcEnvelope,
  registry: Map<string, SessionRegistryEntry>,
  waiters: Map<string, Waiter<SessionRegistryEntry>[]>,
): void {
  if (!isRegisterEnvelope(envelope)) {
    return;
  }

  const sessionWaiters = waiters.get(envelope.payload.sessionId) ?? [];
  const entry = registry.get(envelope.payload.sessionId);
  if (entry) {
    sessionWaiters.forEach((waiter) => waiter.resolve(entry));
    waiters.delete(envelope.payload.sessionId);
  }
}

function resolveEndWaiters(envelope: IpcEnvelope, waiters: Map<string, Waiter<void>[]>): void {
  if (envelope.type !== "session_shutdown" || envelope.sessionId === null) {
    return;
  }

  const sessionWaiters = waiters.get(envelope.sessionId) ?? [];
  sessionWaiters.forEach((waiter) => waiter.resolve());
  waiters.delete(envelope.sessionId);
}

function isRegisterEnvelope(
  envelope: IpcEnvelope,
): envelope is IpcEnvelope & { payload: SessionRegistration } {
  const payload = envelope.payload;
  return (
    envelope.sessionId === null &&
    envelope.type === "register" &&
    typeof payload === "object" &&
    payload !== null &&
    "sessionId" in payload &&
    "name" in payload &&
    "cwd" in payload &&
    typeof payload.sessionId === "string" &&
    typeof payload.name === "string" &&
    typeof payload.cwd === "string" &&
    (!("capabilities" in payload) ||
      (Array.isArray(payload.capabilities) &&
        payload.capabilities.every((capability) => typeof capability === "string")))
  );
}

function writeEnvelope(socket: Socket, envelope: IpcEnvelope): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(`${JSON.stringify(envelope)}\n`, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function listen(server: Server, socketPath: string): Promise<void> {
  try {
    await listenOnce(server, socketPath);
    return;
  } catch (error) {
    if (!isAddressInUse(error)) {
      throw error;
    }
  }

  if (await canConnect(socketPath)) {
    throw new Error("remote daemon is already running");
  }

  await unlink(socketPath).catch(ignoreMissingFile);
  try {
    await listenOnce(server, socketPath);
  } catch (error) {
    if (isAddressInUse(error)) {
      throw new Error("remote daemon is already running");
    }
    throw error;
  }
}

function listenOnce(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function isAddressInUse(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EADDRINUSE";
}

function canConnect(socketPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.once("error", (error) => {
      if (
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ECONNREFUSED" || error.code === "ENOTSOCK")
      ) {
        resolve(false);
      } else {
        reject(error);
      }
    });
  });
}

function ignoreMissingFile(error: unknown): void {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
    throw error;
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function closeSocket(socket: Socket): Promise<void> {
  if (socket.destroyed) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    socket.once("close", () => resolve());
    socket.end();
  });
}

function onceConnect(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off("connect", handleConnect);
      socket.off("error", handleError);
    };
    const handleConnect = () => {
      cleanup();
      resolve();
    };
    const handleError = (error: Error) => {
      cleanup();
      reject(error);
    };
    socket.once("connect", handleConnect);
    socket.once("error", handleError);
  });
}

function rejectWaiterMap<T>(waiters: Map<string, Waiter<T>[]>, error: Error): void {
  for (const pending of waiters.values()) {
    pending.forEach((waiter) => waiter.reject(error));
  }
  waiters.clear();
}

function rejectWaiters<T>(waiters: Waiter<T>[], error: Error): void {
  for (const waiter of waiters.splice(0)) {
    waiter.reject(error);
  }
}

function addWaiter<T>(waiters: Map<string, Waiter<T>[]>, key: string): Promise<T> {
  return new Promise((resolve, reject) => {
    waiters.set(key, [...(waiters.get(key) ?? []), { resolve, reject }]);
  });
}

function addReader(readers: Waiter<IpcEnvelope>[]): Promise<IpcEnvelope> {
  return new Promise((resolve, reject) => readers.push({ resolve, reject }));
}

function requireSessionId(envelope: IpcEnvelope): string {
  if (envelope.sessionId === null) {
    throw new Error("IPC session frame requires a non-null sessionId");
  }
  return envelope.sessionId;
}
