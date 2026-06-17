import { SecretKey } from "@number0/iroh/index.js";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";

import {
  CachedNodeAllowlist,
  FileNodeAllowlist,
  authorizeRemoteEnvelope,
  defaultRemoteRoot,
  type NodeAllowlist,
} from "./authorization.js";
import { startIpcDaemonServer, type IpcDaemonServer, type IpcEnvelope } from "./ipc.js";
import {
  acceptConnection,
  acceptStream,
  bindEndpoint,
  closeEndpoint,
  endpointTicket,
  finishSending,
  receiveEnvelopes,
  sendEnvelope,
  type RemoteEndpoint,
} from "./iroh-transport.js";
import {
  CONTROL_MESSAGE_TYPES,
  PER_SESSION_MESSAGE_TYPES,
  routeEnvelope,
  type ControlEnvelope,
  type Envelope,
  type RoutedEnvelope,
} from "./protocol.js";

const SECRET_KEY_FILE = "iroh-secret-key.json";
const DAEMON_SOCKET_FILE = "daemon.sock";

export type RemoteDaemon = {
  endpoint: RemoteEndpoint;
  ipc: IpcDaemonServer;
  ticket: string;
  nodeId: string;
  socketPath: string;
  close(): Promise<void>;
};

export type RemoteDaemonOptions = {
  remoteRoot?: string;
  pairingCode: string;
  socketPath?: string;
};

export async function startRemoteDaemon(options: RemoteDaemonOptions): Promise<RemoteDaemon> {
  const remoteRoot = options.remoteRoot ?? defaultRemoteRoot();
  const socketPath = options.socketPath ?? join(remoteRoot, DAEMON_SOCKET_FILE);
  await prepareSocketPath(socketPath);

  const allowlist = new FileNodeAllowlist(remoteRoot);
  const ipc = await startIpcDaemonServer(socketPath);
  const endpoint = await bindEndpoint(await loadSecretKey(remoteRoot));
  let closed = false;
  void acceptConnections(endpoint, ipc, allowlist, options.pairingCode, () => closed);

  return {
    endpoint,
    ipc,
    ticket: endpointTicket(endpoint),
    nodeId: endpoint.id().toString(),
    socketPath,
    async close() {
      closed = true;
      await closeEndpoint(endpoint);
      await ipc.close();
      await unlink(socketPath).catch(ignoreMissingFile);
    },
  };
}

async function acceptConnections(
  endpoint: RemoteEndpoint,
  ipc: IpcDaemonServer,
  allowlist: FileNodeAllowlist,
  pairingCode: string,
  isClosed: () => boolean,
): Promise<void> {
  while (!isClosed()) {
    try {
      const connection = await acceptConnection(endpoint);
      void handleConnection(connection, ipc, allowlist, pairingCode).catch(() => undefined);
    } catch (error) {
      if (!isClosed()) {
        throw error;
      }
    }
  }
}

async function handleConnection(
  connection: Awaited<ReturnType<typeof acceptConnection>>,
  ipc: IpcDaemonServer,
  allowlist: FileNodeAllowlist,
  pairingCode: string,
): Promise<void> {
  const stream = await acceptStream(connection);
  const connectionAllowlist = new CachedNodeAllowlist(allowlist);
  const responses: Envelope[] = [];
  for (const envelope of await receiveEnvelopes(stream)) {
    const response = await handleRemoteEnvelope({
      envelope,
      ipc,
      allowlist: connectionAllowlist,
      pairingCode,
      nodeId: connection.remoteId().toString(),
    });
    if (response) {
      responses.push(response);
    }
  }

  for (const response of responses) {
    await sendEnvelope(stream, response);
  }
  await finishSending(stream);
}

type RemoteEnvelopeContext = {
  envelope: Envelope;
  ipc: IpcDaemonServer;
  allowlist: NodeAllowlist;
  pairingCode: string;
  nodeId: string;
};

