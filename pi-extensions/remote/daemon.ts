import { SecretKey } from "@number0/iroh/index.js";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  CAPSULE_MAX_BYTES,
  CAPSULE_MAX_ENTRIES,
  validateCapsule,
  type Capsule,
} from "../lib/context-capsule.js";
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
const CAPSULE_MAX_ERROR_BYTES = 2_000;
const CAPSULE_SYNTHETIC_LINEAGE: Pick<Capsule, "createdAt" | "source"> = {
  createdAt: "1970-01-01T00:00:00.000Z",
  source: { sessionId: "remote-daemon", cwd: "." },
};
const CAPSULE_ERROR_MESSAGES: Record<CapsuleControlError["code"], string> = {
  cancelled: "Capsule request was cancelled.",
  io: "Capsule is unavailable.",
  malformed: "Invalid capsule response.",
  "not-attached": "Attach to the session before requesting its capsule.",
  "not-found": "Capsule was not found.",
  oversized: "Capsule response is too large.",
  unavailable: "Capsule is unavailable.",
  unsafe: "Capsule contains unsafe text.",
  "unsupported-version": "Unsupported capsule version.",
};
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
  const streamingAttachCounts = new Map<string, Map<number, number>>();
  const nodeAttachCounts = new Map<string, number>();
  const streamingConnections = new Set<RemoteStreamingConnection>();
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
    streamingConnections,
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
  streamingAttachCounts: Map<string, Map<number, number>>,
  nodeAttachCounts: Map<string, number>,
  streamingConnections: Set<RemoteStreamingConnection>,
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
        streamingConnections,
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
  streamingAttachCounts: Map<string, Map<number, number>>,
  nodeAttachCounts: Map<string, number>,
  streamingConnections: Set<RemoteStreamingConnection>,
): Promise<void> {
  const stream = await acceptStream(connection);
  const writer = new StreamWriter(stream);
  const attached = new Set<string>();
  const attaching = new Set<string>();
  const retained = new Map<string, number>();
  const pending: IpcEnvelope[] = [];
  const nodeId = connection.remoteId().toString();
  const streamingConnection: RemoteStreamingConnection = {
    writer,
    attached,
    attaching,
    retained,
    pending,
    nodeId,
  };
  streamingConnections.add(streamingConnection);
  const requestAbort = new AbortController();
  void connection.closed().then(
    () => requestAbort.abort(),
    () => requestAbort.abort(),
  );
  const unsubscribe = ipc.subscribe((frame) =>
    routeAttachedFrame(
      frame,
      streamingConnection,
      (sessionId) => ipc.registry.get(sessionId)?.generation,
    ),
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
        streamingAttachCounts,
        streamingConnections,
        signal: requestAbort.signal,
      });
      if (
        streamingAttachSessionId &&
        response &&
        attaching.has(streamingAttachSessionId) &&
        !retained.has(streamingAttachSessionId)
      ) {
        const generation = ipc.registry.get(streamingAttachSessionId)?.generation;
        if (generation !== undefined) {
          retainStreamingAttach(streamingAttachCounts, streamingAttachSessionId, generation);
          retainNodeAttach(nodeAttachCounts, nodeId, streamingAttachSessionId, generation);
          retained.set(streamingAttachSessionId, generation);
        }
      }
      if (response) await writer.send(response);
      if (!response && isPairingEnvelope(envelope)) break;
      if (streamingAttachSessionId) {
        if (response) {
          keepOpen = true;
          await promoteAttachedSession(streamingAttachSessionId, streamingConnection);
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
    streamingConnections.delete(streamingConnection);
    releaseNodeAttaches(nodeAttachCounts, nodeId, retained);
    try {
      await detachAttachedSessions(
        ipc,
        releaseStreamingAttaches(streamingAttachCounts, retained.entries()),
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
  streamingAttachCounts: StreamingAttachCounts;
  streamingConnections: Set<RemoteStreamingConnection>;
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
      return capsuleErrorResponse(randomUUID(), "malformed");
    }
    return { sessionId: null, type: "list", payload: listSessions(ipc) };
  }

  if (envelope.type === "attach") {
    const sessionId = sessionIdFromPayload(envelope.payload);
    if (!sessionId || !(await safeSendToSession(ipc, { sessionId, type: "attach", payload: {} }))) {
      return null;
    }
    return { sessionId: null, type: "attach", payload: { sessionId, attached: true } };
  }

  if (envelope.type === "detach") {
    const sessionId = sessionIdFromPayload(envelope.payload);
    if (!sessionId || !ipc.registry.has(sessionId)) return null;
    const released = releaseNodeSessionAttachments(sessionId, context);
    if (
      (!released.hadAttachments || released.releasedLastCurrentGeneration) &&
      !(await safeSendToSession(ipc, { sessionId, type: "detach", payload: {} }))
    ) {
      return null;
    }
    return { sessionId: null, type: "detach", payload: { sessionId, detached: true } };
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
  if (!entry) return capsuleErrorResponse(requestId, "unavailable");
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
    return capsuleErrorResponse(requestId, "not-attached");
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
    return capsuleErrorResponse(requestId, isAbortError(error) ? "cancelled" : "unavailable");
  }
}

function capsuleErrorResponse(requestId: string, code: CapsuleControlError["code"]): Envelope {
  return {
    sessionId: null,
    type: "list",
    payload: capsuleErrorResult(requestId, code),
  };
}

function capsuleErrorResult(
  requestId: string,
  code: CapsuleControlError["code"],
): CapsuleControlResult<CapsuleProjection> {
  return {
    operation: CAPSULE_OPERATION,
    requestId,
    supported: true,
    error: {
      code,
      message: CAPSULE_ERROR_MESSAGES[code],
    },
  };
}

function capsuleResultFrom(
  payload: unknown,
  requestId: string,
): CapsuleControlResult<CapsuleProjection> {
  const malformed = (): CapsuleControlResult<CapsuleProjection> =>
    capsuleErrorResult(requestId, "malformed");
  const oversized = (): CapsuleControlResult<CapsuleProjection> =>
    capsuleErrorResult(requestId, "oversized");

  if (
    !isRecord(payload) ||
    (payload.operation !== undefined && payload.operation !== CAPSULE_OPERATION)
  )
    return malformed();
  if (payload.supported === false && payload.capability === CAPSULE_CAPABILITY) {
    const result: CapsuleControlResult<CapsuleProjection> = {
      operation: CAPSULE_OPERATION,
      requestId,
      supported: false,
      capability: CAPSULE_CAPABILITY,
    };
    return capsuleResultWithinLimit(result) ? result : oversized();
  }
  if (payload.supported !== true) return malformed();
  if (isRecord(payload.error)) {
    const error = capsuleErrorFrom(payload.error);
    if (error === "oversized") return oversized();
    if (error) {
      const result: CapsuleControlResult<CapsuleProjection> = {
        operation: CAPSULE_OPERATION,
        requestId,
        supported: true,
        error,
      };
      return capsuleResultWithinLimit(result) ? result : oversized();
    }
  }
  const projection = capsuleProjectionFrom(payload.capsule);
  if (projection === "oversized") return oversized();
  if (projection === "unsafe") return capsuleErrorResult(requestId, "unsafe");
  if (projection) {
    const result: CapsuleControlResult<CapsuleProjection> = {
      operation: CAPSULE_OPERATION,
      requestId,
      supported: true,
      capsule: projection,
    };
    return capsuleResultWithinLimit(result) ? result : oversized();
  }
  return malformed();
}

function capsuleProjectionFrom(value: unknown): CapsuleProjection | "oversized" | "unsafe" | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.capsuleId !== "string" ||
    typeof value.objective !== "string" ||
    typeof value.nextAction !== "string" ||
    value.schemaVersion !== 1 ||
    !isNonNegativeInt(value.revision)
  )
    return null;
  const constraints = stringListFrom(value.constraints);
  const blockers = stringListFrom(value.blockers);
  const risks = stringListFrom(value.risks);
  if (!constraints || !blockers || !risks) return null;
  if (!Array.isArray(value.decisions) || value.decisions.length > CAPSULE_MAX_ENTRIES) {
    return null;
  }
  const decisions = value.decisions.map(decisionFrom);
  if (decisions.some((decision) => decision === null)) return null;
  if (!Array.isArray(value.validation) || value.validation.length > CAPSULE_MAX_ENTRIES) {
    return null;
  }
  const validation = value.validation.map(validationFrom);
  if (validation.some((entry) => entry === null)) return null;
  if (!Array.isArray(value.redactions) || value.redactions.length > CAPSULE_MAX_ENTRIES) {
    return null;
  }
  const redactions = value.redactions.map(redactionFrom);
  if (redactions.some((entry) => entry === null)) return null;
  const expectedTruncated = (redactions as CapsuleProjection["redactions"]).some(
    (entry) => entry.category === "oversized",
  );
  if (
    typeof value.truncated !== "boolean" ||
    value.truncated !== expectedTruncated ||
    value.maxPayloadBytes !== CAPSULE_MAX_BYTES
  ) {
    return null;
  }

  const projection: CapsuleProjection = {
    capsuleId: value.capsuleId,
    schemaVersion: 1,
    revision: value.revision,
    objective: value.objective,
    constraints,
    decisions: decisions as CapsuleProjection["decisions"],
    validation: validation as CapsuleProjection["validation"],
    blockers,
    risks,
    nextAction: value.nextAction,
    redactions: redactions as CapsuleProjection["redactions"],
    truncated: value.truncated,
    maxPayloadBytes: CAPSULE_MAX_BYTES,
  };
  const validated = validateCapsule({
    kind: "pi-context-capsule",
    schemaVersion: 1,
    capsuleId: projection.capsuleId,
    revision: projection.revision,
    ...CAPSULE_SYNTHETIC_LINEAGE,
    objective: projection.objective,
    constraints: projection.constraints,
    decisions: projection.decisions,
    resources: [],
    observedChanges: [],
    validation: projection.validation,
    blockers: projection.blockers,
    risks: projection.risks,
    nextAction: projection.nextAction,
    exclusions: projection.redactions,
  });
  if (!validated.ok) {
    if ("error" in validated && validated.error.code === "oversized") return "oversized";
    if ("error" in validated && validated.error.code === "unsafe") return "unsafe";
    return null;
  }
  return capsuleResultWithinLimit(projection) ? projection : "oversized";
}

