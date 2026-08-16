import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm, rmdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

export type BranchEntry = {
  id: string;
  parentId?: string | null;
};

export type ProlongBranchSource = {
  getLeafEntry(): BranchEntry | undefined;
  getEntry(id: string): BranchEntry | undefined;
  getBranch(): readonly BranchEntry[];
};

export type ProlongSyncMode = "append" | "rebuild" | "noop";

export type ProlongSyncResult = {
  mode: ProlongSyncMode;
  entryCount: number;
  byteSize: number;
  elapsedMs: number;
};

export type FileSignature = {
  device: bigint;
  inode: bigint;
  links: bigint;
  size: bigint;
  modified: bigint;
  changed: bigint;
};

type ObjectIdentity = {
  device: bigint;
  inode: bigint;
};

type SynchronizedState = {
  entryCount: number;
  leafId: string | null;
  records?: string[];
};

export type ProlongMemoryOptions = {
  runtimeDirectory: string;
  sessionId: string;
  readSignature?: (path: string) => Promise<FileSignature | undefined>;
  assertSupported?: () => Promise<void>;
};

const TEMPORARY_LOG_PATTERN =
  /^\.active-branch-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i;

function assertSafeSessionId(sessionId: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId) || sessionId === "." || sessionId.includes("..")) {
    throw new Error(`Unsafe Pi session id: ${sessionId}`);
  }
}

function signatureFromStat(value: BigIntStats): FileSignature {
  return {
    device: value.dev,
    inode: value.ino,
    links: value.nlink,
    size: value.size,
    modified: value.mtimeNs,
    changed: value.ctimeNs,
  };
}

function signaturesEqual(left: FileSignature, right: FileSignature): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.links === right.links &&
    left.size === right.size &&
    left.modified === right.modified &&
    left.changed === right.changed
  );
}

