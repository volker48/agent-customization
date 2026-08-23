import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseLavRunArgs } from "../pi-extensions/llm-verifier/run/args.js";
import {
  buildCandidateEvidence,
  redactEvidenceText,
} from "../pi-extensions/llm-verifier/run/evidence.js";
import {
  abortError,
  GitLavRepository,
} from "../pi-extensions/llm-verifier/run/git.js";
import { runLav } from "../pi-extensions/llm-verifier/run/orchestrator.js";
import type {
  CandidateExecution,
  CandidateRunner,
  CandidateSelectionInput,
  CandidateSelectionResult,
  CandidateSelector,
  CandidateWorktree,
  FrozenRepositoryState,
  LavRepository,
  LavRepositoryFactory,
  LavRunConfig,
} from "../pi-extensions/llm-verifier/run/types.js";

describe("/lav-run arguments", () => {
  it("parses deterministic orchestration settings and a task", () => {
    const parsed = parseLavRunArgs(
      [
        "--candidates 2",
        "--verifier openrouter/example/model",
        "--criteria task_correctness,repository_fit",
        "--repetitions=3 --pivots 1 --seed 42",
        "--candidate-concurrency 2 --verifier-concurrency 6",
        '--no-apply -- "fix the parser"',
      ].join(" "),
    );
    expect(parsed.error).toBeUndefined();
    expect(parsed.config).toMatchObject({
      task: "fix the parser",
      candidateCount: 2,
      verifierModelRef: "openrouter/example/model",
      repetitions: 3,
      pivots: 1,
      seed: 42,
      candidateConcurrency: 2,
      verifierConcurrency: 6,
      applyWinner: false,
    });
    expect(parsed.config?.criteria.map((criterion) => criterion.id)).toEqual([
      "task_correctness",
      "repository_fit",
    ]);
  });

  it("allows the one-candidate path without a verifier model", () => {
    const parsed = parseLavRunArgs("--candidates 1 -- update docs");
    expect(parsed.error).toBeUndefined();
    expect(parsed.config?.verifierModelRef).toBe("");
  });

  it("ignores a malformed default verifier on the one-candidate path", () => {
    const parsed = parseLavRunArgs("--candidates 1 -- update docs", {
      verifierModelRef: "malformed-model-ref",
    });
    expect(parsed.error).toBeUndefined();
    expect(parsed.config?.verifierModelRef).toBe("malformed-model-ref");
  });

  it("rejects unknown criteria and missing multi-candidate verifier configuration", () => {
    expect(parseLavRunArgs("--criteria nope -- task").error).toContain("Unknown criterion");
    expect(parseLavRunArgs("--candidates 2 -- task").error).toContain("verifier model");
  });
});

describe("candidate evidence", () => {
  it("canonicalizes incidental worktree paths and redacts credentials", () => {
    const make = (repoRoot: string, worktreePath: string) =>
      buildCandidateEvidence({
        task: "Fix it\r\n",
        candidateIndex: 0,
        status: "completed",
        baseCommit: "abc",
        patch: "diff --git a/a b/a\n+token=super-secret-value\n",
        patchHash: "hash",
        repositoryStatus: " M a\n",
        actions: [
          {
            sequence: 99,
            kind: "tool",
            toolName: "bash",
            input: `{"command":"pwd","cwd":"${worktreePath}"}`,
            output: `${worktreePath}\nAuthorization: Bearer secret-value`,
            isError: false,
          },
        ],
        finalMessage: `Changed ${repoRoot}/a`,
        error: "",
        repoRoot,
        worktreePath,
      }).evidence;

    const first = make("/repo", "/tmp/run-a/candidate");
    const second = make("/repo", "/tmp/run-b/candidate");
    expect(first).toBe(second);
    expect(first).toContain("<WORKTREE>");
    expect(first).toContain("<REPOSITORY>");
    expect(first).not.toContain("super-secret-value");
    expect(first).not.toContain("secret-value");
  });

  it("redacts common secret forms", () => {
    const result = redactEvidenceText(
      "api_key=abcdef token=second Bearer top-secret " +
        "ghp_abcdefghijklmnopqrstuvwxyz012345 " +
        "OPENAI_API_KEY=openai-secret AWS_SECRET_ACCESS_KEY=aws-secret",
    );
    expect(result.value).toContain("api_key=[REDACTED]");
    expect(result.value).toContain("token=[REDACTED]");
    expect(result.value).toContain("Bearer [REDACTED]");
    expect(result.value).toContain("[REDACTED SECRET]");
    expect(result.value).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(result.value).toContain("AWS_SECRET_ACCESS_KEY=[REDACTED]");
    expect(result.redactionCount).toBe(6);
  });

  it("redacts and bounds task text before publishing evidence", () => {
    const result = buildCandidateEvidence({
      task: `OPENAI_API_KEY=task-secret ${"x".repeat(20_000)}`,
      candidateIndex: 0,
      status: "completed",
      baseCommit: "abc",
      patch: "",
      patchHash: "hash",
      repositoryStatus: "",
      actions: [],
      finalMessage: "done",
      error: "",
      repoRoot: "/repo",
      worktreePath: "/tmp/candidate",
    });
    const packet = JSON.parse(result.evidence) as { task: string };

    expect(packet.task).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(packet.task).not.toContain("task-secret");
    expect(packet.task).toContain("[TRUNCATED ");
    expect(packet.task.length).toBeLessThanOrEqual(12_000);
  });
});

