import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { appendFile, chmod, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
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
  private readonly readLogSignature: (path: string) => Promise<FileSignature | undefined>;

  constructor(options: ProlongMemoryOptions) {
    assertSafeSessionId(options.sessionId);
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
    if (
      !options.forceRebuild &&
      integrityMatches &&
      isPrefix(this.synchronizedRecords, serializedEntries)
    ) {
      if (this.synchronizedRecords.length === entries.length) {
        mode = "noop";
      } else {
        await this.append(entries.slice(this.synchronizedRecords.length));
        mode = "append";
      }
    } else {
      await this.rebuild(entries);
      mode = "rebuild";
    }

    const synchronizedSignature = await this.readLogSignature(this.logPath);
    if (!synchronizedSignature) throw new Error("PRO-LONG log disappeared after synchronization");
    this.synchronizedRecords = serializedEntries;
    this.expectedSignature = synchronizedSignature;

    return {
      mode,
      entryCount: entries.length,
      byteSize: Number(this.expectedSignature.size),
      elapsedMs: elapsedMilliseconds(started),
    };
  }

  async cleanup(): Promise<void> {
    await rm(this.directoryPath, { recursive: true, force: true });
    this.synchronizedRecords = [];
    this.expectedSignature = undefined;
  }

  private async ensurePrivateDirectory(): Promise<void> {
    const root = dirname(this.directoryPath);
    const runtimeDirectory = dirname(root);
    await ensurePrivateDirectoryPath(runtimeDirectory);
    await ensurePrivateDirectoryPath(root);
    await ensurePrivateDirectoryPath(this.directoryPath);
  }

  private async append(entries: readonly BranchEntry[]): Promise<void> {
    await chmod(this.logPath, 0o600);
    try {
      await appendFile(this.logPath, serializeBranch(entries), { encoding: "utf8" });
    } finally {
      await chmod(this.logPath, 0o400);
    }
  }

  private async rebuild(entries: readonly BranchEntry[]): Promise<void> {
    const temporaryPath = join(this.directoryPath, `.active-branch-${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, serializeBranch(entries), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporaryPath, this.logPath);
      await chmod(this.logPath, 0o400);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
}
