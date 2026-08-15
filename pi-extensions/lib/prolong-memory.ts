import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm, rmdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

export type BranchEntry = {
  id: string;
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

export type ProlongMemoryOptions = {
  runtimeDirectory: string;
  sessionId: string;
  readSignature?: (path: string) => Promise<FileSignature | undefined>;
};

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

async function ensurePrivateDirectoryPath(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const metadata = await lstat(path);
  const ownedByCurrentUser =
    typeof process.getuid !== "function" || metadata.uid === process.getuid();
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || !ownedByCurrentUser) {
    throw new Error(`Refusing unsafe PRO-LONG directory: ${path}`);
  }
  await chmod(path, 0o700);
}

async function readPrivateDirectoryIdentity(path: string): Promise<ObjectIdentity | undefined> {
  try {
    const metadata = await lstat(path, { bigint: true });
    const ownedByCurrentUser =
      typeof process.getuid !== "function" || metadata.uid === BigInt(process.getuid());
    if (metadata.isSymbolicLink() || !metadata.isDirectory() || !ownedByCurrentUser) {
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
  const ownedByCurrentUser =
    typeof process.getuid !== "function" || metadata.uid === process.getuid();
  if (!metadata.isDirectory() || !ownedByCurrentUser) {
    throw new Error(`Refusing unsafe PRO-LONG directory: ${path}`);
  }
}

function isPrefix(previousRecords: readonly string[], nextRecords: readonly string[]): boolean {
  return (
    previousRecords.length <= nextRecords.length &&
    previousRecords.every((record, index) => record === nextRecords[index])
  );
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

  private synchronizedRecords: string[] = [];
  private expectedSignature: FileSignature | undefined;
  private expectedRootIdentity: ObjectIdentity | undefined;
  private expectedDirectoryIdentity: ObjectIdentity | undefined;
  private readonly readLogSignature: (path: string) => Promise<FileSignature | undefined>;
  private readonly sessionId: string;

  constructor(options: ProlongMemoryOptions) {
    assertSafeSessionId(options.sessionId);
    this.sessionId = options.sessionId;
    const root = join(options.runtimeDirectory, "pi-prolong");
    this.directoryPath = join(root, options.sessionId);
    this.logPath = join(this.directoryPath, "active-branch.jsonl");
    this.readLogSignature = options.readSignature ?? readSignature;
  }

  async sync(
    entries: readonly BranchEntry[],
    options: { forceRebuild?: boolean } = {},
  ): Promise<ProlongSyncResult> {
    const started = process.hrtime.bigint();
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

    const directoryIdentities = await this.validatePrivateDirectory();
    const synchronizedSignature = await this.readLogSignature(this.logPath);
    if (!synchronizedSignature) throw new Error("PRO-LONG log disappeared after synchronization");
    assertSignaturesEqual(trustedSignature, synchronizedSignature);
    this.synchronizedRecords = serializedEntries;
    this.expectedSignature = synchronizedSignature;
    this.expectedRootIdentity = directoryIdentities.root;
    this.expectedDirectoryIdentity = directoryIdentities.session;

    return {
      mode,
      entryCount: entries.length,
      byteSize: Number(this.expectedSignature.size),
      elapsedMs: elapsedMilliseconds(started),
    };
  }

  async cleanup(): Promise<void> {
    const root = dirname(this.directoryPath);
    const runtimeDirectory = dirname(root);
    const runtimeIdentity = await readPrivateDirectoryIdentity(runtimeDirectory);
    const rootIdentity = await readPrivateDirectoryIdentity(root);
    const sessionIdentity = await readPrivateDirectoryIdentity(this.directoryPath);
    const hierarchyExists = runtimeIdentity && rootIdentity && sessionIdentity;
    if (!hierarchyExists && (this.expectedRootIdentity || this.expectedDirectoryIdentity)) {
      throw new Error("PRO-LONG directory changed during cleanup");
    }
    if (hierarchyExists) {
      if (
        !this.expectedRootIdentity ||
        !this.expectedDirectoryIdentity ||
        !objectIdentitiesEqual(this.expectedRootIdentity, rootIdentity) ||
        !objectIdentitiesEqual(this.expectedDirectoryIdentity, sessionIdentity)
      ) {
        throw new Error("PRO-LONG directory changed during cleanup");
      }
      // Anchor every destructive operation to opened directories. A mutable pathname is used only
      // to acquire the root handle; descendants are then addressed through that descriptor chain.
      const rootHandle = await open(root, privateDirectoryOpenFlags());
      let sessionHandle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        await validatePrivateDirectoryHandle(rootHandle, root);
        const openedRoot = await rootHandle.stat({ bigint: true });
        if (openedRoot.dev !== rootIdentity.device || openedRoot.ino !== rootIdentity.inode) {
          throw new Error("PRO-LONG directory changed during cleanup");
        }
        const rootDescriptorPath = await descriptorDirectoryPath(rootHandle);
        const anchoredSessionPath = join(rootDescriptorPath, this.sessionId);
        sessionHandle = await open(anchoredSessionPath, privateDirectoryOpenFlags());
        await validatePrivateDirectoryHandle(sessionHandle, this.directoryPath);
        const openedSession = await sessionHandle.stat({ bigint: true });
        if (
          openedSession.dev !== sessionIdentity.device ||
          openedSession.ino !== sessionIdentity.inode
        ) {
          throw new Error("PRO-LONG directory changed during cleanup");
        }
        const sessionDescriptorPath = await descriptorDirectoryPath(sessionHandle);
        const anchoredLogPath = join(sessionDescriptorPath, "active-branch.jsonl");
        const validatedSignature = await this.readLogSignature(anchoredLogPath);
        if (validatedSignature) {
          if (
            !this.expectedSignature ||
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
            await this.validatePrivateDirectory();
            await unlink(anchoredLogPath);
          } finally {
            await logHandle.close();
          }
        }
        await this.validatePrivateDirectory();
        const openedDirectory = await sessionHandle.stat({ bigint: true });
        const currentDirectory = await lstat(anchoredSessionPath, { bigint: true });
        if (
          openedDirectory.dev !== currentDirectory.dev ||
          openedDirectory.ino !== currentDirectory.ino
        ) {
          throw new Error("PRO-LONG directory changed during cleanup");
        }
        await rmdir(anchoredSessionPath);
      } finally {
        await sessionHandle?.close();
        await rootHandle.close();
      }
    }
    this.synchronizedRecords = [];
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

  private async append(
    entries: readonly BranchEntry[],
    validatedSignature: FileSignature,
  ): Promise<FileSignature> {
    // The idle log is 0400, so first anchor and validate it read-only. After making that inode
    // writable, open the append descriptor and verify both handles still identify the same file.
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
