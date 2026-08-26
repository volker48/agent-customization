import { createHash, randomUUID } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { currentProcessIdentity, defaultIsOwnerLive, type ActorLeaseOwner } from "./lease.js";

export const HEADLONG_STATE_VERSION = 1 as const;
const HEADLONG_STATUSES = new Set<HeadlongActorStatus>([
  "running",
  "sleeping",
  "paused",
  "stopped",
  "completed",
  "completed-unverified",
  "blocked",
]);
const HEADLONG_STATE_KEYS = new Set([
  "version",
  "revision",
  "workspace",
  "sessionFile",
  "sessionId",
  "status",
  "wakeAt",
  "activeWakeId",
  "wakeStartedAt",
  "backoffLevel",
  "ticksAtLevel",
  "consecutiveFailures",
  "wakeSequence",
  "lastTransitionWakeId",
  "updatedAt",
]);
const MAX_OPERATIONAL_EVENT_TAIL_BYTES = 256 * 1024;

class MalformedOperationalEventError extends Error {}

export type HeadlongActorStatus =
  | "running"
  | "sleeping"
  | "paused"
  | "stopped"
  | "completed"
  | "completed-unverified"
  | "blocked";

export type HeadlongActorState = {
  version: typeof HEADLONG_STATE_VERSION;
  revision: number;
  workspace: string;
  sessionFile: string;
  sessionId: string;
  status: HeadlongActorStatus;
  wakeAt: string | null;
  activeWakeId: string | null;
  wakeStartedAt: string | null;
  backoffLevel: number;
  ticksAtLevel: number;
  consecutiveFailures: number;
  wakeSequence: number;
  lastTransitionWakeId: string | null;
  updatedAt: string;
};

export type HeadlongOperationalEvent = {
  version: 1;
  sequence: number;
  at: string;
  type: string;
  actorId: string;
  wakeId?: string;
  detail?: unknown;
};

export type HeadlongStoreOptions = {
  stateRoot: string;
  workspace: string;
  beforeStateRename?: () => Promise<void>;
  beforeEventAppend?: () => Promise<void>;
  eventLockTimeoutMs?: number;
  eventLockStaleAfterMs?: number;
  eventLockNow?: () => number;
  isEventLockOwnerLive?: (owner: ActorLeaseOwner) => Promise<boolean>;
  onEventTailRead?: (bytesRead: number) => void;
};

type EventTail = {
  sequence: number;
  separator: string;
  truncateTo?: number;
};

function canonicalWorkspace(workspace: string): string {
  const resolved = resolve(workspace);
  try {
    return realpathSync.native(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolved;
    throw error;
  }
}

export function workspaceActorId(workspace: string): string {
  return createHash("sha256").update(canonicalWorkspace(workspace)).digest("hex").slice(0, 24);
}

export function createInitialActorState(options: {
  workspace: string;
  sessionFile: string;
  sessionId: string;
  now?: number;
}): HeadlongActorState {
  const now = new Date(options.now ?? Date.now()).toISOString();
  return {
    version: HEADLONG_STATE_VERSION,
    revision: 0,
    workspace: canonicalWorkspace(options.workspace),
    sessionFile: resolve(options.sessionFile),
    sessionId: options.sessionId,
    status: "paused",
    wakeAt: null,
    activeWakeId: null,
    wakeStartedAt: null,
    backoffLevel: 0,
    ticksAtLevel: 0,
    consecutiveFailures: 0,
    wakeSequence: 0,
    lastTransitionWakeId: null,
    updatedAt: now,
  };
}

function assertAbsoluteRoot(path: string): void {
  if (!isAbsolute(path)) throw new Error(`Headlong state root must be absolute: ${path}`);
}

function ownedByCurrentUser(uid: number): boolean {
  return typeof process.getuid !== "function" || uid === process.getuid();
}

async function ensureOwnedPrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || !ownedByCurrentUser(metadata.uid)) {
    throw new Error(`Refusing unsafe Headlong directory: ${path}`);
  }
  await chmod(path, 0o700);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isValidTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function parseEventLockOwner(raw: string, path: string): ActorLeaseOwner {
  let value: Partial<ActorLeaseOwner>;
  try {
    value = JSON.parse(raw) as Partial<ActorLeaseOwner>;
  } catch (error) {
    throw new Error(`Invalid Headlong event append lock owner: ${path}`, { cause: error });
  }
  if (
    value.version !== 1 ||
    typeof value.token !== "string" ||
    !value.token ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid ?? 0) <= 0 ||
    typeof value.processIdentity !== "string" ||
    !value.processIdentity ||
    value.role !== "event-log" ||
    !isValidTimestamp(value.acquiredAt) ||
    !isValidTimestamp(value.heartbeatAt) ||
    value.delegate !== undefined
  ) {
    throw new Error(`Invalid Headlong event append lock owner: ${path}`);
  }
  return value as ActorLeaseOwner;
}