function decisionFrom(value: unknown): CapsuleProjection["decisions"][number] | null {
  if (
    !isRecord(value) ||
    typeof value.statement !== "string" ||
    (value.status !== "confirmed" && value.status !== "proposed" && value.status !== "unknown")
  ) {
    return null;
  }
  return { statement: value.statement, status: value.status };
}

function validationFrom(value: unknown): CapsuleProjection["validation"][number] | null {
  if (
    !isRecord(value) ||
    typeof value.command !== "string" ||
    (value.outcome !== "passed" &&
      value.outcome !== "failed" &&
      value.outcome !== "blocked" &&
      value.outcome !== "unknown") ||
    typeof value.evidence !== "string" ||
    (value.observedAt !== undefined && typeof value.observedAt !== "string")
  ) {
    return null;
  }
  return {
    command: value.command,
    outcome: value.outcome,
    evidence: value.evidence,
    ...(value.observedAt === undefined ? {} : { observedAt: value.observedAt as string }),
  };
}

function redactionFrom(value: unknown): CapsuleProjection["redactions"][number] | null {
  if (
    !isRecord(value) ||
    (value.category !== "secret" &&
      value.category !== "raw-tool-output" &&
      value.category !== "ignored-path" &&
      value.category !== "oversized" &&
      value.category !== "unsupported" &&
      value.category !== "untrusted") ||
    !isNonNegativeInt(value.count)
  ) {
    return null;
  }
  return { category: value.category, count: value.count };
}