async function handleRemoteEnvelope(context: RemoteEnvelopeContext): Promise<Envelope | null> {
  const routed = routeEnvelope(context.envelope);
  if (!isTypeConsistent(routed)) {
    return null;
  }

  const authorization = await authorizeRemoteEnvelope({
    nodeId: context.nodeId,
    envelope: context.envelope,
    allowlist: context.allowlist,
    pairingCode: context.pairingCode,
  });
  if (!authorization.accepted) {
    return null;
  }

  return routed.channel === "control"
    ? handleControlEnvelope(routed.envelope, context.ipc)
    : routeSessionEnvelope(routed.envelope, context.ipc);
}

async function handleControlEnvelope(
  envelope: ControlEnvelope,
  ipc: IpcDaemonServer,
): Promise<Envelope | null> {
  if (envelope.type === "pair") {
    return { sessionId: null, type: "pair", payload: { paired: true } };
  }

  if (envelope.type === "list") {
    return { sessionId: null, type: "list", payload: listSessions(ipc) };
  }

  if (envelope.type === "attach" || envelope.type === "detach") {
    const sessionId = sessionIdFromPayload(envelope.payload);
    if (!sessionId) {
      return null;
    }
    if (!(await safeSendToSession(ipc, { sessionId, type: envelope.type, payload: {} }))) {
      return null;
    }
    const status = envelope.type === "attach" ? { attached: true } : { detached: true };
    return { sessionId: null, type: envelope.type, payload: { sessionId, ...status } };
  }

  return null;
}

async function routeSessionEnvelope(envelope: IpcEnvelope, ipc: IpcDaemonServer): Promise<null> {
  await safeSendToSession(ipc, envelope);
  return null;
}

async function safeSendToSession(ipc: IpcDaemonServer, envelope: IpcEnvelope): Promise<boolean> {
  if (envelope.sessionId === null || !ipc.registry.has(envelope.sessionId)) {
    return false;
  }

  try {
    await ipc.sendToSession(envelope);
    return true;
  } catch (error) {
    if (isMissingSessionError(error)) {
      return false;
    }
    throw error;
  }
}

function isMissingSessionError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("IPC session is not registered:");
}

function isTypeConsistent(routed: RoutedEnvelope): boolean {
  return routed.channel === "control"
    ? CONTROL_MESSAGE_TYPES.includes(routed.envelope.type)
    : PER_SESSION_MESSAGE_TYPES.includes(routed.envelope.type);
}

function listSessions(ipc: IpcDaemonServer): { sessionId: string; name: string; cwd: string }[] {
  return [...ipc.registry.entries()].map(([sessionId, entry]) => ({
    sessionId,
    name: entry.name,
    cwd: entry.cwd,
  }));
}

function sessionIdFromPayload(payload: unknown): string | null {
  return typeof payload === "object" &&
    payload !== null &&
    "sessionId" in payload &&
    typeof payload.sessionId === "string"
    ? payload.sessionId
    : null;
}

async function loadSecretKey(remoteRoot: string): Promise<number[]> {
  const filePath = join(remoteRoot, SECRET_KEY_FILE);
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    if (isSecretKeyBytes(parsed)) {
      await chmod(filePath, 0o600);
      return parsed;
    }
    throw new Error(`remote daemon secret key file is malformed: ${filePath}`);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }

  const bytes = SecretKey.generate().toBytes();
  await mkdir(remoteRoot, { recursive: true });
  await writeFile(filePath, `${JSON.stringify(bytes)}\n`, { mode: 0o600 });
  await chmod(filePath, 0o600);
  return bytes;
}

async function prepareSocketPath(socketPath: string): Promise<void> {
  await mkdir(dirname(socketPath), { recursive: true });
  const active = await canConnect(socketPath);
  if (active) {
    throw new Error("remote daemon is already running");
  }
  await unlink(socketPath).catch(ignoreMissingFile);
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

function isSecretKeyBytes(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === 32 &&
    value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)
  );
}

function ignoreMissingFile(error: unknown): void {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
    throw error;
  }
}