async function readEventLockOwner(path: string): Promise<ActorLeaseOwner | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    handle = await open(path, constants.O_RDONLY | noFollow);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error(`Refusing unsafe Headlong event lock: ${path}`, { cause: error });
    }
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || !ownedByCurrentUser(metadata.uid)) {
      throw new Error(`Refusing unsafe Headlong event lock: ${path}`);
    }
    return parseEventLockOwner(await handle.readFile("utf8"), path);
  } finally {
    await handle.close();
  }
}

function sameLockOwner(
  left: ActorLeaseOwner | undefined,
  right: ActorLeaseOwner | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.version === right.version &&
    left.token === right.token &&
    left.pid === right.pid &&
    left.processIdentity === right.processIdentity &&
    left.role === right.role &&
    left.acquiredAt === right.acquiredAt &&
    left.heartbeatAt === right.heartbeatAt &&
    left.delegate === undefined &&
    right.delegate === undefined
  );
}

async function restoreMovedFile(tombstonePath: string, originalPath: string): Promise<void> {
  try {
    await rename(tombstonePath, originalPath);
  } catch {
    // A replacement owner may already exist. Preserve the tombstone instead of deleting either file.
  }
}

function parseOperationalEventValue(value: unknown, label: string): HeadlongOperationalEvent {
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    value.version !== 1 ||
    !("sequence" in value) ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) <= 0 ||
    !("at" in value) ||
    !isValidTimestamp(value.at) ||
    !("type" in value) ||
    typeof value.type !== "string" ||
    !value.type ||
    !("actorId" in value) ||
    typeof value.actorId !== "string" ||
    !value.actorId
  ) {
    throw new Error(`Invalid Headlong operational event ${label}`);
  }
  return value as HeadlongOperationalEvent;
}

function parseOperationalEventLine(line: string, label: string): HeadlongOperationalEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new MalformedOperationalEventError(`Malformed Headlong operational event ${label}`, {
      cause: error,
    });
  }
  return parseOperationalEventValue(value, label);
}

function assertEventActor(event: HeadlongOperationalEvent, actorId: string): void {
  if (event.actorId !== actorId) {
    throw new Error("Headlong operational event log belongs to another actor");
  }
}