function objectIdentitiesEqual(left: ObjectIdentity, right: ObjectIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function assertSignaturesEqual(expected: FileSignature, actual: FileSignature): void {
  if (!signaturesEqual(expected, actual)) {
    throw new Error("PRO-LONG log changed during synchronization");
  }
}

function ownedByCurrentUser(uid: number | bigint): boolean {
  if (typeof process.getuid !== "function") return true;
  return typeof uid === "bigint" ? uid === BigInt(process.getuid()) : uid === process.getuid();
}

async function readSignature(path: string): Promise<FileSignature | undefined> {
  try {
    const metadata = await lstat(path, { bigint: true });
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`Refusing unsafe PRO-LONG log: ${path}`);
    }
    return signatureFromStat(metadata);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readOwnedRegularFileSignature(path: string): Promise<FileSignature | undefined> {
  try {
    const metadata = await lstat(path, { bigint: true });
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      !ownedByCurrentUser(metadata.uid)
    ) {
      throw new Error(`Refusing unsafe PRO-LONG temporary file: ${path}`);
    }
    return signatureFromStat(metadata);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function ensurePrivateDirectoryPath(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || !ownedByCurrentUser(metadata.uid)) {
    throw new Error(`Refusing unsafe PRO-LONG directory: ${path}`);
  }
  await chmod(path, 0o700);
}

async function readPrivateDirectoryIdentity(path: string): Promise<ObjectIdentity | undefined> {
  try {
    const metadata = await lstat(path, { bigint: true });
    if (metadata.isSymbolicLink() || !metadata.isDirectory() || !ownedByCurrentUser(metadata.uid)) {
      throw new Error(`Refusing unsafe PRO-LONG directory: ${path}`);
    }
    return { device: metadata.dev, inode: metadata.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function privateDirectoryOpenFlags(): number {
  if (typeof constants.O_DIRECTORY !== "number" || typeof constants.O_NOFOLLOW !== "number") {
    throw new Error("Safe descriptor-relative PRO-LONG cleanup is unavailable on this platform");
  }
  return constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
}

async function defaultAssertSupported(): Promise<void> {
  privateDirectoryOpenFlags();
  try {
    const metadata = await lstat("/proc/self/fd");
    if (!metadata.isDirectory()) throw new Error("/proc/self/fd is not a directory");
  } catch (error) {
    throw new Error(
      "PRO-LONG requires Linux procfs for safe cleanup; no projection was created",
      { cause: error },
    );
  }
}

async function descriptorDirectoryPath(handle: Awaited<ReturnType<typeof open>>): Promise<string> {
  const path = join("/proc/self/fd", String(handle.fd));
  try {
    await lstat(path);
    return path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new Error("Safe descriptor-relative PRO-LONG cleanup requires Linux procfs", {
      cause: error,
    });
  }
}

async function validatePrivateDirectoryHandle(
  handle: Awaited<ReturnType<typeof open>>,
  path: string,
): Promise<void> {
  const metadata = await handle.stat();
  if (!metadata.isDirectory() || !ownedByCurrentUser(metadata.uid)) {
    throw new Error(`Refusing unsafe PRO-LONG directory: ${path}`);
  }
}

async function validateOwnedRegularFileHandle(
  handle: Awaited<ReturnType<typeof open>>,
  path: string,
): Promise<FileSignature> {
  const metadata = await handle.stat({ bigint: true });
  if (!metadata.isFile() || !ownedByCurrentUser(metadata.uid)) {
    throw new Error(`Refusing unsafe PRO-LONG temporary file: ${path}`);
  }
  return signatureFromStat(metadata);
}

function isPrefix(previousRecords: readonly string[], nextRecords: readonly string[]): boolean {
  return (
    previousRecords.length <= nextRecords.length &&
    previousRecords.every((record, index) => record === nextRecords[index])
  );
}

function collectSuffix(
  source: ProlongBranchSource,
  currentLeaf: BranchEntry | undefined,
  previousLeafId: string | null,
): BranchEntry[] | undefined {
  if (!currentLeaf) return previousLeafId === null ? [] : undefined;
  const reversed: BranchEntry[] = [];
  const seen = new Set<string>();
  let current: BranchEntry | undefined = currentLeaf;

  while (current) {
    if (previousLeafId !== null && current.id === previousLeafId) {
      return reversed.reverse();
    }
    if (seen.has(current.id)) return undefined;
    seen.add(current.id);
    reversed.push(current);

    const parentId = current.parentId;
    if (parentId === null || parentId === undefined) {
      return previousLeafId === null ? reversed.reverse() : undefined;
    }
    const parent = source.getEntry(parentId);
    if (!parent || parent.id !== parentId) return undefined;
    current = parent;
  }
  return undefined;
}

function elapsedMilliseconds(started: bigint): number {
  return Number(process.hrtime.bigint() - started) / 1_000_000;
}

export function serializeBranch(entries: readonly BranchEntry[]): string {
  if (entries.length === 0) return "";
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

export function parseBranchJsonl(jsonl: string): unknown[] {
  return jsonl
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

export class ProlongMemory {
  readonly directoryPath: string;
  readonly logPath: string;

  private synchronizedRecords: string[] | undefined;
  private synchronizedLeafId: string | null | undefined;
  private synchronizedEntryCount = 0;
  private expectedSignature: FileSignature | undefined;
  private expectedRootIdentity: ObjectIdentity | undefined;
  private expectedDirectoryIdentity: ObjectIdentity | undefined;
  private operationTail: Promise<void> = Promise.resolve();
  private supportPromise: Promise<void> | undefined;
  private readonly readLogSignature: (path: string) => Promise<FileSignature | undefined>;
  private readonly supportCheck: () => Promise<void>;
  private readonly sessionId: string;

  constructor(options: ProlongMemoryOptions) {
    assertSafeSessionId(options.sessionId);
    this.sessionId = options.sessionId;
    const root = join(options.runtimeDirectory, "pi-prolong");
    this.directoryPath = join(root, options.sessionId);
    this.logPath = join(this.directoryPath, "active-branch.jsonl");
    this.readLogSignature = options.readSignature ?? readSignature;
    this.supportCheck = options.assertSupported ?? defaultAssertSupported;
  }

  async assertSupported(): Promise<void> {
    this.supportPromise ??= this.supportCheck();
    await this.supportPromise;
  }

  sync(
    entries: readonly BranchEntry[],
    options: { forceRebuild?: boolean } = {},
  ): Promise<ProlongSyncResult> {
    return this.serializeOperation(() => this.syncArrayExclusive(entries, options));
  }

  syncBranch(
    source: ProlongBranchSource,
    options: { forceRebuild?: boolean } = {},
  ): Promise<ProlongSyncResult> {
    return this.serializeOperation(() => this.syncBranchExclusive(source, options));
  }

  cleanup(): Promise<void> {
    return this.serializeOperation(() => this.cleanupExclusive());
  }

  cleanupStale(): Promise<void> {
    return this.cleanup();
  }

  private serializeOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async syncArrayExclusive(
    entries: readonly BranchEntry[],
    options: { forceRebuild?: boolean },
  ): Promise<ProlongSyncResult> {
    const started = process.hrtime.bigint();
    await this.assertSupported();
    await this.ensurePrivateDirectory();
    const actualSignature = await this.readLogSignature(this.logPath);
    const serializedEntries = entries.map((entry) => JSON.stringify(entry));
    const integrityMatches =
      this.expectedSignature !== undefined &&
      actualSignature !== undefined &&
      signaturesEqual(this.expectedSignature, actualSignature);

    let mode: ProlongSyncMode;
    let trustedSignature: FileSignature;
    if (
      !options.forceRebuild &&
      integrityMatches &&
      this.synchronizedRecords !== undefined &&
      isPrefix(this.synchronizedRecords, serializedEntries)
    ) {
      if (this.synchronizedRecords.length === entries.length) {
        mode = "noop";
        trustedSignature = actualSignature;
      } else {
        trustedSignature = await this.append(
          entries.slice(this.synchronizedRecords.length),
          actualSignature,
        );
        mode = "append";
      }
    } else {
      trustedSignature = await this.rebuild(entries);
      mode = "rebuild";
    }

    return this.finalizeSync(
      started,
      mode,
      trustedSignature,
      {
        entryCount: entries.length,
        leafId: entries.at(-1)?.id ?? null,
        records: serializedEntries,
      },
    );
  }

  private async syncBranchExclusive(
    source: ProlongBranchSource,
    options: { forceRebuild?: boolean },
  ): Promise<ProlongSyncResult> {
    const started = process.hrtime.bigint();
    await this.assertSupported();
    await this.ensurePrivateDirectory();
    const actualSignature = await this.readLogSignature(this.logPath);
    const integrityMatches =
      this.expectedSignature !== undefined &&
      actualSignature !== undefined &&
      signaturesEqual(this.expectedSignature, actualSignature);

    let mode: ProlongSyncMode;
    let trustedSignature: FileSignature;
    let nextState: SynchronizedState;
    const currentLeaf = source.getLeafEntry();
    const currentLeafId = currentLeaf?.id ?? null;

    if (options.forceRebuild || !integrityMatches || this.synchronizedLeafId === undefined) {
      const entries = source.getBranch();
      trustedSignature = await this.rebuild(entries);
      mode = "rebuild";
      nextState = {
        entryCount: entries.length,
        leafId: entries.at(-1)?.id ?? null,
      };
    } else if (currentLeafId === this.synchronizedLeafId) {
      trustedSignature = actualSignature;
      mode = "noop";
      nextState = {
        entryCount: this.synchronizedEntryCount,
        leafId: this.synchronizedLeafId,
      };
    } else {
      const suffix = collectSuffix(source, currentLeaf, this.synchronizedLeafId);
      if (suffix !== undefined && suffix.length > 0) {
        trustedSignature = await this.append(suffix, actualSignature);
        mode = "append";
        nextState = {
          entryCount: this.synchronizedEntryCount + suffix.length,
          leafId: currentLeafId,
        };
      } else if (suffix !== undefined) {
        trustedSignature = actualSignature;
        mode = "noop";
        nextState = {
          entryCount: this.synchronizedEntryCount,
          leafId: this.synchronizedLeafId,
        };
      } else {
        const entries = source.getBranch();
        trustedSignature = await this.rebuild(entries);
        mode = "rebuild";
        nextState = {
          entryCount: entries.length,
          leafId: entries.at(-1)?.id ?? null,
        };
      }
    }

    return this.finalizeSync(started, mode, trustedSignature, nextState);
  }

  private async finalizeSync(
    started: bigint,
    mode: ProlongSyncMode,
    trustedSignature: FileSignature,
    nextState: SynchronizedState,
  ): Promise<ProlongSyncResult> {
    const directoryIdentities = await this.validatePrivateDirectory();
    const synchronizedSignature = await this.readLogSignature(this.logPath);
    if (!synchronizedSignature) throw new Error("PRO-LONG log disappeared after synchronization");
    assertSignaturesEqual(trustedSignature, synchronizedSignature);

    this.synchronizedRecords = nextState.records;
    this.synchronizedLeafId = nextState.leafId;
    this.synchronizedEntryCount = nextState.entryCount;
    this.expectedSignature = synchronizedSignature;
    this.expectedRootIdentity = directoryIdentities.root;
    this.expectedDirectoryIdentity = directoryIdentities.session;

    return {
      mode,
      entryCount: nextState.entryCount,
      byteSize: Number(synchronizedSignature.size),
      elapsedMs: elapsedMilliseconds(started),
    };
  }

  private async cleanupExclusive(): Promise<void> {
    const root = dirname(this.directoryPath);
    const runtimeDirectory = dirname(root);
    const sessionIdentity = await readPrivateDirectoryIdentity(this.directoryPath);
    if (!sessionIdentity) {
      this.resetSynchronizedState();
      return;
    }

    const runtimeIdentity = await readPrivateDirectoryIdentity(runtimeDirectory);
    const rootIdentity = await readPrivateDirectoryIdentity(root);
    if (!runtimeIdentity || !rootIdentity) {
      throw new Error("PRO-LONG directory changed during cleanup");
    }
    if (
      (this.expectedRootIdentity &&
        !objectIdentitiesEqual(this.expectedRootIdentity, rootIdentity)) ||
      (this.expectedDirectoryIdentity &&
        !objectIdentitiesEqual(this.expectedDirectoryIdentity, sessionIdentity))
    ) {
      throw new Error("PRO-LONG directory changed during cleanup");
    }

    await this.assertSupported();
    const rootHandle = await open(root, privateDirectoryOpenFlags());
    try {
      await this.cleanupFromRootHandle(rootHandle, root, rootIdentity, sessionIdentity);
    } finally {
      await rootHandle.close();
    }
    this.resetSynchronizedState();
  }

  private async cleanupFromRootHandle(
    rootHandle: Awaited<ReturnType<typeof open>>,
    root: string,
    rootIdentity: ObjectIdentity,
    sessionIdentity: ObjectIdentity,
  ): Promise<void> {
    await validatePrivateDirectoryHandle(rootHandle, root);
    const openedRoot = await rootHandle.stat({ bigint: true });
    if (openedRoot.dev !== rootIdentity.device || openedRoot.ino !== rootIdentity.inode) {
      throw new Error("PRO-LONG directory changed during cleanup");
    }

    const rootDescriptorPath = await descriptorDirectoryPath(rootHandle);
    const anchoredSessionPath = join(rootDescriptorPath, this.sessionId);
    const sessionHandle = await open(anchoredSessionPath, privateDirectoryOpenFlags());
    try {
      await this.cleanupFromSessionHandle(
        sessionHandle,
        anchoredSessionPath,
        rootIdentity,
        sessionIdentity,
      );
    } finally {
      await sessionHandle.close();
    }
  }

  private async cleanupFromSessionHandle(
    sessionHandle: Awaited<ReturnType<typeof open>>,
    anchoredSessionPath: string,
    rootIdentity: ObjectIdentity,
    sessionIdentity: ObjectIdentity,
  ): Promise<void> {
    await validatePrivateDirectoryHandle(sessionHandle, this.directoryPath);
    const openedSession = await sessionHandle.stat({ bigint: true });
    if (
      openedSession.dev !== sessionIdentity.device ||
      openedSession.ino !== sessionIdentity.inode
    ) {
      throw new Error("PRO-LONG directory changed during cleanup");
    }

    const sessionDescriptorPath = await descriptorDirectoryPath(sessionHandle);
    await this.removeTrackedLog(
      join(sessionDescriptorPath, "active-branch.jsonl"),
      rootIdentity,
      sessionIdentity,
    );
    await this.removeOrphanedTemporaryLogs(sessionDescriptorPath, rootIdentity, sessionIdentity);
    await this.validatePrivateDirectoryIdentities(rootIdentity, sessionIdentity);

    const currentDirectory = await lstat(anchoredSessionPath, { bigint: true });
    if (openedSession.dev !== currentDirectory.dev || openedSession.ino !== currentDirectory.ino) {
      throw new Error("PRO-LONG directory changed during cleanup");
    }
    await rmdir(anchoredSessionPath);
  }

  private async removeTrackedLog(
    anchoredLogPath: string,
    rootIdentity: ObjectIdentity,
    sessionIdentity: ObjectIdentity,
  ): Promise<void> {
    const validatedSignature = await this.readLogSignature(anchoredLogPath);
    if (!validatedSignature) return;
    if (
      this.expectedSignature &&
      !objectIdentitiesEqual(this.expectedSignature, validatedSignature)
    ) {
      throw new Error("PRO-LONG log identity changed during cleanup");
    }

    const logHandle = await open(anchoredLogPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const openedSignature = signatureFromStat(await logHandle.stat({ bigint: true }));
      if (!signaturesEqual(validatedSignature, openedSignature)) {
        throw new Error("PRO-LONG log changed during cleanup");
      }
      await this.validatePrivateDirectoryIdentities(rootIdentity, sessionIdentity);
      await unlink(anchoredLogPath);
    } finally {
      await logHandle.close();
    }
  }

  private async removeOrphanedTemporaryLogs(
    sessionDescriptorPath: string,
    rootIdentity: ObjectIdentity,
    sessionIdentity: ObjectIdentity,
  ): Promise<void> {
    for (const name of await readdir(sessionDescriptorPath)) {
      if (name === "active-branch.jsonl") {
        throw new Error("PRO-LONG log changed during cleanup");
      }
      if (!TEMPORARY_LOG_PATTERN.test(name)) {
        throw new Error(`Refusing unknown file in PRO-LONG directory: ${name}`);
      }

      const anchoredTemporaryPath = join(sessionDescriptorPath, name);
      const validatedSignature = await readOwnedRegularFileSignature(anchoredTemporaryPath);
      if (!validatedSignature) continue;
      const handle = await open(
        anchoredTemporaryPath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const openedSignature = await validateOwnedRegularFileHandle(
          handle,
          anchoredTemporaryPath,
        );
        if (!signaturesEqual(validatedSignature, openedSignature)) {
          throw new Error("PRO-LONG temporary file changed during cleanup");
        }
        await this.validatePrivateDirectoryIdentities(rootIdentity, sessionIdentity);
        await unlink(anchoredTemporaryPath);
      } finally {
        await handle.close();
      }
    }
  }

  private resetSynchronizedState(): void {
    this.synchronizedRecords = undefined;
    this.synchronizedLeafId = undefined;
    this.synchronizedEntryCount = 0;
    this.expectedSignature = undefined;
    this.expectedRootIdentity = undefined;
    this.expectedDirectoryIdentity = undefined;
  }

  private async ensurePrivateDirectory(): Promise<void> {
    const root = dirname(this.directoryPath);
    const runtimeDirectory = dirname(root);
    await ensurePrivateDirectoryPath(runtimeDirectory);
    await ensurePrivateDirectoryPath(root);
    await ensurePrivateDirectoryPath(this.directoryPath);
  }

  private async validatePrivateDirectory(): Promise<{
    root: ObjectIdentity;
    session: ObjectIdentity;
  }> {
    const root = dirname(this.directoryPath);
    const runtimeDirectory = dirname(root);
    const runtimeIdentity = await readPrivateDirectoryIdentity(runtimeDirectory);
    const rootIdentity = await readPrivateDirectoryIdentity(root);
    const sessionIdentity = await readPrivateDirectoryIdentity(this.directoryPath);
    if (!runtimeIdentity || !rootIdentity || !sessionIdentity) {
      throw new Error("PRO-LONG directory disappeared during synchronization");
    }
    return { root: rootIdentity, session: sessionIdentity };
  }

  private async validatePrivateDirectoryIdentities(
    expectedRoot: ObjectIdentity,
    expectedSession: ObjectIdentity,
  ): Promise<void> {
    const current = await this.validatePrivateDirectory();
    if (
      !objectIdentitiesEqual(expectedRoot, current.root) ||
      !objectIdentitiesEqual(expectedSession, current.session)
    ) {
      throw new Error("PRO-LONG directory changed during cleanup");
    }
  }

  private async append(
    entries: readonly BranchEntry[],
    validatedSignature: FileSignature,
  ): Promise<FileSignature> {
    const validationHandle = await open(this.logPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let appendHandle: Awaited<ReturnType<typeof open>> | undefined;
    let writable = false;
    try {
      const openedSignature = signatureFromStat(await validationHandle.stat({ bigint: true }));
      assertSignaturesEqual(validatedSignature, openedSignature);
      await validationHandle.chmod(0o600);
      writable = true;
      const writableSignature = signatureFromStat(await validationHandle.stat({ bigint: true }));
      appendHandle = await open(
        this.logPath,
        constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
      );
      const appendSignature = signatureFromStat(await appendHandle.stat({ bigint: true }));
      assertSignaturesEqual(writableSignature, appendSignature);
      await appendHandle.appendFile(serializeBranch(entries), { encoding: "utf8" });
      await appendHandle.chmod(0o400);
      writable = false;
      return signatureFromStat(await appendHandle.stat({ bigint: true }));
    } finally {
      if (writable) await validationHandle.chmod(0o400);
      await appendHandle?.close();
      await validationHandle.close();
    }
  }

  private async rebuild(entries: readonly BranchEntry[]): Promise<FileSignature> {
    const temporaryPath = join(this.directoryPath, `.active-branch-${randomUUID()}.tmp`);
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(serializeBranch(entries), { encoding: "utf8" });
      await handle.chmod(0o400);
      await rename(temporaryPath, this.logPath);
      return signatureFromStat(await handle.stat({ bigint: true }));
    } finally {
      await handle.close();
      await rm(temporaryPath, { force: true });
    }
  }
}
