import { SecretKey } from "@number0/iroh/index.js";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { CAPSULE_MAX_BYTES, CAPSULE_MAX_ENTRIES } from "../lib/context-capsule.js";
import type { CapsuleProjection } from "./capsule-projection.js";

import {
  CachedNodeAllowlist,
  FileNodeAllowlist,
  PairingWindow,
  authorizeRemoteEnvelope,
  createPairingCode,
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
  CAPSULE_CAPABILITY,
  CAPSULE_OPERATION,
  CONTROL_MESSAGE_TYPES,
  PER_SESSION_MESSAGE_TYPES,
  isCapsuleControlRequest,
  parseCapsuleControlRequest,
  routeEnvelope,
  type CapsuleControlError,
  type CapsuleControlResult,
  type ControlEnvelope,
  type Envelope,
  type RoutedEnvelope,
} from "./protocol.js";

const SECRET_KEY_FILE = "iroh-secret-key.json";
const DAEMON_SOCKET_FILE = "daemon.sock";
const OWNER_ONLY_DIRECTORY_MODE = 0o700;
const OWNER_ONLY_FILE_MODE = 0o600;
const UNAUTHENTICATED_READ_TIMEOUT_MS = 30_000;
const CAPSULE_REQUEST_TIMEOUT_MS = 10_000;
const REMOTE_CLOSE_ERROR_CODE = 0n;
const READ_TIMEOUT_CLOSE_REASON = Array.from(Buffer.from("read timeout", "utf8"));

type AcceptedConnection = Awaited<ReturnType<typeof acceptConnection>>;

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
  pairingCode?: string;
  createPairingCode?: () => string;
  socketPath?: string;
};

export async function startRemoteDaemon(options: RemoteDaemonOptions): Promise<RemoteDaemon> {
  const remoteRoot = options.remoteRoot ?? defaultRemoteRoot();
  const socketPath = options.socketPath ?? join(remoteRoot, DAEMON_SOCKET_FILE);
  await prepareSocketPath(socketPath);

  const allowlist = new FileNodeAllowlist(remoteRoot);
  const endpoint = await bindEndpoint(await loadSecretKey(remoteRoot));
  const ticket = endpointTicket(endpoint);
  const pairingWindow = new PairingWindow(pairingCodeFactory(options));
  const streamingAttachCounts = new Map<string, number>();
  const nodeAttachCounts = new Map<string, number>();
  let daemon: RemoteDaemon;
  let ipc: IpcDaemonServer;
  try {
    ipc = await startIpcDaemonServer(socketPath, {
      onStop: () => daemon.close(),
      getPairingInfo: () => ({ ticket, code: pairingWindow.arm() }),
    });
  } catch (error) {
    await closeEndpoint(endpoint);
    throw error;
  }
  await chmod(socketPath, OWNER_ONLY_FILE_MODE);
  let closed = false;
  void acceptConnections(
    endpoint,
    ipc,
    allowlist,
    pairingWindow,
    streamingAttachCounts,
    nodeAttachCounts,
    () => closed,
  );

  daemon = {
    endpoint,
    ipc,
    ticket,
    nodeId: endpoint.id().toString(),
    socketPath,
    async close() {
      closed = true;
      await closeEndpoint(endpoint);
      await ipc.close();
      await unlink(socketPath).catch(ignoreMissingFile);
    },
  };
  return daemon;
}

async function acceptConnections(
  endpoint: RemoteEndpoint,
  ipc: IpcDaemonServer,
  allowlist: FileNodeAllowlist,
  pairingWindow: PairingWindow,
  streamingAttachCounts: Map<string, number>,
  nodeAttachCounts: Map<string, number>,
  isClosed: () => boolean,
): Promise<void> {
  while (!isClosed()) {
    try {
      const connection = await acceptConnection(endpoint);
      void handleConnection(
        connection,
        ipc,
        allowlist,
        pairingWindow,
        streamingAttachCounts,
        nodeAttachCounts,
      ).catch(() => undefined);
    } catch {
      if (isClosed()) return;
    }
  }
}