async function inspectEventTail(
  handle: Awaited<ReturnType<typeof open>>,
  size: number,
  actorId: string,
  onRead?: (bytesRead: number) => void,
): Promise<EventTail> {
  if (size === 0) return { sequence: 0, separator: "" };

  const requested = Math.min(size, MAX_OPERATIONAL_EVENT_TAIL_BYTES);
  const buffer = Buffer.alloc(requested);
  const offset = size - requested;
  let bytesRead = 0;
  while (bytesRead < requested) {
    const result = await handle.read(buffer, bytesRead, requested - bytesRead, offset + bytesRead);
    if (result.bytesRead === 0) break;
    bytesRead += result.bytesRead;
  }
  if (bytesRead !== requested) {
    throw new Error("Headlong operational event log changed during bounded tail read");
  }
  onRead?.(bytesRead);
  const tail = buffer.toString("utf8");
  const tailStart = offset;
  if (!tail) return { sequence: 0, separator: "" };

  let lineEnd: number;
  let truncateTo: number | undefined;
  if (tail.endsWith("\n")) {
    lineEnd = tail.length - 1;
  } else {
    const lastNewline = tail.lastIndexOf("\n");
    if (tailStart > 0 && lastNewline < 0) {
      throw new Error("Headlong operational event tail exceeds the bounded record window");
    }
    const finalLine = tail.slice(lastNewline + 1);
    try {
      const event = parseOperationalEventLine(finalLine, "at the log tail");
      assertEventActor(event, actorId);
      return { sequence: event.sequence, separator: "\n" };
    } catch (error) {
      if (!(error instanceof MalformedOperationalEventError)) throw error;
      truncateTo = tailStart + Buffer.byteLength(tail.slice(0, lastNewline + 1));
      lineEnd = lastNewline;
    }
  }

  while (lineEnd >= 0) {
    const previousNewline = tail.lastIndexOf("\n", lineEnd - 1);
    if (previousNewline < 0 && tailStart > 0) {
      throw new Error("Headlong operational event tail exceeds the bounded record window");
    }
    const line = tail.slice(previousNewline + 1, lineEnd);
    if (line) {
      const event = parseOperationalEventLine(line, "at the log tail");
      assertEventActor(event, actorId);
      return { sequence: event.sequence, separator: "", truncateTo };
    }
    if (previousNewline < 0) break;
    lineEnd = previousNewline;
  }

  return { sequence: 0, separator: "", truncateTo };
}

export class HeadlongStore {
  readonly actorId: string;
  readonly directoryPath: string;
  readonly statePath: string;
  readonly eventsPath: string;
  readonly eventLockPath: string;
  readonly leasePath: string;
  readonly workspace: string;
  readonly stateRoot: string;

  private eventTail: Promise<void> = Promise.resolve();
  private readonly beforeStateRename?: () => Promise<void>;
  private readonly beforeEventAppend?: () => Promise<void>;
  private readonly eventLockTimeoutMs: number;
  private readonly eventLockStaleAfterMs: number;
  private readonly eventLockNow: () => number;
  private readonly isEventLockOwnerLive: (owner: ActorLeaseOwner) => Promise<boolean>;
  private readonly onEventTailRead?: (bytesRead: number) => void;

  constructor(options: HeadlongStoreOptions) {
    assertAbsoluteRoot(options.stateRoot);
    this.beforeStateRename = options.beforeStateRename;
    this.beforeEventAppend = options.beforeEventAppend;
    this.eventLockTimeoutMs = options.eventLockTimeoutMs ?? 5_000;
    this.eventLockStaleAfterMs = options.eventLockStaleAfterMs ?? 30_000;
    this.eventLockNow = options.eventLockNow ?? Date.now;
    this.isEventLockOwnerLive = options.isEventLockOwnerLive ?? defaultIsOwnerLive;
    this.onEventTailRead = options.onEventTailRead;
    this.stateRoot = resolve(options.stateRoot);
    this.workspace = canonicalWorkspace(options.workspace);
    this.actorId = workspaceActorId(this.workspace);
    this.directoryPath = join(this.stateRoot, this.actorId);
    this.statePath = join(this.directoryPath, "actor-state.v1.json");
    this.eventsPath = join(this.directoryPath, "events.v1.jsonl");
    this.eventLockPath = join(this.directoryPath, ".events.append.lock");
    this.leasePath = join(this.directoryPath, "actor.lease");
  }

  async ensureDirectory(): Promise<void> {
    await mkdir(this.stateRoot, { recursive: true, mode: 0o700 });
    const stateRootMetadata = await lstat(this.stateRoot);
    if (
      stateRootMetadata.isSymbolicLink() ||
      !stateRootMetadata.isDirectory() ||
      !ownedByCurrentUser(stateRootMetadata.uid)
    ) {
      throw new Error(`Refusing unsafe Headlong directory: ${this.stateRoot}`);
    }
    await chmod(this.stateRoot, 0o700);
    await ensureOwnedPrivateDirectory(this.directoryPath);
  }

