import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type {
  CandidateWorktree,
  FrozenRepositoryState,
  LavRepository,
  LavRepositoryFactory,
} from "./types.js";

export class GitCommandError extends Error {
  constructor(
    readonly cwd: string,
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(
      `git ${args.join(" ")} failed${exitCode === null ? "" : ` with exit code ${exitCode}`}: ${
        stderr.trim() || "no error output"
      }`,
    );
    this.name = "GitCommandError";
  }
}

export class GitLavRepositoryFactory implements LavRepositoryFactory {
  async open(
    cwd: string,
    candidateCount: number,
    signal: AbortSignal,
  ): Promise<LavRepository> {
    return GitLavRepository.open(cwd, candidateCount, signal);
  }
}

export class GitLavRepository implements LavRepository {
  readonly worktrees: readonly CandidateWorktree[];

  private constructor(
    readonly repoRoot: string,
    readonly baseCommit: string,
    worktrees: readonly CandidateWorktree[],
    private readonly temporaryRoot: string,
  ) {
    this.worktrees = worktrees;
  }

  static async open(
    cwd: string,
    candidateCount: number,
    signal: AbortSignal,
  ): Promise<GitLavRepository> {
    if (!Number.isInteger(candidateCount) || candidateCount < 1) {
      throw new Error("candidateCount must be a positive integer");
    }
    throwIfAborted(signal);

    const repoRoot = resolve(
      (await git(cwd, ["rev-parse", "--show-toplevel"], { signal })).stdout.trim(),
    );
    const status = await git(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"], {
      signal,
    });
    if (status.stdout.trim()) {
      throw new Error(
        "V1 /lav-run requires a clean primary worktree. Commit, stash, or remove " +
          "existing changes before running.",
      );
    }
    const baseCommit = (await git(repoRoot, ["rev-parse", "HEAD"], { signal })).stdout.trim();
    const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-lav-run-"));
    const worktrees: CandidateWorktree[] = [];

    try {
      for (let candidateIndex = 0; candidateIndex < candidateCount; candidateIndex += 1) {
        throwIfAborted(signal);
        const path = join(
          temporaryRoot,
          `candidate-${String(candidateIndex + 1).padStart(3, "0")}`,
        );
        await mkdir(path, { recursive: true });
        await git(repoRoot, ["worktree", "add", "--detach", path, baseCommit], { signal });
        worktrees.push({ candidateIndex, path });
      }
      return new GitLavRepository(repoRoot, baseCommit, worktrees, temporaryRoot);
    } catch (error) {
      const partial = new GitLavRepository(repoRoot, baseCommit, worktrees, temporaryRoot);
      await partial.cleanup();
      throw error;
    }
  }

  async freeze(
    worktree: CandidateWorktree,
    signal: AbortSignal,
  ): Promise<FrozenRepositoryState> {
    this.assertOwnedWorktree(worktree);
    throwIfAborted(signal);

    const head = (await git(worktree.path, ["rev-parse", "HEAD"], { signal })).stdout.trim();
    if (head !== this.baseCommit) {
      throw new Error(
        `Candidate ${worktree.candidateIndex + 1} moved HEAD from frozen base ` +
          `${this.baseCommit}; committed candidate state is not accepted.`,
      );
    }
    const status = (
      await git(worktree.path, ["status", "--porcelain=v1", "--untracked-files=all"], { signal })
    ).stdout;
    try {
      await git(worktree.path, ["add", "--intent-to-add", "--all"], { signal });
      const patch = (
        await git(
          worktree.path,
          ["diff", "--binary", "--full-index", "--no-ext-diff", "--no-color", "HEAD", "--"],
          { signal },
        )
      ).stdout;
      return {
        patch,
        patchHash: createHash("sha256").update(patch).digest("hex"),
        status,
      };
    } finally {
      await git(worktree.path, ["reset", "--mixed", "--quiet", "HEAD", "--"], {
        allowFailure: true,
      });
    }
  }

  async applyFrozenPatch(patch: string, signal: AbortSignal): Promise<boolean> {
    throwIfAborted(signal);
    await this.assertPrimaryUnchanged(signal);
    if (!patch.trim()) return false;

    await git(
      this.repoRoot,
      ["apply", "--check", "--binary", "--recount", "--whitespace=nowarn", "-"],
      { input: patch, signal },
    );
    await git(
      this.repoRoot,
      ["apply", "--binary", "--recount", "--whitespace=nowarn", "-"],
      { input: patch, signal },
    );
    return true;
  }

  async cleanup(): Promise<void> {
    for (const worktree of [...this.worktrees].reverse()) {
      await git(this.repoRoot, ["worktree", "remove", "--force", worktree.path], {
        allowFailure: true,
      });
      await rm(worktree.path, { recursive: true, force: true });
    }
    await git(this.repoRoot, ["worktree", "prune"], { allowFailure: true });
    await rm(this.temporaryRoot, { recursive: true, force: true });
  }

  private async assertPrimaryUnchanged(signal: AbortSignal): Promise<void> {
    const head = (await git(this.repoRoot, ["rev-parse", "HEAD"], { signal })).stdout.trim();
    if (head !== this.baseCommit) {
      throw new Error(
        `Primary worktree drifted from frozen base ${this.baseCommit} to ${head}; ` +
          "the winning patch was not applied.",
      );
    }
    const status = await git(
      this.repoRoot,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { signal },
    );
    if (status.stdout.trim()) {
      throw new Error(
        "Primary worktree changed while /lav-run was active; the winning patch was not applied.",
      );
    }
  }

  private assertOwnedWorktree(worktree: CandidateWorktree): void {
    const owned = this.worktrees.find(
      (candidate) =>
        candidate.candidateIndex === worktree.candidateIndex && candidate.path === worktree.path,
    );
    if (!owned) throw new Error(`Candidate worktree is not owned by this run: ${worktree.path}`);
  }
}

interface GitOptions {
  input?: string;
  signal?: AbortSignal;
  allowFailure?: boolean;
}

async function git(
  cwd: string,
  args: readonly string[],
  options: GitOptions = {},
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  if (options.signal?.aborted) throw abortError();

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("git", ["-C", cwd, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => {
      child.kill("SIGTERM");
    };

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => finish(() => rejectPromise(error)));
    child.on("close", (exitCode) => {
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode,
      };
      if (options.signal?.aborted) {
        finish(() => rejectPromise(abortError()));
        return;
      }
      if (exitCode !== 0 && !options.allowFailure) {
        finish(() =>
          rejectPromise(new GitCommandError(cwd, args, exitCode, result.stderr)),
        );
        return;
      }
      finish(() => resolvePromise(result));
    });

    if (options.signal) {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

export function abortError(): Error {
  const error = new Error("LAV run cancelled");
  error.name = "AbortError";
  return error;
}