async function handleConnection(
  connection: AcceptedConnection,
  ipc: IpcDaemonServer,
  allowlist: FileNodeAllowlist,
  pairingWindow: PairingWindow,
  streamingAttachCounts: Map<string, number>,
  nodeAttachCounts: Map<string, number>,
): Promise<void> {
  const stream = await acceptStream(connection);
  const writer = new StreamWriter(stream);
  const attached = new Set<string>();
  const attaching = new Set<string>();
  const retained = new Map<string, number>();
  const pending: IpcEnvelope[] = [];
  const nodeId = connection.remoteId().toString();
  const requestAbort = new AbortController();
  void connection.closed().then(
    () => requestAbort.abort(),
    () => requestAbort.abort(),
  );
  const unsubscribe = ipc.subscribe((frame) =>
    routeAttachedFrame(frame, { writer, attached, attaching, pending }),
  );

  try {
    let keepOpen = false;
    const connectionAllowlist = new CachedNodeAllowlist(allowlist);
    const envelopes = await receiveEnvelopesWithTimeout(stream, connection, writer);
    for (const envelope of envelopes) {
      const streamingAttachSessionId = streamingAttachSessionIdFrom(envelope);
      if (streamingAttachSessionId) attaching.add(streamingAttachSessionId);

      const response = await handleRemoteEnvelope({
        envelope,
        ipc,
        allowlist: connectionAllowlist,
        pairingWindow,
        nodeId,
        nodeAttachCounts,
        signal: requestAbort.signal,
      });
      if (streamingAttachSessionId && response && !retained.has(streamingAttachSessionId)) {
        const generation = ipc.registry.get(streamingAttachSessionId)?.generation;
        if (generation !== undefined) {
          retainStreamingAttach(streamingAttachCounts, streamingAttachSessionId);
          retainNodeAttach(nodeAttachCounts, nodeId, streamingAttachSessionId, generation);
          retained.set(streamingAttachSessionId, generation);
        }
      }
      if (response) await writer.send(response);
      if (!response && isPairingEnvelope(envelope)) break;
      if (streamingAttachSessionId) {
        if (response) {
          keepOpen = true;
          await promoteAttachedSession(streamingAttachSessionId, {
            writer,
            attached,
            attaching,
            pending,
          });
        } else {
          dropAttachingSession(streamingAttachSessionId, { attaching, pending });
        }
      }
    }

    if (keepOpen) {
      await waitForStreamingConnection(connection, writer);
    } else {
      await writer.close();
    }
  } catch {
    closeRemoteConnection(connection);
    await writer.close();
  } finally {
    requestAbort.abort();
    releaseNodeAttaches(nodeAttachCounts, nodeId, retained);
    try {
      await detachAttachedSessions(
        ipc,
        releaseStreamingAttaches(streamingAttachCounts, retained.keys()),
      );
    } finally {
      unsubscribe();
    }
  }
}

type RemoteEnvelopeContext = {
  envelope: Envelope;
  ipc: IpcDaemonServer;
  allowlist: NodeAllowlist;
  pairingWindow: PairingWindow;
  nodeId: string;
  nodeAttachCounts: Map<string, number>;
  signal: AbortSignal;
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
    pairingWindow: context.pairingWindow,
  });
  if (!authorization.accepted) {
    return null;
  }

  return routed.channel === "control"
    ? handleControlEnvelope(routed.envelope, context)
    : routeSessionEnvelope(routed.envelope, context.ipc);
}

