import { readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createRepository, git } from "./helpers/lav-repository.js";

import { GitLavRepository } from "../pi-extensions/llm-verifier/run/git.js";
import {
  CleanupFailedError,
  runLav,
} from "../pi-extensions/llm-verifier/run/orchestrator.js";
import type {
  CandidateExecution,
  CandidateWorktree,
  FrozenRepositoryState,
  LavRepository,
  LavRunConfig,
} from "../pi-extensions/llm-verifier/run/types.js";

describe("LAV review follow-ups", () => {
  it("captures status after the patch and normalizes intent-to-add entries", async () => {
    const repo = await createRepository();
    const signal = new AbortController().signal;
    const lav = await GitLavRepository.open(repo, 1, signal);
    try {
      const worktree = lav.worktrees[0];
      await writeFile(join(worktree.path, "tracked.txt"), "changed\n");
      await writeFile(join(worktree.path, "new.txt"), "new\n");

      const frozen = await lav.freeze(worktree, signal);

      expect(frozen.patch).toContain("diff --git a/new.txt b/new.txt");
      expect(frozen.patch).toContain("diff --git a/tracked.txt b/tracked.txt");
      expect(frozen.status).toContain("?? new.txt");
      expect(frozen.status).toContain(" M tracked.txt");
      expect(frozen.status).not.toContain(" A new.txt");
    } finally {
      await lav.cleanup();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("rejects malformed and mismatched frozen patch hashes", async () => {
    const repo = await createRepository();
    const signal = new AbortController().signal;
    const lav = await GitLavRepository.open(repo, 1, signal);
    try {
      const worktree = lav.worktrees[0];
      await writeFile(join(worktree.path, "tracked.txt"), "changed\n");
      const frozen = await lav.freeze(worktree, signal);

      await expect(
        lav.preserveFrozenPatch(frozen.patch, "not-a-hash", 0, signal),
      ).rejects.toThrow("64-character hexadecimal SHA-256 digest");
      await expect(
        lav.preserveFrozenPatch(frozen.patch, "0".repeat(64), 0, signal),
      ).rejects.toThrow("does not match patch bytes");
    } finally {
      await lav.cleanup();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("propagates cancellation immediately after preserving the recovery patch", async () => {
    const repo = await createRepository();
    const signal = new AbortController().signal;
    const lav = await GitLavRepository.open(repo, 1, signal);
    try {
      const worktree = lav.worktrees[0];
      await writeFile(join(worktree.path, "tracked.txt"), "changed\n");
      const frozen = await lav.freeze(worktree, signal);
      let abortChecks = 0;
      const postRenameAbortSignal = {
        get aborted() {
          abortChecks += 1;
          return abortChecks >= 3;
        },
      } as unknown as AbortSignal;

      await expect(
        lav.preserveFrozenPatch(frozen.patch, frozen.patchHash, 0, postRenameAbortSignal),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(abortChecks).toBe(3);
      expect(await readdir(join(repo, ".git", "pi-lav-recovery"))).toHaveLength(1);
    } finally {
      await lav.cleanup();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("wraps primary and cleanup failures in CleanupFailedError", async () => {
    const repository = new CleanupFailingRepository();
    let caught: unknown;
    try {
      await runLav(
        "/repo",
        config(),
        {
          repositoryFactory: { open: async () => repository },
          candidateRunner: { run: async () => completed() },
          selector: {
            select: async () => {
              throw new Error("verifier failed");
            },
          },
        },
        new AbortController().signal,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CleanupFailedError);
    if (!(caught instanceof CleanupFailedError)) {
      throw new Error("Expected CleanupFailedError");
    }
    expect(caught.primaryError).toMatchObject({ message: "verifier failed" });
    expect(caught.cleanupError).toBe("cleanup failed");
    expect(caught.cause).toBe(caught.primaryError);
  });
});

class CleanupFailingRepository implements LavRepository {
  readonly repoRoot = "/repo";
  readonly baseCommit = "base";
  readonly worktrees: readonly CandidateWorktree[] = [
    { candidateIndex: 0, path: "/tmp/candidate-0" },
    { candidateIndex: 1, path: "/tmp/candidate-1" },
  ];

  async freeze(worktree: CandidateWorktree): Promise<FrozenRepositoryState> {
    return {
      patch: `patch-${worktree.candidateIndex}`,
      patchHash: "hash",
      status: " M tracked.txt",
    };
  }

  async preserveFrozenPatch(): Promise<string> {
    return "/tmp/recovery.patch";
  }

  async applyFrozenPatch(): Promise<boolean> {
    return false;
  }

  async cleanup(): Promise<void> {
    throw new Error("cleanup failed");
  }
}

function config(): LavRunConfig {
  return {
    task: "fix it",
    candidateCount: 2,
    verifierModelRef: "provider/model",
    criteria: [{ id: "correctness", name: "Correctness", description: "Judge it." }],
    repetitions: 1,
    pivots: 0,
    seed: 0,
    candidateConcurrency: 1,
    verifierConcurrency: 1,
    applyWinner: false,
  };
}

function completed(): CandidateExecution {
  return { status: "completed", actions: [], finalMessage: "done" };
}