describe("Git worktree isolation and frozen patches", () => {
  it("isolates candidates, includes untracked files, and cleans worktrees", async () => {
    const repo = await createRepository();
    const signal = new AbortController().signal;
    const lav = await GitLavRepository.open(repo, 2, signal);
    try {
      const first = lav.worktrees[0];
      const second = lav.worktrees[1];
      await writeFile(join(first.path, "tracked.txt"), "candidate one\n");
      await writeFile(join(first.path, "new.txt"), "new file\n");

      expect(await readFile(join(second.path, "tracked.txt"), "utf8")).toBe("base\n");
      const frozen = await lav.freeze(first, signal);
      expect(frozen.patch).toContain("candidate one");
      expect(frozen.patch).toContain("new file");
      expect(frozen.status).toContain("tracked.txt");
      expect(frozen.status).toContain("new.txt");
    } finally {
      await lav.cleanup();
      const worktreeList = git(repo, "worktree", "list", "--porcelain");
      expect(worktreeList.match(/^worktree /gm)).toHaveLength(1);
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("applies only a checked frozen patch to an unchanged primary worktree", async () => {
    const repo = await createRepository();
    const signal = new AbortController().signal;
    const lav = await GitLavRepository.open(repo, 1, signal);
    try {
      await writeFile(join(lav.worktrees[0].path, "tracked.txt"), "winner\n");
      const frozen = await lav.freeze(lav.worktrees[0], signal);
      await expect(lav.applyFrozenPatch(frozen.patch, signal)).resolves.toBe(true);
      expect(await readFile(join(repo, "tracked.txt"), "utf8")).toBe("winner\n");
    } finally {
      await lav.cleanup();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("refuses winner application after primary-worktree drift", async () => {
    const repo = await createRepository();
    const signal = new AbortController().signal;
    const lav = await GitLavRepository.open(repo, 1, signal);
    try {
      await writeFile(join(lav.worktrees[0].path, "tracked.txt"), "winner\n");
      const frozen = await lav.freeze(lav.worktrees[0], signal);
      await writeFile(join(repo, "tracked.txt"), "user drift\n");
      await expect(lav.applyFrozenPatch(frozen.patch, signal)).rejects.toThrow(
        "Primary worktree changed",
      );
      expect(await readFile(join(repo, "tracked.txt"), "utf8")).toBe("user drift\n");
    } finally {
      await lav.cleanup();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("refuses to start with pre-existing user changes", async () => {
    const repo = await createRepository();
    await writeFile(join(repo, "untracked.txt"), "user work\n");
    await expect(
      GitLavRepository.open(repo, 2, new AbortController().signal),
    ).rejects.toThrow("requires a clean primary worktree");
    await rm(repo, { recursive: true, force: true });
  });

  it("rejects candidates that commit or move the frozen HEAD", async () => {
    const repo = await createRepository();
    const signal = new AbortController().signal;
    const lav = await GitLavRepository.open(repo, 1, signal);
    try {
      await writeFile(join(lav.worktrees[0].path, "tracked.txt"), "committed\n");
      git(lav.worktrees[0].path, "add", "tracked.txt");
      git(lav.worktrees[0].path, "commit", "--quiet", "-m", "candidate commit");
      await expect(lav.freeze(lav.worktrees[0], signal)).rejects.toThrow("moved HEAD");
    } finally {
      await lav.cleanup();
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe("LAV orchestration", () => {
  it(
    "keeps partial failures, verifies completed candidates, and applies the winner",
    async () => {
      const repository = new FakeRepository(3);
      const runner: CandidateRunner = {
        run: async ({ candidateIndex }) => {
          if (candidateIndex === 1) throw new Error("candidate model failed");
          return completed(`candidate ${candidateIndex}`);
        },
      };
      let selectorInput: CandidateSelectionInput | undefined;
      const selector: CandidateSelector = {
        select: async (input) => {
          selectorInput = input;
          return selection(1, [1, 0], "run-hash");
        },
      };

      const result = await runLav(
        "/repo",
        config({ candidateCount: 3, candidateConcurrency: 2 }),
        {
          repositoryFactory: fixedRepository(repository),
          candidateRunner: runner,
          selector,
        },
        new AbortController().signal,
      );

      expect(selectorInput?.candidates).toHaveLength(2);
      expect(result.eligibleCandidateIndices).toEqual([0, 2]);
      expect(result.selectedCandidateIndex).toBe(2);
      expect(result.ranking).toEqual([2, 0]);
      expect(result.candidates[1]).toMatchObject({
        status: "failed",
        error: "candidate model failed",
      });
      expect(repository.appliedPatch).toBe("patch-2");
      expect(repository.cleanupCount).toBe(1);
    },
  );

  it("keeps independent candidates after a repository freeze failure", async () => {
    const repository = new FakeRepository(3);
    repository.freezeFailures.set(0, "moved HEAD");
    let verifierCandidates = 0;

    const result = await runLav(
      "/repo",
      config({ candidateCount: 3 }),
      {
        repositoryFactory: fixedRepository(repository),
        candidateRunner: { run: async () => completed("candidate") },
        selector: {
          select: async (input) => {
            verifierCandidates = input.candidates.length;
            return selection(1, [1, 0]);
          },
        },
      },
      new AbortController().signal,
    );

    expect(verifierCandidates).toBe(2);
    expect(result.eligibleCandidateIndices).toEqual([1, 2]);
    expect(result.selectedCandidateIndex).toBe(2);
    expect(result.candidates[0]).toMatchObject({
      status: "failed",
      error: "Repository freeze failed: moved HEAD",
    });
    expect(repository.cleanupCount).toBe(1);
  });

  it("does not invoke the verifier for one completed candidate", async () => {
    const repository = new FakeRepository(1);
    let selectorCalls = 0;
    const result = await runLav(
      "/repo",
      config({
        candidateCount: 1,
        candidateConcurrency: 1,
        verifierModelRef: "",
      }),
      {
        repositoryFactory: fixedRepository(repository),
        candidateRunner: { run: async () => completed("only") },
        selector: {
          select: async () => {
            selectorCalls += 1;
            throw new Error("unexpected verifier call");
          },
        },
      },
      new AbortController().signal,
    );

    expect(selectorCalls).toBe(0);
    expect(result.selectedCandidateIndex).toBe(0);
    expect(result.ranking).toEqual([0]);
  });

  it("bounds candidate concurrency", async () => {
    const repository = new FakeRepository(5);
    let active = 0;
    let maximum = 0;
    const runner: CandidateRunner = {
      run: async ({ candidateIndex }) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await delay(15);
        active -= 1;
        return completed(String(candidateIndex));
      },
    };

    await runLav(
      "/repo",
      config({ candidateCount: 5, candidateConcurrency: 2, applyWinner: false }),
      {
        repositoryFactory: fixedRepository(repository),
        candidateRunner: runner,
        selector: { select: async () => selection(0, [0, 1, 2, 3, 4]) },
      },
      new AbortController().signal,
    );

    expect(maximum).toBe(2);
    expect(repository.cleanupCount).toBe(1);
  });

  it("cleans up when verifier selection fails", async () => {
    const repository = new FakeRepository(2);
    await expect(
      runLav(
        "/repo",
        config({ candidateCount: 2 }),
        {
          repositoryFactory: fixedRepository(repository),
          candidateRunner: { run: async () => completed("candidate") },
          selector: {
            select: async () => {
              throw new Error("verifier unavailable");
            },
          },
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("verifier unavailable");
    expect(repository.cleanupCount).toBe(1);
  });

  it("checks repository policy before verifier preflight", async () => {
    let preflightCalls = 0;
    await expect(
      runLav(
        "/repo",
        config({ candidateCount: 2 }),
        {
          repositoryFactory: {
            open: async () => {
              throw new Error("primary worktree is dirty");
            },
          },
          candidateRunner: { run: async () => completed("candidate") },
          selector: { select: async () => selection(0, [0, 1]) },
          preflight: async () => {
            preflightCalls += 1;
          },
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("primary worktree is dirty");
    expect(preflightCalls).toBe(0);
  });

  it("keeps advisory progress failures from leaking worktrees", async () => {
    const repository = new FakeRepository(1);
    const result = await runLav(
      "/repo",
      config({ candidateCount: 1, candidateConcurrency: 1 }),
      {
        repositoryFactory: fixedRepository(repository),
        candidateRunner: { run: async () => completed("candidate") },
        selector: { select: async () => selection(0, [0]) },
        onProgress: () => {
          throw new Error("render failed");
        },
      },
      new AbortController().signal,
    );
    expect(result.selectedCandidateIndex).toBe(0);
    expect(repository.cleanupCount).toBe(1);
  });

  it("propagates cancellation, stops queued candidates, and cleans up", async () => {
    const repository = new FakeRepository(5);
    const controller = new AbortController();
    const started: number[] = [];
    const runner: CandidateRunner = {
      run: async ({ candidateIndex, signal }) => {
        started.push(candidateIndex);
        await new Promise<void>((_resolve, reject) => {
          const onAbort = () => reject(abortError());
          signal.addEventListener("abort", onAbort, { once: true });
        });
        return completed("unreachable");
      },
    };

    const promise = runLav(
      "/repo",
      config({ candidateCount: 5, candidateConcurrency: 2 }),
      {
        repositoryFactory: fixedRepository(repository),
        candidateRunner: runner,
        selector: { select: async () => selection(0, [0]) },
      },
      controller.signal,
    );
    await delay(10);
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(started).toHaveLength(2);
    expect(repository.cleanupCount).toBe(1);
  });
});

class FakeRepository implements LavRepository {
  readonly repoRoot = "/repo";
  readonly baseCommit = "base";
  readonly worktrees: readonly CandidateWorktree[];
  appliedPatch = "";
  preservedPatch = "";
  cleanupCount = 0;
  readonly freezeFailures = new Map<number, string>();

  constructor(candidateCount: number) {
    this.worktrees = Array.from({ length: candidateCount }, (_, candidateIndex) => ({
      candidateIndex,
      path: `/tmp/candidate-${candidateIndex}`,
    }));
  }

  async freeze(worktree: CandidateWorktree): Promise<FrozenRepositoryState> {
    const failure = this.freezeFailures.get(worktree.candidateIndex);
    if (failure) throw new Error(failure);
    return {
      patch: `patch-${worktree.candidateIndex}`,
      patchHash: `hash-${worktree.candidateIndex}`,
      status: `status-${worktree.candidateIndex}`,
    };
  }

  async preserveFrozenPatch(patch: string): Promise<string> {
    this.preservedPatch = patch;
    return "/tmp/recovery.patch";
  }

  async applyFrozenPatch(patch: string): Promise<boolean> {
    this.appliedPatch = patch;
    return Boolean(patch);
  }

  async cleanup(): Promise<void> {
    this.cleanupCount += 1;
  }
}

function fixedRepository(repository: LavRepository): LavRepositoryFactory {
  return {
    open: async () => repository,
  };
}

function config(overrides: Partial<LavRunConfig> = {}): LavRunConfig {
  return {
    task: "fix the bug",
    candidateCount: 3,
    verifierModelRef: "provider/model",
    criteria: [
      {
        id: "correctness",
        name: "Correctness",
        description: "Judge correctness.",
      },
    ],
    repetitions: 2,
    pivots: 2,
    seed: 0,
    candidateConcurrency: 2,
    verifierConcurrency: 2,
    applyWinner: true,
    ...overrides,
  };
}

function completed(finalMessage: string): CandidateExecution {
  return {
    status: "completed",
    actions: [],
    finalMessage,
  };
}

function selection(
  index: number,
  ranking: number[],
  runHash?: string,
): CandidateSelectionResult {
  const count = ranking.length;
  return {
    index,
    ranking,
    meanPreferences: new Array(count).fill(0),
    wins: new Array(count).fill(0),
    counts: new Array(count).fill(0),
    pivots: [],
    ringPairs: [],
    pivotPairs: [],
    nComparisons: 0,
    runHash,
  };
}

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "lav-run-test-"));
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