function stringListFrom(value: unknown): string[] | null {
  return Array.isArray(value) &&
    value.length <= CAPSULE_MAX_ENTRIES &&
    value.every((item) => typeof item === "string")
    ? value.map((item) => item as string)
    : null;
}

function capsuleErrorFrom(
  value: Record<string, unknown>,
): CapsuleControlError | "oversized" | null {
  const codes: CapsuleControlError["code"][] = [
    "cancelled",
    "io",
    "malformed",
    "not-attached",
    "not-found",
    "oversized",
    "unavailable",
    "unsafe",
    "unsupported-version",
  ];
  if (!codes.includes(value.code as CapsuleControlError["code"])) return null;
  if (
    typeof value.message === "string" &&
    Buffer.byteLength(value.message, "utf8") > CAPSULE_MAX_ERROR_BYTES
  ) {
    return "oversized";
  }
  const code = value.code as CapsuleControlError["code"];
  return { code, message: CAPSULE_ERROR_MESSAGES[code] };
}

function capsuleResultWithinLimit(value: unknown): boolean {
  try {
    return (
      Buffer.byteLength(
        JSON.stringify({ sessionId: null, type: "list", payload: value }),
        "utf8",
      ) <= CAPSULE_MAX_BYTES
    );
  } catch {
    return false;
  }
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
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
    typeof payload.sessionId === "string" &&
    payload.sessionId.length > 0
    ? payload.sessionId
    : null;
}

type AttachedFrameContext = {
  writer: StreamWriter;
  attached: Set<string>;
  attaching: Set<string>;
  pending: IpcEnvelope[];
};

type RemoteStreamingConnection = AttachedFrameContext & {
  nodeId: string;
  retained: Map<string, number>;
};