async function handleControlEnvelope(
  envelope: ControlEnvelope,
  context: RemoteEnvelopeContext,
): Promise<Envelope | null> {
  const { ipc } = context;
  if (envelope.type === "pair") {
    return { sessionId: null, type: "pair", payload: { paired: true } };
  }

  if (envelope.type === "list") {
    const request = parseCapsuleControlRequest(envelope.payload);
    if (request) return retrieveCapsule(request.sessionId, context);
    if (isCapsuleControlRequest(envelope.payload)) {
      return capsuleErrorResponse(randomUUID(), "malformed", "Invalid capsule request.");
    }
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

function pairingCodeFactory(options: RemoteDaemonOptions): () => string {
  if (options.createPairingCode) {
    return options.createPairingCode;
  }
  if (options.pairingCode) {
    const pairingCode = options.pairingCode;
    return () => pairingCode;
  }
  return createPairingCode;
}

async function retrieveCapsule(
  sessionId: string,
  context: RemoteEnvelopeContext,
): Promise<Envelope> {
  const requestId = randomUUID();
  const entry = context.ipc.registry.get(sessionId);
  if (!entry) return capsuleErrorResponse(requestId, "unavailable", "Capsule is unavailable.");
  if (!entry.capabilities.includes(CAPSULE_CAPABILITY)) {
    return {
      sessionId: null,
      type: "list",
      payload: {
        operation: CAPSULE_OPERATION,
        requestId,
        supported: false,
        capability: CAPSULE_CAPABILITY,
      },
    };
  }
  const generation = context.ipc.registry.get(sessionId)?.generation;
  if (
    generation === undefined ||
    !isNodeAttached(context.nodeAttachCounts, context.nodeId, sessionId, generation)
  ) {
    return capsuleErrorResponse(
      requestId,
      "not-attached",
      "Attach to the session before requesting its capsule.",
    );
  }

  try {
    const response = await context.ipc.requestFromSession(
      { sessionId, type: "capsule", payload: { requestId } },
      { signal: context.signal, timeoutMs: CAPSULE_REQUEST_TIMEOUT_MS },
    );
    return {
      sessionId: null,
      type: "list",
      payload: capsuleResultFrom(response.payload, requestId),
    };
  } catch (error) {
    return capsuleErrorResponse(
      requestId,
      isAbortError(error) ? "cancelled" : "unavailable",
      isAbortError(error) ? "Capsule request was cancelled." : "Capsule is unavailable.",
    );
  }
}

function capsuleErrorResponse(requestId: string, code: string, message: string): Envelope {
  return {
    sessionId: null,
    type: "list",
    payload: {
      operation: CAPSULE_OPERATION,
      requestId,
      supported: true,
      error: { code, message },
    },
  };
}

function capsuleResultFrom(
  payload: unknown,
  requestId: string,
): CapsuleControlResult<CapsuleProjection> {
  const malformed = (): CapsuleControlResult<CapsuleProjection> => ({
    operation: CAPSULE_OPERATION,
    requestId,
    supported: true,
    error: { code: "malformed", message: "Invalid capsule response." },
  });
  if (
    !isRecord(payload) ||
    (payload.operation !== undefined && payload.operation !== CAPSULE_OPERATION)
  )
    return malformed();
  if (payload.supported === false && payload.capability === CAPSULE_CAPABILITY) {
    return {
      operation: CAPSULE_OPERATION,
      requestId,
      supported: false,
      capability: CAPSULE_CAPABILITY,
    };
  }
  if (payload.supported !== true) return malformed();
  if (isRecord(payload.error) && isCapsuleError(payload.error)) {
    return { operation: CAPSULE_OPERATION, requestId, supported: true, error: payload.error };
  }
  if (isCapsuleProjection(payload.capsule)) {
    return { operation: CAPSULE_OPERATION, requestId, supported: true, capsule: payload.capsule };
  }
  return malformed();
}

function isCapsuleProjection(value: unknown): value is CapsuleProjection {
  if (!isRecord(value)) return false;
  if (
    !(
      typeof value.capsuleId === "string" &&
      typeof value.objective === "string" &&
      typeof value.nextAction === "string"
    )
  )
    return false;
  if (value.schemaVersion !== 1 || !isNonNegativeInt(value.revision)) return false;
  if (
    !isStringList(value.constraints) ||
    !isStringList(value.blockers) ||
    !isStringList(value.risks)
  )
    return false;
  if (
    !Array.isArray(value.decisions) ||
    value.decisions.length > CAPSULE_MAX_ENTRIES ||
    !value.decisions.every(isDecision)
  )
    return false;
  if (
    !Array.isArray(value.validation) ||
    value.validation.length > CAPSULE_MAX_ENTRIES ||
    !value.validation.every(isValidation)
  )
    return false;
  if (
    !Array.isArray(value.redactions) ||
    value.redactions.length > CAPSULE_MAX_ENTRIES ||
    !value.redactions.every(isRedaction)
  )
    return false;
  if (typeof value.truncated !== "boolean" || value.maxPayloadBytes !== CAPSULE_MAX_BYTES)
    return false;
  return Buffer.byteLength(JSON.stringify(value), "utf8") <= CAPSULE_MAX_BYTES;
}

function isDecision(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.statement === "string" &&
    (value.status === "confirmed" || value.status === "proposed" || value.status === "unknown")
  );
}

function isValidation(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.command === "string" &&
    (value.outcome === "passed" ||
      value.outcome === "failed" ||
      value.outcome === "blocked" ||
      value.outcome === "unknown") &&
    typeof value.evidence === "string" &&
    (value.observedAt === undefined || typeof value.observedAt === "string")
  );
}

