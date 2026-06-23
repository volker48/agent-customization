import { createServer, createConnection, type Server, type Socket } from "node:net";

import { decodeFrames, type MessageType } from "./protocol.js";

export type IpcMessageType =
  | MessageType
  | "register"
  | "session_shutdown"
  | "daemon_stop"
  | "sync";

export type IpcEnvelope = {
  sessionId: string | null;
  type: IpcMessageType;
  payload: unknown;
};

export type SessionRegistration = {
  sessionId: string;
  name: string;
  cwd: string;
};

export type SessionRegistryEntry = {
  name: string;
  cwd: string;
  socket: Socket;
};

export type IpcDaemonServer = {
  registry: Map<string, SessionRegistryEntry>;
  sendToSession(envelope: IpcEnvelope): Promise<void>;
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
  socket.on("close", () => state.sockets.delete(socket));
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
  await handleDaemonFrame(envelope, socket, state.registry, options);
  state.listeners.forEach((listener) => listener(envelope));
  resolveSessionWaiters(envelope, state.registry, state.sessionWaiters);
  resolveEndWaiters(envelope, state.endWaiters);
}

async function handleDaemonFrame(
  envelope: IpcEnvelope,
  socket: Socket,
  registry: Map<string, SessionRegistryEntry>,
  options: IpcDaemonOptions,
): Promise<void> {
  if (isRegisterEnvelope(envelope)) {
    registry.set(envelope.payload.sessionId, {
      name: envelope.payload.name,
      cwd: envelope.payload.cwd,
      socket,
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
    registry.delete(envelope.sessionId);
    options.onControlFrame?.({
      sessionId: null,
      type: "session_ended",
      payload: { sessionId: envelope.sessionId },
    });
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
    typeof payload.cwd === "string"
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

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
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