function routeAttachedFrame(
  frame: IpcEnvelope,
  context: RemoteStreamingConnection,
  currentGeneration: (sessionId: string) => number | undefined,
): void {
  const endedSessionId = endedSessionIdFrom(frame);
  if (endedSessionId && isKnownSession(endedSessionId, context)) {
    void context.writer.send(frame as Envelope).finally(() => context.writer.close());
    return;
  }
  if (frame.sessionId === null || frame.type !== "event") return;
  const retainedGeneration = context.retained.get(frame.sessionId);
  if (
    retainedGeneration === undefined ||
    retainedGeneration !== currentGeneration(frame.sessionId)
  ) {
    dropAttachingSession(frame.sessionId, context);
    context.attached.delete(frame.sessionId);
    return;
  }
  if (context.attaching.has(frame.sessionId)) {
    context.pending.push(frame);
    return;
  }
  if (context.attached.has(frame.sessionId)) void context.writer.send(frame as Envelope);
}

async function promoteAttachedSession(
  sessionId: string,
  context: RemoteStreamingConnection,
): Promise<void> {
  if (!context.retained.has(sessionId)) {
    dropAttachingSession(sessionId, context);
    return;
  }
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
    envelope.sessionId === null &&
    envelope.type === "attach" &&
    typeof envelope.payload === "object" &&
    envelope.payload !== null &&
    "stream" in envelope.payload &&
    envelope.payload.stream === true &&
    typeof sessionIdFromPayload(envelope.payload) === "string"
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
  sessionGenerations: Iterable<readonly [string, number]>,
): Promise<void> {
  for (const [sessionId, generation] of sessionGenerations) {
    const entry = ipc.registry.get(sessionId);
    if (!entry || entry.generation !== generation) continue;
    await safeSendToSession(ipc, { sessionId, type: "detach", payload: {} });
  }
}

type StreamingAttachCounts = Map<string, Map<number, number>>;

function retainStreamingAttach(
  counts: StreamingAttachCounts,
  sessionId: string,
  generation: number,
): void {
  const generations = counts.get(sessionId) ?? new Map<number, number>();
  generations.set(generation, (generations.get(generation) ?? 0) + 1);
  counts.set(sessionId, generations);
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

function releaseNodeAttach(
  counts: Map<string, number>,
  nodeId: string,
  sessionId: string,
  generation: number,
): void {
  const key = nodeAttachKey(nodeId, sessionId, generation);
  const count = counts.get(key) ?? 0;
  if (count <= 1) counts.delete(key);
  else counts.set(key, count - 1);
}

function releaseNodeAttaches(
  counts: Map<string, number>,
  nodeId: string,
  sessionIds: Map<string, number>,
): void {
  for (const [sessionId, generation] of sessionIds) {
    releaseNodeAttach(counts, nodeId, sessionId, generation);
  }
}

function releaseNodeSessionAttachments(
  sessionId: string,
  context: RemoteEnvelopeContext,
): { hadAttachments: boolean; releasedLastCurrentGeneration: boolean } {
  let hadAttachments = false;
  let releasedLastCurrentGeneration = false;
  const currentGeneration = context.ipc.registry.get(sessionId)?.generation;
  for (const connection of context.streamingConnections) {
    if (connection.nodeId !== context.nodeId) continue;
    const wasKnown = connection.attached.delete(sessionId) || connection.attaching.has(sessionId);
    dropAttachingSession(sessionId, connection);
    const generation = connection.retained.get(sessionId);
    if (generation === undefined) {
      hadAttachments ||= wasKnown;
      continue;
    }
    hadAttachments = true;
    connection.retained.delete(sessionId);
    releaseNodeAttach(context.nodeAttachCounts, context.nodeId, sessionId, generation);
    const released = releaseStreamingAttaches(context.streamingAttachCounts, [
      [sessionId, generation],
    ]);
    releasedLastCurrentGeneration ||= generation === currentGeneration && released.size > 0;
  }
  return { hadAttachments, releasedLastCurrentGeneration };
}

function releaseStreamingAttaches(
  counts: StreamingAttachCounts,
  sessionGenerations: Iterable<readonly [string, number]>,
): Set<readonly [string, number]> {
  const lastReleased = new Set<readonly [string, number]>();
  for (const [sessionId, generation] of sessionGenerations) {
    const generations = counts.get(sessionId);
    const count = generations?.get(generation) ?? 0;
    if (count <= 1) {
      generations?.delete(generation);
      if (generations?.size === 0) counts.delete(sessionId);
      lastReleased.add([sessionId, generation]);
    } else {
      generations?.set(generation, count - 1);
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