  async writeState(state: HeadlongActorState): Promise<void> {
    parseActorState(JSON.stringify(state), this.workspace);
    await this.ensureDirectory();
    const temporaryPath = join(this.directoryPath, `.actor-state.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporaryPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.beforeStateRename?.();
      await rename(temporaryPath, this.statePath);
      await chmod(this.statePath, 0o600);
      await syncDirectory(this.directoryPath);
    } catch (error) {
      await unlink(temporaryPath).catch((cleanupError: NodeJS.ErrnoException) => {
        if (cleanupError.code !== "ENOENT") throw cleanupError;
      });
      throw error;
    }
  }

  async readState(): Promise<HeadlongActorState | undefined> {
    await this.ensureDirectory();
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
      handle = await open(this.statePath, constants.O_RDONLY | noFollow);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        throw new Error(`Refusing unsafe Headlong state file: ${this.statePath}`, { cause: error });
      }
      throw error;
    }
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || !ownedByCurrentUser(metadata.uid)) {
        throw new Error(`Refusing unsafe Headlong state file: ${this.statePath}`);
      }
      const raw = await handle.readFile("utf8");
      return parseActorState(raw, this.workspace);
    } finally {
      await handle.close();
    }
  }

  private async acquireEventLock(): Promise<() => Promise<void>> {
    const at = new Date(this.eventLockNow()).toISOString();
    const owner: ActorLeaseOwner = {
      version: 1,
      token: randomUUID(),
      pid: process.pid,
      processIdentity: await currentProcessIdentity(),
      role: "event-log",
      acquiredAt: at,
      heartbeatAt: at,
    };
    const deadline = Date.now() + this.eventLockTimeoutMs;
    for (;;) {
      try {
        const handle = await open(this.eventLockPath, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        return async () => {
          const tombstonePath = `${this.eventLockPath}.release-${randomUUID()}`;
          try {
            await rename(this.eventLockPath, tombstonePath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              throw new Error("Headlong event append lock ownership changed", { cause: error });
            }
            throw error;
          }
          let movedOwner: ActorLeaseOwner | undefined;
          try {
            movedOwner = await readEventLockOwner(tombstonePath);
          } catch (error) {
            await restoreMovedFile(tombstonePath, this.eventLockPath);
            throw error;
          }
          if (!sameLockOwner(owner, movedOwner)) {
            await restoreMovedFile(tombstonePath, this.eventLockPath);
            throw new Error("Headlong event append lock ownership changed");
          }
          await unlink(tombstonePath);
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const current = await readEventLockOwner(this.eventLockPath);
        if (!current) continue;
        const stale =
          this.eventLockNow() - Date.parse(current.heartbeatAt) >= this.eventLockStaleAfterMs;
        if (stale && !(await this.isEventLockOwnerLive(current))) {
          const confirmed = await readEventLockOwner(this.eventLockPath);
          if (!sameLockOwner(current, confirmed)) continue;
          const tombstonePath = `${this.eventLockPath}.stale-${randomUUID()}`;
          try {
            await rename(this.eventLockPath, tombstonePath);
          } catch (renameError) {
            if ((renameError as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw renameError;
          }
          let movedOwner: ActorLeaseOwner | undefined;
          try {
            movedOwner = await readEventLockOwner(tombstonePath);
          } catch (error) {
            await restoreMovedFile(tombstonePath, this.eventLockPath);
            throw error;
          }
          if (!sameLockOwner(current, movedOwner)) {
            await restoreMovedFile(tombstonePath, this.eventLockPath);
            continue;
          }
          await unlink(tombstonePath);
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error("Timed out acquiring Headlong event append lock");
        }
        await delay(2);
      }
    }
  }

  appendEvent(
    event: Omit<HeadlongOperationalEvent, "version" | "sequence" | "actorId">,
  ): Promise<void> {
    const operation = this.eventTail.then(async () => {
      await this.ensureDirectory();
      const releaseLock = await this.acquireEventLock();
      try {
        const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
        const handle = await open(
          this.eventsPath,
          constants.O_APPEND | constants.O_CREAT | constants.O_RDWR | noFollow,
          0o600,
        );
        try {
          const metadata = await handle.stat();
          if (!metadata.isFile() || !ownedByCurrentUser(metadata.uid)) {
            throw new Error(`Refusing unsafe Headlong event log: ${this.eventsPath}`);
          }
          const tail = await inspectEventTail(
            handle,
            metadata.size,
            this.actorId,
            this.onEventTailRead,
          );
          if (tail.truncateTo !== undefined) await handle.truncate(tail.truncateTo);
          await this.beforeEventAppend?.();
          const record: HeadlongOperationalEvent = {
            version: 1,
            sequence: tail.sequence + 1,
            actorId: this.actorId,
            ...event,
          };
          await handle.write(`${tail.separator}${JSON.stringify(record)}\n`);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await chmod(this.eventsPath, 0o600);
      } finally {
        await releaseLock();
      }
    });
    this.eventTail = operation.catch(() => undefined);
    return operation;
  }
}

export function parseActorState(raw: string, expectedWorkspace?: string): HeadlongActorState {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error("Headlong actor state is corrupt JSON", { cause: error });
  }
  if (!value || typeof value !== "object") throw new Error("Headlong actor state is not an object");
  const state = value as Partial<HeadlongActorState>;
  if (state.version !== HEADLONG_STATE_VERSION) {
    throw new Error(`Unsupported Headlong actor state version: ${String(state.version)}`);
  }
  if (
    Object.keys(value).length !== HEADLONG_STATE_KEYS.size ||
    Object.keys(value).some((key) => !HEADLONG_STATE_KEYS.has(key)) ||
    !Number.isSafeInteger(state.revision) ||
    (state.revision ?? -1) < 0 ||
    typeof state.workspace !== "string" ||
    !isAbsolute(state.workspace) ||
    canonicalWorkspace(state.workspace) !== state.workspace ||
    typeof state.sessionFile !== "string" ||
    !isAbsolute(state.sessionFile) ||
    resolve(state.sessionFile) !== state.sessionFile ||
    typeof state.sessionId !== "string" ||
    !state.sessionId.trim() ||
    !HEADLONG_STATUSES.has(state.status as HeadlongActorStatus) ||
    !(state.wakeAt === null || isValidTimestamp(state.wakeAt)) ||
    !(
      state.activeWakeId === null ||
      (typeof state.activeWakeId === "string" && state.activeWakeId)
    ) ||
    !(state.wakeStartedAt === null || isValidTimestamp(state.wakeStartedAt)) ||
    (state.activeWakeId === null) !== (state.wakeStartedAt === null) ||
    (state.activeWakeId !== null && state.status !== "running") ||
    !Number.isSafeInteger(state.backoffLevel) ||
    (state.backoffLevel ?? -1) < 0 ||
    !Number.isSafeInteger(state.ticksAtLevel) ||
    (state.ticksAtLevel ?? -1) < 0 ||
    !Number.isSafeInteger(state.consecutiveFailures) ||
    (state.consecutiveFailures ?? -1) < 0 ||
    !Number.isSafeInteger(state.wakeSequence) ||
    (state.wakeSequence ?? -1) < 0 ||
    !(state.lastTransitionWakeId === null || typeof state.lastTransitionWakeId === "string") ||
    !isValidTimestamp(state.updatedAt)
  ) {
    throw new Error("Headlong actor state has invalid fields");
  }
  if (expectedWorkspace && state.workspace !== canonicalWorkspace(expectedWorkspace)) {
    throw new Error("Headlong actor state belongs to another workspace");
  }
  return state as HeadlongActorState;
}

export function readOperationalEvents(raw: string): HeadlongOperationalEvent[] {
  const lines = raw.split("\n");
  const hasTruncatedTail = lines.at(-1) !== "";
  if (!hasTruncatedTail) lines.pop();
  const events: HeadlongOperationalEvent[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    let event: HeadlongOperationalEvent;
    try {
      event = parseOperationalEventLine(line, `at line ${index + 1}`);
    } catch (error) {
      if (
        error instanceof MalformedOperationalEventError &&
        hasTruncatedTail &&
        index === lines.length - 1
      ) {
        break;
      }
      throw error;
    }
    if (
      event.sequence !== events.length + 1 ||
      (events.length > 0 && event.actorId !== events[0]?.actorId)
    ) {
      throw new Error(`Invalid Headlong operational event at line ${index + 1}`);
    }
    events.push(event);
  }
  return events;
}
