import { createHash, randomUUID } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const HEADLONG_STATE_VERSION = 1 as const;
const HEADLONG_STATUSES = new Set<HeadlongActorStatus>([
  "running",
  "sleeping",
  "paused",
  "stopped",
  "completed",
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

export type HeadlongActorStatus =
  | "running"
  | "sleeping"
  | "paused"
  | "stopped"
  | "completed"
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

  constructor(options: HeadlongStoreOptions) {
    assertAbsoluteRoot(options.stateRoot);
    this.beforeStateRename = options.beforeStateRename;
    this.stateRoot = resolve(options.stateRoot);
    this.workspace = canonicalWorkspace(options.workspace);
    this.actorId = workspaceActorId(this.workspace);
    this.directoryPath = join(options.stateRoot, this.actorId);
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
    const token = randomUUID();
    const deadline = Date.now() + 5_000;
    for (;;) {
      try {
        const handle = await open(this.eventLockPath, "wx", 0o600);
        try {
          await handle.writeFile(token, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        return async () => {
          const current = await readFile(this.eventLockPath, "utf8");
          if (current !== token) throw new Error("Headlong event append lock ownership changed");
          await unlink(this.eventLockPath);
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let metadata;
        try {
          metadata = await lstat(this.eventLockPath);
        } catch (metadataError) {
          if ((metadataError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw metadataError;
        }
        if (metadata.isSymbolicLink() || !metadata.isFile() || !ownedByCurrentUser(metadata.uid)) {
          throw new Error(`Refusing unsafe Headlong event lock: ${this.eventLockPath}`);
        }
        if (Date.now() - metadata.mtimeMs > 30_000) {
          await unlink(this.eventLockPath).catch((unlinkError: NodeJS.ErrnoException) => {
            if (unlinkError.code !== "ENOENT") throw unlinkError;
          });
          continue;
        }
        if (Date.now() >= deadline)
          throw new Error("Timed out acquiring Headlong event append lock");
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
          let raw = await handle.readFile("utf8");
          let existing = readOperationalEvents(raw);
          let separator = "";
          if (raw && !raw.endsWith("\n")) {
            const lineCount = raw.split("\n").filter(Boolean).length;
            if (existing.length === lineCount) {
              separator = "\n";
            } else {
              const completePrefix = raw.slice(0, raw.lastIndexOf("\n") + 1);
              await handle.truncate(Buffer.byteLength(completePrefix));
              raw = completePrefix;
              existing = readOperationalEvents(raw);
            }
          }
          if (existing.some((existingEvent) => existingEvent.actorId !== this.actorId)) {
            throw new Error("Headlong operational event log belongs to another actor");
          }
          const record: HeadlongOperationalEvent = {
            version: 1,
            sequence: (existing.at(-1)?.sequence ?? 0) + 1,
            actorId: this.actorId,
            ...event,
          };
          await handle.write(`${separator}${JSON.stringify(record)}\n`);
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

function isValidTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
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
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      if (hasTruncatedTail && index === lines.length - 1) break;
      throw new Error(`Malformed Headlong operational event at line ${index + 1}`, {
        cause: error,
      });
    }
    if (
      !value ||
      typeof value !== "object" ||
      !("version" in value) ||
      value.version !== 1 ||
      !("sequence" in value) ||
      !Number.isSafeInteger(value.sequence) ||
      value.sequence !== events.length + 1 ||
      !("at" in value) ||
      !isValidTimestamp(value.at) ||
      !("type" in value) ||
      typeof value.type !== "string" ||
      !value.type ||
      !("actorId" in value) ||
      typeof value.actorId !== "string" ||
      !value.actorId ||
      (events.length > 0 && value.actorId !== events[0]?.actorId)
    ) {
      throw new Error(`Invalid Headlong operational event at line ${index + 1}`);
    }
    events.push(value as HeadlongOperationalEvent);
  }
  return events;
}
