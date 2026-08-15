import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseBranchJsonl,
  ProlongMemory,
  serializeBranch,
} from "../pi-extensions/lib/prolong-memory.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("PRO-LONG active-branch memory", () => {
  it("round-trips every persisted entry field as one JSON object per line", () => {
    const entries = [
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: "2026-08-14T20:00:00.000Z",
        message: { role: "user", content: "first line\nsecond line — Καλημέρα 👋" },
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        timestamp: "2026-08-14T20:00:01.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "bash-1",
              name: "bash",
              arguments: { command: "printf 'a\\nb'" },
            },
          ],
        },
      },
      {
        type: "message",
        id: "tool-1",
        parentId: "assistant-1",
        timestamp: "2026-08-14T20:00:02.000Z",
        message: {
          role: "toolResult",
          toolCallId: "bash-1",
          toolName: "bash",
          content: [{ type: "text", text: "a\nb" }],
          details: { exitCode: 0 },
        },
      },
      {
        type: "compaction",
        id: "compact-1",
        parentId: "tool-1",
        timestamp: "2026-08-14T20:00:03.000Z",
        summary: "summary\nwith two lines",
        firstKeptEntryId: "tool-1",
        tokensBefore: 1234,
      },
      {
        type: "custom",
        id: "custom-1",
        parentId: "compact-1",
        timestamp: "2026-08-14T20:00:04.000Z",
        customType: "future-extension-state",
        data: { nested: [true, null, 42] },
      },
      {
        type: "future-pi-entry",
        id: "future-1",
        parentId: "custom-1",
        timestamp: "2026-08-14T20:00:05.000Z",
        payload: { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
      },
    ];

    const jsonl = serializeBranch(entries);

    expect(jsonl.endsWith("\n")).toBe(true);
    expect(jsonl.trimEnd().split("\n")).toHaveLength(entries.length);
    expect(parseBranchJsonl(jsonl)).toEqual(entries);
  });

  it("securely rebuilds once, appends only a new suffix, and performs no unchanged write", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "prolong-memory-test-"));
    temporaryDirectories.push(runtimeDirectory);
    const memory = new ProlongMemory({ runtimeDirectory, sessionId: "session-safe_1" });
    const first = [{ type: "message", id: "one", value: "first" }];
    const second = [...first, { type: "message", id: "two", value: "second" }];

    const initial = await memory.sync(first);
    const initialFileStat = await stat(memory.logPath, { bigint: true });
    const initialContent = await readFile(memory.logPath, "utf8");

    expect(initial.mode).toBe("rebuild");
    expect(Number((await stat(memory.directoryPath)).mode & 0o777)).toBe(0o700);
    expect(Number(initialFileStat.mode & 0o777n)).toBe(0o400);

    const appended = await memory.sync(second);
    const appendedFileStat = await stat(memory.logPath, { bigint: true });
    const appendedContent = await readFile(memory.logPath, "utf8");

    expect(appended.mode).toBe("append");
    expect(appendedFileStat.ino).toBe(initialFileStat.ino);
    expect(appendedContent.startsWith(initialContent)).toBe(true);
    expect(parseBranchJsonl(appendedContent)).toEqual(second);
    expect(Number(appendedFileStat.mode & 0o777n)).toBe(0o400);

    const unchanged = await memory.sync(second);
    const unchangedFileStat = await stat(memory.logPath, { bigint: true });

    expect(unchanged.mode).toBe("noop");
    expect(unchangedFileStat.mtimeNs).toBe(appendedFileStat.mtimeNs);
    expect(unchangedFileStat.ctimeNs).toBe(appendedFileStat.ctimeNs);
  });

  it("atomically rebuilds the exact active branch after divergence and rewind", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "prolong-divergence-test-"));
    temporaryDirectories.push(runtimeDirectory);
    const memory = new ProlongMemory({ runtimeDirectory, sessionId: "branch-test" });
    const root = { type: "message", id: "root", value: "root" };
    const abandoned = { type: "message", id: "abandoned", value: "old branch" };
    const replacement = { type: "message", id: "replacement", value: "active branch" };

    await memory.sync([root, abandoned]);
    const originalInode = (await stat(memory.logPath, { bigint: true })).ino;
    const divergent = await memory.sync([root, replacement]);
    const divergentInode = (await stat(memory.logPath, { bigint: true })).ino;

    expect(divergent.mode).toBe("rebuild");
    expect(divergentInode).not.toBe(originalInode);
    expect(parseBranchJsonl(await readFile(memory.logPath, "utf8"))).toEqual([root, replacement]);

    const rewound = await memory.sync([root]);
    expect(rewound.mode).toBe("rebuild");
    expect(parseBranchJsonl(await readFile(memory.logPath, "utf8"))).toEqual([root]);
  });

  it("rebuilds when serialized entry content changes under the same id", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "prolong-record-divergence-test-"));
    temporaryDirectories.push(runtimeDirectory);
    const memory = new ProlongMemory({ runtimeDirectory, sessionId: "record-divergence-test" });
    const original = { type: "message", id: "one", value: "old" };
    const changed = { type: "message", id: "one", value: "new" };

    await memory.sync([original]);
    const result = await memory.sync([changed]);

    expect(result.mode).toBe("rebuild");
    expect(parseBranchJsonl(await readFile(memory.logPath, "utf8"))).toEqual([changed]);
  });

  it("repairs an externally modified projection before reporting it current", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "prolong-integrity-test-"));
    temporaryDirectories.push(runtimeDirectory);
    const memory = new ProlongMemory({ runtimeDirectory, sessionId: "integrity-test" });
    const entries = [{ type: "message", id: "one", value: "canonical" }];

    await memory.sync(entries);
    await chmod(memory.logPath, 0o600);
    await writeFile(memory.logPath, `${JSON.stringify({ id: "tampered" })}\n`, "utf8");

    const repaired = await memory.sync(entries);

    expect(repaired.mode).toBe("rebuild");
    expect(parseBranchJsonl(await readFile(memory.logPath, "utf8"))).toEqual(entries);
    expect(Number((await stat(memory.logPath)).mode & 0o777)).toBe(0o400);
  });

  it("rebuilds after same-content file replacement instead of appending to an untrusted inode", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "prolong-replacement-test-"));
    temporaryDirectories.push(runtimeDirectory);
    const memory = new ProlongMemory({ runtimeDirectory, sessionId: "replacement-test" });
    const first = { type: "message", id: "one", value: "first" };
    const second = { type: "message", id: "two", value: "second" };

    await memory.sync([first]);
    const originalInode = (await stat(memory.logPath, { bigint: true })).ino;
    const replacementPath = join(memory.directoryPath, "replacement.jsonl");
    await copyFile(memory.logPath, replacementPath);
    await rename(replacementPath, memory.logPath);
    const replacedInode = (await stat(memory.logPath, { bigint: true })).ino;

    expect(replacedInode).not.toBe(originalInode);
    const result = await memory.sync([first, second]);

    expect(result.mode).toBe("rebuild");
    expect(parseBranchJsonl(await readFile(memory.logPath, "utf8"))).toEqual([first, second]);
  });

  it("refuses a log replacement between validation and suffix append", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "prolong-append-race-test-"));
    temporaryDirectories.push(runtimeDirectory);
    const first = { type: "message", id: "one" };
    const second = { type: "message", id: "two" };
    const attacker = { type: "message", id: "attacker" };
    let signatureReads = 0;
    let trustedLogPath = "";
    const readSignature = vi.fn(async (path: string) => {
      signatureReads += 1;
      try {
        const metadata = await fsPromises.lstat(path, { bigint: true });
        const signature = {
          device: metadata.dev,
          inode: metadata.ino,
          links: metadata.nlink,
          size: metadata.size,
          modified: metadata.mtimeNs,
          changed: metadata.ctimeNs,
        };
        if (signatureReads === 3) {
          trustedLogPath = join(runtimeDirectory, "validated-active-branch.jsonl");
          await rename(path, trustedLogPath);
          await writeFile(path, serializeBranch([attacker]), { mode: 0o400 });
        }
        return signature;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    });
    const memory = new ProlongMemory({
      runtimeDirectory,
      sessionId: "append-race-test",
      readSignature,
    });

    await memory.sync([first]);

    await expect(memory.sync([first, second])).rejects.toThrow(/changed during synchronization/);
    expect(parseBranchJsonl(await readFile(memory.logPath, "utf8"))).toEqual([attacker]);
    expect(parseBranchJsonl(await readFile(trustedLogPath, "utf8"))).toEqual([first]);
  });

  it("does not accept synchronization through a replaced directory ancestor", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "prolong-ancestor-race-test-"));
    temporaryDirectories.push(runtimeDirectory);
    const first = { type: "message", id: "one" };
    const second = { type: "message", id: "two" };
    const rootPath = join(runtimeDirectory, "pi-prolong");
    let signatureReads = 0;
    let ownedRootPath = "";
    const readSignature = vi.fn(async (path: string) => {
      signatureReads += 1;
      try {
        const metadata = await fsPromises.lstat(path, { bigint: true });
        const signature = {
          device: metadata.dev,
          inode: metadata.ino,
          links: metadata.nlink,
          size: metadata.size,
          modified: metadata.mtimeNs,
          changed: metadata.ctimeNs,
        };
        if (signatureReads === 3) {
          ownedRootPath = join(runtimeDirectory, "owned-projection");
          await rename(rootPath, ownedRootPath);
          await symlink(ownedRootPath, rootPath, "dir");
        }
        return signature;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    });
    const memory = new ProlongMemory({
      runtimeDirectory,
      sessionId: "ancestor-race-test",
      readSignature,
    });
    await memory.sync([first]);

    await expect(memory.sync([first, second])).rejects.toThrow("unsafe PRO-LONG directory");
    expect(
      parseBranchJsonl(
        await readFile(join(ownedRootPath, "ancestor-race-test", "active-branch.jsonl"), "utf8"),
      ),
    ).toEqual([first, second]);
    expect(
      (memory as unknown as { synchronizedRecords: string[] }).synchronizedRecords,
    ).toEqual([JSON.stringify(first)]);
  });

  it("refuses a replaced log symlink even when it resolves to the tracked inode", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "prolong-log-symlink-test-"));
    temporaryDirectories.push(runtimeDirectory);
    const memory = new ProlongMemory({ runtimeDirectory, sessionId: "log-symlink-test" });
    const first = { type: "message", id: "one", value: "first" };
    const second = { type: "message", id: "two", value: "second" };

    await memory.sync([first]);
    const movedLog = join(runtimeDirectory, "moved-active-branch.jsonl");
    await rename(memory.logPath, movedLog);
    await symlink(movedLog, memory.logPath);

    await expect(memory.sync([first, second])).rejects.toThrow("unsafe PRO-LONG log");
    expect(parseBranchJsonl(await readFile(movedLog, "utf8"))).toEqual([first]);
  });

  it("recovers after an unsafe log-path object is removed", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "prolong-retry-test-"));
    temporaryDirectories.push(runtimeDirectory);
    const memory = new ProlongMemory({ runtimeDirectory, sessionId: "retry-test" });
    const first = { type: "message", id: "one" };
    const second = { type: "message", id: "two" };

    await memory.sync([first]);
    await rm(memory.logPath);
    await mkdir(memory.logPath);
    await expect(memory.sync([first, second])).rejects.toBeDefined();

    await rm(memory.logPath, { recursive: true });
    const retry = await memory.sync([first, second]);

    expect(retry.mode).toBe("rebuild");
    expect(parseBranchJsonl(await readFile(memory.logPath, "utf8"))).toEqual([first, second]);
  });

  it("does not advance serialized records when the final signature read fails", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "prolong-signature-retry-test-"));
    temporaryDirectories.push(runtimeDirectory);
    const first = { type: "message", id: "one" };
    const second = { type: "message", id: "two" };
    type Signature = {
      device: bigint;
      inode: bigint;
      links: bigint;
      size: bigint;
      modified: bigint;
      changed: bigint;
    };
    let signatureReads = 0;
    const readSignature = vi.fn(async (path: string): Promise<Signature | undefined> => {
      signatureReads += 1;
      if (signatureReads === 4) throw new Error("injected final signature failure");
      try {
        const metadata = await fsPromises.lstat(path, { bigint: true });
        return {
          device: metadata.dev,
          inode: metadata.ino,
          links: metadata.nlink,
          size: metadata.size,
          modified: metadata.mtimeNs,
          changed: metadata.ctimeNs,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    });
    const memoryOptions = {
      runtimeDirectory,
      sessionId: "signature-retry-test",
      readSignature,
    };
    const memory = new ProlongMemory(memoryOptions);

    await memory.sync([first]);
    await expect(memory.sync([first, second])).rejects.toThrow("injected final signature failure");

    expect(parseBranchJsonl(await readFile(memory.logPath, "utf8"))).toEqual([first, second]);
    expect(
      (
        memory as unknown as {
          synchronizedRecords: string[];
        }
      ).synchronizedRecords,
    ).toEqual([JSON.stringify(first)]);

    const retry = await memory.sync([first, second]);

    expect(retry.mode).toBe("rebuild");
    expect(parseBranchJsonl(await readFile(memory.logPath, "utf8"))).toEqual([first, second]);
  });

  it("supports forced refresh, cleanup, and regeneration", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "prolong-cleanup-test-"));
    temporaryDirectories.push(runtimeDirectory);
    const memory = new ProlongMemory({ runtimeDirectory, sessionId: "cleanup-test" });
    const entries = [{ type: "message", id: "one" }];

    await memory.sync(entries);
    expect((await memory.sync(entries, { forceRebuild: true })).mode).toBe("rebuild");

    await memory.cleanup();
    await expect(stat(memory.directoryPath)).rejects.toMatchObject({ code: "ENOENT" });

    expect((await memory.sync(entries)).mode).toBe("rebuild");
    expect(parseBranchJsonl(await readFile(memory.logPath, "utf8"))).toEqual(entries);
  });

  it("keeps a large forward-progress update on the suffix-append path", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "prolong-large-test-"));
    temporaryDirectories.push(runtimeDirectory);
    const memory = new ProlongMemory({ runtimeDirectory, sessionId: "large-test" });
    const entries = Array.from({ length: 20_000 }, (_, index) => ({
      type: "message",
      id: `entry-${index}`,
      value: `payload-${index}`,
    }));

    await memory.sync(entries);
    const before = await stat(memory.logPath, { bigint: true });
    const appended = await memory.sync([
      ...entries,
      { type: "message", id: "entry-20000", value: "new suffix" },
    ]);
    const after = await stat(memory.logPath, { bigint: true });

    expect(appended.mode).toBe("append");
    expect(after.ino).toBe(before.ino);
    expect(appended.entryCount).toBe(20_001);
    expect(appended.byteSize).toBeGreaterThan(Number(before.size));
  });

  it("creates a missing runtime base privately for temporary-directory fallback use", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "prolong-runtime-parent-test-"));
    temporaryDirectories.push(parentDirectory);
    const runtimeDirectory = join(parentDirectory, "private-runtime");
    const memory = new ProlongMemory({ runtimeDirectory, sessionId: "fallback-test" });
    const entry = { type: "message", id: "one" };

    await memory.sync([entry]);

    expect(Number((await stat(runtimeDirectory)).mode & 0o777)).toBe(0o700);
    expect(parseBranchJsonl(await readFile(memory.logPath, "utf8"))).toEqual([entry]);
  });

  it("rejects unsafe session ids before constructing a path", () => {
    expect(
      () => new ProlongMemory({ runtimeDirectory: "/runtime", sessionId: "../escape" }),
    ).toThrow("Unsafe Pi session id");
  });

  it("refuses a symlinked runtime root instead of writing through it", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "prolong-symlink-test-"));
    const outsideDirectory = await mkdtemp(join(tmpdir(), "prolong-outside-test-"));
    temporaryDirectories.push(runtimeDirectory, outsideDirectory);
    await symlink(outsideDirectory, join(runtimeDirectory, "pi-prolong"), "dir");
    const memory = new ProlongMemory({ runtimeDirectory, sessionId: "session-1" });
    const entry = { type: "message", id: "one" };

    await expect(memory.sync([entry])).rejects.toThrow("Refusing unsafe PRO-LONG directory");
    await expect(stat(join(outsideDirectory, "session-1"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses cleanup through a replaced projection-root symlink", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "prolong-cleanup-race-test-"));
    const outsideDirectory = await mkdtemp(join(tmpdir(), "prolong-cleanup-outside-test-"));
    temporaryDirectories.push(runtimeDirectory, outsideDirectory);
    const memory = new ProlongMemory({ runtimeDirectory, sessionId: "session-1" });
    const entry = { type: "message", id: "one" };
    await memory.sync([entry]);
    const rootPath = join(runtimeDirectory, "pi-prolong");
    await rename(rootPath, join(runtimeDirectory, "owned-projection"));
    const outsideSession = join(outsideDirectory, "session-1");
    const sentinelPath = join(outsideSession, "sentinel.txt");
    await mkdir(outsideSession);
    await writeFile(sentinelPath, "keep");
    await symlink(outsideDirectory, rootPath, "dir");

    await expect(memory.cleanup()).rejects.toThrow("Refusing unsafe PRO-LONG directory");
    await expect(readFile(sentinelPath, "utf8")).resolves.toBe("keep");
  });

  it("refuses an ordinary projection-root replacement before cleanup", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "prolong-cleanup-root-swap-test-"));
    temporaryDirectories.push(runtimeDirectory);
    const memory = new ProlongMemory({ runtimeDirectory, sessionId: "session-1" });
    await memory.sync([{ id: "one" }]);
    const rootPath = join(runtimeDirectory, "pi-prolong");
    const ownedRootPath = join(runtimeDirectory, "owned-projection");
    await rename(rootPath, ownedRootPath);
    await mkdir(join(rootPath, "session-1"), { recursive: true });

    await expect(memory.cleanup()).rejects.toThrow(/directory changed during cleanup/);
    await expect(stat(join(rootPath, "session-1"))).resolves.toBeDefined();
    await expect(
      readFile(join(ownedRootPath, "session-1", "active-branch.jsonl"), "utf8"),
    ).resolves.toContain('"id":"one"');
  });

  it("refuses a projection-root replacement during cleanup", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "prolong-cleanup-toctou-test-"));
    const outsideDirectory = await mkdtemp(join(tmpdir(), "prolong-cleanup-target-test-"));
    temporaryDirectories.push(runtimeDirectory, outsideDirectory);
    const rootPath = join(runtimeDirectory, "pi-prolong");
    const outsideSession = join(outsideDirectory, "session-1");
    const outsideLog = join(outsideSession, "active-branch.jsonl");
    await mkdir(outsideSession);
    await writeFile(outsideLog, serializeBranch([{ id: "outside" }]), { mode: 0o400 });
    let signatureReads = 0;
    let ownedRootPath = "";
    const readSignature = vi.fn(async (path: string) => {
      signatureReads += 1;
      try {
        const metadata = await fsPromises.lstat(path, { bigint: true });
        const signature = {
          device: metadata.dev,
          inode: metadata.ino,
          links: metadata.nlink,
          size: metadata.size,
          modified: metadata.mtimeNs,
          changed: metadata.ctimeNs,
        };
        if (signatureReads === 3) {
          ownedRootPath = join(runtimeDirectory, "owned-projection");
          await rename(rootPath, ownedRootPath);
          await symlink(outsideDirectory, rootPath, "dir");
        }
        return signature;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    });
    const memory = new ProlongMemory({
      runtimeDirectory,
      sessionId: "session-1",
      readSignature,
    });
    const entry = { type: "message", id: "one" };
    await memory.sync([entry]);

    await expect(memory.cleanup()).rejects.toThrow(/unsafe PRO-LONG directory|changed during cleanup/);
    await expect(readFile(outsideLog, "utf8")).resolves.toBe(serializeBranch([{ id: "outside" }]));
    await expect(
      readFile(join(ownedRootPath, "session-1", "active-branch.jsonl"), "utf8"),
    ).resolves.toBe(serializeBranch([entry]));
  });
});
