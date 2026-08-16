import { lstat, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseBranchJsonl,
  ProlongMemory,
  serializeBranch,
  type FileSignature,
} from "../pi-extensions/lib/prolong-memory.js";
import { registerProlongExtension, type ProlongMemoryPort } from "../pi-extensions/prolong.js";

const temporaryDirectories: string[] = [];

type CleanupTestContext = ReturnType<typeof createContext>["context"];
type CleanupHandler = (event: unknown, context: CleanupTestContext) => unknown;
type CleanupCommand = {
  handler: (argumentsText: string, context: CleanupTestContext) => Promise<void>;
};

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function fileSignature(path: string): Promise<FileSignature | undefined> {
  try {
    const metadata = await lstat(path, { bigint: true });
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`Unsafe test file: ${path}`);
    }
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
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("PRO-LONG regressions", () => {
  it("serializes overlapping sync and cleanup operations", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "prolong-queue-test-"));
    temporaryDirectories.push(runtimeDirectory);
    let activeReads = 0;
    let maximumReads = 0;
    const readSignature = vi.fn(async (path: string) => {
      activeReads += 1;
      maximumReads = Math.max(maximumReads, activeReads);
      try {
        await delay(8);
        return await fileSignature(path);
      } finally {
        activeReads -= 1;
      }
    });
    const memory = new ProlongMemory({
      runtimeDirectory,
      sessionId: "serialized-operations",
      readSignature,
    });
    const first = { id: "one", parentId: null };
    const second = { id: "two", parentId: "one" };

    await memory.sync([first]);
    const results = await Promise.all([
      memory.sync([first, second]),
      memory.sync([first, second]),
    ]);

    expect(results.map((result) => result.mode)).toEqual(["append", "noop"]);
    expect(maximumReads).toBe(1);
    expect(parseBranchJsonl(await readFile(memory.logPath, "utf8"))).toEqual([first, second]);

    const third = { id: "three", parentId: "two" };
    const [syncResult, cleanupResult] = await Promise.allSettled([
      memory.sync([first, second, third]),
      memory.cleanup(),
    ]);
    expect(syncResult.status).toBe("fulfilled");
    expect(cleanupResult.status).toBe("fulfilled");
    await expect(stat(memory.directoryPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses leaf ancestry for suffix-only synchronization", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "prolong-source-test-"));
    temporaryDirectories.push(runtimeDirectory);
    type TestEntry = { id: string; parentId: string | null; payload: string };
    const first: TestEntry = { id: "one", parentId: null, payload: "first" };
    const second: TestEntry = { id: "two", parentId: "one", payload: "second" };
    const entries = new Map<string, TestEntry>([[first.id, first]]);
    let leaf: TestEntry = first;
    const getBranch = vi.fn(() => {
      const branch: TestEntry[] = [];
      let current: TestEntry | undefined = leaf;
      while (current) {
        branch.push(current);
        current = current.parentId ? entries.get(current.parentId) : undefined;
      }
      return branch.reverse();
    });
    const getEntry = vi.fn((id: string) => entries.get(id));
    const source = {
      getLeafEntry: () => leaf,
      getEntry,
      getBranch,
    };
    const memory = new ProlongMemory({ runtimeDirectory, sessionId: "branch-source" });

    expect((await memory.syncBranch(source)).mode).toBe("rebuild");
    expect(getBranch).toHaveBeenCalledTimes(1);

    entries.set(second.id, second);
    leaf = second;
    expect((await memory.syncBranch(source)).mode).toBe("append");
    expect(getBranch).toHaveBeenCalledTimes(1);
    expect(getEntry).toHaveBeenCalledTimes(1);

    expect((await memory.syncBranch(source)).mode).toBe("noop");
    expect(getBranch).toHaveBeenCalledTimes(1);
    expect(getEntry).toHaveBeenCalledTimes(1);
    expect(parseBranchJsonl(await readFile(memory.logPath, "utf8"))).toEqual([first, second]);
  });

  it("adopts and removes a crash-left projection and generated temporary log", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "prolong-crash-test-"));
    temporaryDirectories.push(runtimeDirectory);
    const initialMemory = new ProlongMemory({ runtimeDirectory, sessionId: "crashed-session" });
    const entry = { id: "one", parentId: null };
    await initialMemory.sync([entry]);
    await writeFile(
      join(
        initialMemory.directoryPath,
        ".active-branch-12345678-1234-4321-8abc-123456789abc.tmp",
      ),
      serializeBranch([{ id: "partial", parentId: null }]),
      { mode: 0o600 },
    );

    const resumedMemory = new ProlongMemory({
      runtimeDirectory,
      sessionId: "crashed-session",
    });
    await resumedMemory.cleanup();

    await expect(stat(resumedMemory.directoryPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("checks cleanup support before creating any projection data", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "prolong-platform-test-"));
    temporaryDirectories.push(runtimeDirectory);
    const memory = new ProlongMemory({
      runtimeDirectory,
      sessionId: "unsupported-platform",
      assertSupported: async () => {
        throw new Error("procfs unavailable");
      },
    });

    await expect(memory.sync([{ id: "one" }])).rejects.toThrow("procfs unavailable");
    await expect(stat(join(runtimeDirectory, "pi-prolong"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps disabled branches hint-free while retrying failed cleanup", async () => {
    const handlers = new Map<string, CleanupHandler>();
    const commands = new Map<string, CleanupCommand>();
    const branch: Array<{
      id: string;
      type: string;
      customType?: string;
      data?: unknown;
    }> = [
      {
        id: "state-on",
        type: "custom",
        customType: "prolong-state",
        data: { enabled: true },
      },
    ];
    let cleanupCalls = 0;
    const memory: ProlongMemoryPort = {
      directoryPath: "/runtime/pi-prolong/session",
      logPath: "/runtime/pi-prolong/session/active-branch.jsonl",
      assertSupported: async () => undefined,
      sync: vi.fn(async () => ({
        mode: "noop",
        entryCount: branch.length,
        byteSize: 1,
        elapsedMs: 1,
      })),
      syncBranch: vi.fn(async () => ({
        mode: "noop",
        entryCount: branch.length,
        byteSize: 1,
        elapsedMs: 1,
      })),
      cleanup: vi.fn(async () => {
        cleanupCalls += 1;
        if (cleanupCalls === 1) throw new Error("busy");
      }),
    };
    const pi = {
      getFlag: vi.fn(() => false),
      appendEntry: vi.fn(),
      registerFlag: vi.fn(),
      registerCommand: vi.fn((name: string, command: CleanupCommand) =>
        commands.set(name, command),
      ),
      on: vi.fn((name: string, handler: CleanupHandler) => handlers.set(name, handler)),
    };
    registerProlongExtension(pi as never, {
      createMemory: () => memory,
      defaultEnabled: () => false,
    });
    const context = createContext(branch);

    await handlers.get("session_start")?.({}, context.context);
    expect(memory.syncBranch).toHaveBeenCalledTimes(1);

    branch.splice(0);
    await handlers.get("session_tree")?.({}, context.context);
    expect(memory.cleanup).toHaveBeenCalledTimes(1);
    expect(context.notifications.at(-1)?.message).toContain("removal will be retried");

    const beforeResult = await handlers.get("before_agent_start")?.({}, context.context);
    expect(beforeResult).toBeUndefined();
    expect(memory.cleanup).toHaveBeenCalledTimes(2);
    expect(memory.syncBranch).toHaveBeenCalledTimes(1);

    await commands.get("prolong")?.handler("status", context.context);
    expect(context.notifications.at(-1)?.message).toBe("PRO-LONG: off\nProjection: removed");
  });
});

function createContext(
  branch: Array<{ id: string; type: string; customType?: string; data?: unknown }>,
) {
  const notifications: Array<{ message: string; level?: string }> = [];
  return {
    context: {
      sessionManager: {
        getSessionId: () => "session",
        getBranch: () => branch,
        getLeafEntry: () => branch.at(-1),
        getEntry: (id: string) => branch.find((entry) => entry.id === id),
      },
      ui: {
        notify: (message: string, level?: string) => notifications.push({ message, level }),
      },
    },
    notifications,
  };
}