function isRedaction(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.category === "secret" ||
      value.category === "raw-tool-output" ||
      value.category === "ignored-path" ||
      value.category === "oversized" ||
      value.category === "unsupported" ||
      value.category === "untrusted") &&
    isNonNegativeInt(value.count)
  );
}

function isStringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= CAPSULE_MAX_ENTRIES &&
    value.every((item) => typeof item === "string")
  );
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isCapsuleError(value: Record<string, unknown>): value is CapsuleControlError {
  return (
    typeof value.message === "string" &&
    [
      "cancelled",
      "io",
      "malformed",
      "not-attached",
      "not-found",
      "oversized",
      "unavailable",
      "unsafe",
      "unsupported-version",
    ].includes(String(value.code))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function sessionIdFromPayload(payload: unknown): string | null {
  return typeof payload === "object" &&
    payload !== null &&
    "sessionId" in payload &&
    typeof payload.sessionId === "string"
    ? payload.sessionId
    : null;
}

type AttachedFrameContext = {
  writer: StreamWriter;
  attached: Set<string>;
  attaching: Set<string>;
  pending: IpcEnvelope[];
};

function routeAttachedFrame(frame: IpcEnvelope, context: AttachedFrameContext): void {
  const endedSessionId = endedSessionIdFrom(frame);
  if (endedSessionId && isKnownSession(endedSessionId, context)) {
    void context.writer.send(frame as Envelope).finally(() => context.writer.close());
    return;
  }
  if (frame.sessionId === null) return;
  if (frame.type !== "event") return;
  if (context.attaching.has(frame.sessionId)) {
    context.pending.push(frame);
    return;
  }
  if (context.attached.has(frame.sessionId)) void context.writer.send(frame as Envelope);
}

async function promoteAttachedSession(
  sessionId: string,
  context: AttachedFrameContext,
): Promise<void> {
  context.attaching.delete(sessionId);
  context.attached.add(sessionId);
  for (const frame of drainPendingForSession(context.pending, sessionId)) {
    await context.writer.send(frame as Envelope);
  }
}

function drainPendingForSession(pending: IpcEnvelope[], sessionId: string): IpcEnvelope[] {
  const ready: IpcEnvelope[] = [];
  for (let index = pending.length - 1; index >= 0; index -= 1) {
    const frame = pending[index];
    if (frame.sessionId === sessionId) ready.unshift(...pending.splice(index, 1));
  }
  return ready;
}

function dropAttachingSession(
  sessionId: string,
  context: Pick<AttachedFrameContext, "attaching" | "pending">,
): void {
  context.attaching.delete(sessionId);
  drainPendingForSession(context.pending, sessionId);
}

function streamingAttachSessionIdFrom(envelope: Envelope): string | null {
  if (!isStreamingAttach(envelope)) return null;
  return sessionIdFromPayload(envelope.payload);
}

function isStreamingAttach(envelope: Envelope): boolean {
  return (
    typeof envelope.payload === "object" &&
    envelope.payload !== null &&
    "stream" in envelope.payload &&
    envelope.payload.stream === true
  );
}

function isPairingEnvelope(envelope: Envelope): boolean {
  return envelope.sessionId === null && envelope.type === "pair";
}

function endedSessionIdFrom(frame: IpcEnvelope): string | null {
  if (frame.sessionId !== null || frame.type !== "session_ended") return null;
  return sessionIdFromPayload(frame.payload);
}

function isKnownSession(sessionId: string, context: AttachedFrameContext): boolean {
  return context.attached.has(sessionId) || context.attaching.has(sessionId);
}

async function waitForStreamingConnection(
  connection: AcceptedConnection,
  writer: StreamWriter,
): Promise<void> {
  await Promise.race([writer.waitClosed(), connection.closed().then(() => writer.close())]);
}

async function receiveEnvelopesWithTimeout(
  stream: Awaited<ReturnType<typeof acceptStream>>,
  connection: AcceptedConnection,
  writer: StreamWriter,
): Promise<Envelope[]> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<Envelope[]>((_, reject) => {
    timeout = setTimeout(() => {
      closeRemoteConnection(connection);
      void writer.close();
      reject(new Error("remote connection timed out before authentication"));
    }, UNAUTHENTICATED_READ_TIMEOUT_MS);
  });

  try {
    return await Promise.race([receiveEnvelopes(stream), timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function detachAttachedSessions(
  ipc: IpcDaemonServer,
  sessionIds: Set<string>,
): Promise<void> {
  for (const sessionId of sessionIds) {
    await safeSendToSession(ipc, { sessionId, type: "detach", payload: {} });
  }
}

function retainStreamingAttach(counts: Map<string, number>, sessionId: string): void {
  counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1);
}

function nodeAttachKey(nodeId: string, sessionId: string, generation: number): string {
  return `${nodeId}:${sessionId}:${generation}`;
}

function retainNodeAttach(
  counts: Map<string, number>,
  nodeId: string,
  sessionId: string,
  generation: number,
): void {
  const key = nodeAttachKey(nodeId, sessionId, generation);
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function isNodeAttached(
  counts: Map<string, number>,
  nodeId: string,
  sessionId: string,
  generation: number,
): boolean {
  return (counts.get(nodeAttachKey(nodeId, sessionId, generation)) ?? 0) > 0;
}

function releaseNodeAttaches(
  counts: Map<string, number>,
  nodeId: string,
  sessionIds: Map<string, number>,
): void {
  for (const [sessionId, generation] of sessionIds) {
    const key = nodeAttachKey(nodeId, sessionId, generation);
    const count = counts.get(key) ?? 0;
    if (count <= 1) counts.delete(key);
    else counts.set(key, count - 1);
  }
}

function releaseStreamingAttaches(
  counts: Map<string, number>,
  sessionIds: Iterable<string>,
): Set<string> {
  const lastReleased = new Set<string>();
  for (const sessionId of sessionIds) {
    const count = counts.get(sessionId) ?? 0;
    if (count <= 1) {
      counts.delete(sessionId);
      lastReleased.add(sessionId);
    } else {
      counts.set(sessionId, count - 1);
    }
  }
  return lastReleased;
}

function closeRemoteConnection(connection: AcceptedConnection): void {
  try {
    connection.close(REMOTE_CLOSE_ERROR_CODE, READ_TIMEOUT_CLOSE_REASON);
  } catch {
    // The connection may already be closed by the peer.
  }
}

class StreamWriter {
  #chain = Promise.resolve();
  #closed = false;
  #closedResolved = false;
  #resolveClosed!: () => void;
  #closedPromise = new Promise<void>((resolve) => {
    this.#resolveClosed = resolve;
  });

  constructor(readonly stream: Awaited<ReturnType<typeof acceptStream>>) {}

  send(envelope: Envelope): Promise<void> {
    if (this.#closed) return this.#chain;
    this.#chain = this.#chain
      .then(() => (this.#closed ? undefined : sendEnvelope(this.stream, envelope)))
      .catch(() => this.markClosed());
    return this.#chain;
  }

  close(): Promise<void> {
    if (this.#closed) return this.#chain;
    this.#closed = true;
    this.#chain = this.#chain.then(() => finishSending(this.stream)).catch(() => undefined);
    this.#chain = this.#chain.finally(() => this.markClosed());
    return this.#chain;
  }

  waitClosed(): Promise<void> {
    return this.#closedPromise;
  }

  private markClosed(): void {
    this.#closed = true;
    if (this.#closedResolved) return;
    this.#closedResolved = true;
    this.#resolveClosed();
  }
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
  const socketDirectory = dirname(socketPath);
  const created = await mkdir(socketDirectory, {
    recursive: true,
    mode: OWNER_ONLY_DIRECTORY_MODE,
  });
  if (created === undefined) {
    await assertOwnerOnlyDirectory(socketDirectory);
  } else {
    await chmod(socketDirectory, OWNER_ONLY_DIRECTORY_MODE);
  }
}

async function assertOwnerOnlyDirectory(directory: string): Promise<void> {
  const mode = (await stat(directory)).mode & 0o777;
  if (mode & 0o077) {
    throw new Error(
      `remote daemon directory grants access to other users (mode ${mode.toString(8)}): ${directory}`,
    );
  }
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
