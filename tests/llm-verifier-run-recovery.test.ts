import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertCachePathOutsideRepository,
  resolveLavCachePath,
} from "../pi-extensions/llm-verifier/run/cache-path.js";
import { GitLavRepository } from "../pi-extensions/llm-verifier/run/git.js";
import { runLav } from "../pi-extensions/llm-verifier/run/orchestrator.js";
import type {
  CandidateExecution,
  CandidateSelectionResult,
  CandidateWorktree,
  FrozenRepositoryState,
  LavProgressEvent,
  LavRepository,
  LavRunConfig,
} from "../pi-extensions/llm-verifier/run/types.js";

describe("LAV cache and recovery policy", () => {
  it("roots relative caches under Pi state and rejects repository-local caches", () => {
    expect(resolveLavCachePath("scores.json", "/home/test/.pi/agent")).toBe(
      "/home/test/.pi/agent/llm-verifier-cache/scores.json",
    );
    expect(() => resolveLavCachePath("../scores.json", "/home/test/.pi/agent")).toThrow(
      "escapes Pi's cache directory",
    );
    expect(() =>
      assertCachePathOutsideRepository("/repo", "/repo/.lav-cache.json"),
    ).toThrow("outside the guarded repository");
  });

  it("rejects an external cache symlink that resolves into the primary worktree", async () => {
    const repo = await createRepository();
    const external = await mkdtemp(join(tmpdir(), "lav-cache-symlink-test-"));
    try {
      const repositoryLink = join(external, "repository-link");
      await symlink(repo, repositoryLink, process.platform === "win32" ? "junction" : "dir");

      expect(() =>
        assertCachePathOutsideRepository(repo, join(repositoryLink, "new", "scores.json")),
      ).toThrow("outside the guarded repository");
    } finally {
      await rm(external, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("preserves the exact winning patch after worktree cleanup", async () => {
    const repo = await createRepository();
    const signal = new AbortController().signal;
    const lav = await GitLavRepository.open(repo, 1, signal);
    let recoveryPath = "";
    let patch = "";
    try {
      await writeFile(join(lav.worktrees[0].path, "tracked.txt"), "winner\n");
      const frozen = await lav.freeze(lav.worktrees[0], signal);
      patch = frozen.patch;
      recoveryPath = await lav.preserveFrozenPatch(
        frozen.patch,
        frozen.patchHash,
        0,
        signal,
      );
      await writeFile(join(repo, "tracked.txt"), "user drift\n");
      await expect(lav.applyFrozenPatch(frozen.patch, signal)).rejects.toThrow(
        "Primary worktree changed",
      );
    } finally {
      await lav.cleanup();
    }
    expect(await readFile(recoveryPath, "utf8")).toBe(patch);
    await rm(repo, { recursive: true, force: true });
  });

  it("returns recovery details when automatic application is unsafe", async () => {
    const repository = new RecoveryRepository();
    const result = await runLav(
      "/repo",
      config(),
      {
        repositoryFactory: { open: async () => repository },
        candidateRunner: { run: async () => completed() },
        selector: { select: async () => singletonSelection() },
      },
      new AbortController().signal,
    );

    expect(result.applied).toBe(false);
    expect(result.applicationError).toBe("primary drift");
    expect(result.winnerPatchPath).toBe("/repo/.git/pi-lav-recovery/winner.patch");
    expect(repository.cleanupCount).toBe(1);
  });

  it("preserves a completed recovery result when cleanup also fails", async () => {
    const repository = new RecoveryRepository("cleanup failed");
    const progress: LavProgressEvent[] = [];
    const result = await runLav(
      "/repo",
      config(),
      {
        repositoryFactory: { open: async () => repository },
        candidateRunner: { run: async () => completed() },
        selector: { select: async () => singletonSelection() },
        onProgress: (event) => progress.push(event),
      },
      new AbortController().signal,
    );

    expect(result.applied).toBe(false);
    expect(result.applicationError).toBe("primary drift");
    expect(result.winnerPatchPath).toBe("/repo/.git/pi-lav-recovery/winner.patch");
    expect(result.cleanupError).toBe("cleanup failed");
    expect(progress.at(-1)).toEqual({ type: "cleanup-finished", error: "cleanup failed" });
    expect(repository.cleanupCount).toBe(1);
  });
});

class RecoveryRepository implements LavRepository {
  readonly repoRoot = "/repo";
  readonly baseCommit = "base";
  readonly worktrees: readonly CandidateWorktree[] = [{ candidateIndex: 0, path: "/tmp/candidate" }];
  cleanupCount = 0;

  constructor(private readonly cleanupFailure?: string) {}

  async freeze(): Promise<FrozenRepositoryState> {
    return { patch: "patch", patchHash: "hash", status: " M tracked.txt" };
  }

  async preserveFrozenPatch(): Promise<string> {
    return "/repo/.git/pi-lav-recovery/winner.patch";
  }

  async applyFrozenPatch(): Promise<boolean> {
    throw new Error("primary drift");
  }

  async cleanup(): Promise<void> {
    this.cleanupCount += 1;
    if (this.cleanupFailure) throw new Error(this.cleanupFailure);
  }
}

function config(): LavRunConfig {
  return {
    task: "fix it",
    candidateCount: 1,
    verifierModelRef: "",
    criteria: [{ id: "correctness", name: "Correctness", description: "Judge it." }],
    repetitions: 1,
    pivots: 0,
    seed: 0,
    candidateConcurrency: 1,
    verifierConcurrency: 1,
    applyWinner: true,
  };
}

function completed(): CandidateExecution {
  return { status: "completed", actions: [], finalMessage: "done" };
}

function singletonSelection(): CandidateSelectionResult {
  return {
    index: 0,
    ranking: [0],
    meanPreferences: [0],
    wins: [0],
    counts: [0],
    pivots: [],
    ringPairs: [],
    pivotPairs: [],
    nComparisons: 0,
  };
}

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "lav-recovery-test-"));
  git(directory, "init", "--quiet");
  git(directory, "config", "user.email", "lav@example.test");
  git(directory, "config", "user.name", "LAV Test");
  await writeFile(join(directory, "tracked.txt"), "base\n");
  git(directory, "add", "tracked.txt");
  git(directory, "commit", "--quiet", "-m", "initial");
  return directory;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}
