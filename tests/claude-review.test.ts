import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import claudeReviewExtension, {
  buildCodeReviewPrompt,
  claudeArgs,
  parseClaudeReviewArgs,
} from "../pi-extensions/claude-review/index.js";
import {
  CLAUDE_REVIEW_RESULT_END,
  CLAUDE_REVIEW_RESULT_START,
} from "../pi-extensions/claude-review/args.js";
import {
  cancelClaudeBackgroundJob,
  extractMarkedReview,
  readClaudeBackgroundLogs,
  refreshClaudeBackgroundJob,
  startClaudeBackgroundReview,
} from "../pi-extensions/claude-review/claude-bg.js";
import { readJob } from "../pi-extensions/claude-review/jobs.js";
import type { ClaudeReviewJob } from "../pi-extensions/claude-review/jobs.js";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  BorderedLoader: class {
    onAbort?: () => void;
  },
  getMarkdownTheme: () => ({}),
}));

vi.mock("@earendil-works/pi-tui", () => ({
  Markdown: class {
    constructor(
      public text: string,
      public paddingX: number,
      public paddingY: number,
      public theme: unknown,
    ) {}
  },
}));

type RegisteredCommand = {
  handler: (args: string, ctx: MockCommandContext) => Promise<void>;
};

type MockCommandContext = {
  cwd: string;
  waitForIdle: () => Promise<void>;
  ui: {
    notify: (message: string, type?: "info" | "warning" | "error") => void;
    setStatus: (key: string, value: string | undefined) => void;
    setWidget: (key: string, value: unknown) => void;
  };
};

function createMockPi(execResult = { stdout: "review", stderr: "", code: 0, killed: false }) {
  const commands = new Map<string, RegisteredCommand>();
  return {
    pi: {
      registerMessageRenderer: vi.fn(),
      registerCommand: vi.fn((_name: string, registered: RegisteredCommand) => {
        commands.set(_name, registered);
      }),
      exec: vi.fn(async () => execResult),
      sendUserMessage: vi.fn(),
      sendMessage: vi.fn(),
    },
    command(name = "claude-review") {
      const command = commands.get(name);
      if (!command) throw new Error("missing command");
      return command;
    },
  };
}

function createContext(): MockCommandContext {
  return {
    cwd: "/repo",
    waitForIdle: vi.fn(async () => undefined),
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
  };
}

function createBackgroundJob(overrides: Partial<ClaudeReviewJob> = {}): ClaudeReviewJob {
  const now = new Date("2026-01-01T00:00:00.000Z").toISOString();
  return {
    id: "claude-review-20260101000000-abcdef12",
    backend: "claude-bg",
    cwd: "/repo",
    level: "medium",
    contextMessage: "",
    autoFix: true,
    prompt: "/code-review medium",
    claudeSessionId: "session-123",
    claudeSessionName: "pi-claude-review:claude-review-20260101000000-abcdef12",
    status: "running",
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    exitCode: null,
    stdout: "",
    stderr: "",
    lastLog: "",
    errorMessage: null,
    ...overrides,
  };
}

describe("claude review arguments", () => {
  it("defaults to auto-fix medium review with optional empty context", () => {
    expect(parseClaudeReviewArgs("")).toEqual({
      autoFix: true,
      level: "medium",
      contextMessage: "",
      mode: "background",
    });
  });

  it("parses --no-fix, level, and context message", () => {
    expect(parseClaudeReviewArgs("--no-fix high read issue #23")).toEqual({
      autoFix: false,
      level: "high",
      contextMessage: "read issue #23",
      mode: "background",
    });
  });

  it("rejects ultra for headless review runs", () => {
    expect(() => parseClaudeReviewArgs("ultra review deeply")).toThrow(/ultra/);
  });

  it("builds the Claude Code slash-command prompt", () => {
    const options = parseClaudeReviewArgs("max inspect the current branch");
    expect(buildCodeReviewPrompt(options)).toBe("/code-review max inspect the current branch");
  });
});

describe("claude review command", () => {
  const originalBin = process.env.PI_CLAUDE_REVIEW_BIN;
  const originalJobDir = process.env.PI_CLAUDE_REVIEW_JOB_DIR;
  const tempDirs: string[] = [];

  afterEach(async () => {
    if (originalBin === undefined) {
      delete process.env.PI_CLAUDE_REVIEW_BIN;
    } else {
      process.env.PI_CLAUDE_REVIEW_BIN = originalBin;
    }
    if (originalJobDir === undefined) {
      delete process.env.PI_CLAUDE_REVIEW_JOB_DIR;
    } else {
      process.env.PI_CLAUDE_REVIEW_JOB_DIR = originalJobDir;
    }
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
  });

  it("runs Claude Code and asks Pi to fix successful review findings", async () => {
    process.env.PI_CLAUDE_REVIEW_BIN = "fake-claude";
    const { pi, command } = createMockPi({
      stdout: "Finding: fix the edge case",
      stderr: "",
      code: 0,
      killed: false,
    });
    claudeReviewExtension(pi as never);
    const ctx = createContext();

    await command().handler("--wait high read issue #23", ctx);

    expect(ctx.waitForIdle).toHaveBeenCalledOnce();
    expect(pi.exec).toHaveBeenCalledWith(
      "fake-claude",
      claudeArgs("/code-review high read issue #23"),
      expect.objectContaining({ cwd: "/repo", timeout: 20 * 60 * 1000 }),
    );
    expect(pi.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("Finding: fix the edge case"),
    );
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("records successful reviews without triggering Pi when --no-fix is set", async () => {
    const { pi, command } = createMockPi({
      stdout: "Looks good",
      stderr: "",
      code: 0,
      killed: false,
    });
    claudeReviewExtension(pi as never);
    const ctx = createContext();

    await command().handler("--wait --no-fix low", ctx);

    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "claude-review",
        display: true,
        content: expect.stringContaining("- Auto-fix: `off`"),
        details: expect.objectContaining({ autoFix: false }),
      }),
    );
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("surfaces non-zero review output without triggering Pi", async () => {
    const { pi, command } = createMockPi({
      stdout: "partial output",
      stderr: "permission denied",
      code: 2,
      killed: false,
    });
    claudeReviewExtension(pi as never);
    const ctx = createContext();

    await command().handler("--wait medium", ctx);

    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("- Auto-fix: `on`"),
        details: expect.objectContaining({ status: "failed", autoFix: true }),
      }),
    );
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Claude review failed with exit code 2", "error");
  });

  it("waits for Pi to become idle before creating and starting a background job", async () => {
    process.env.PI_CLAUDE_REVIEW_BIN = "fake-claude";
    const jobDir = await mkdtemp(join(tmpdir(), "claude-review-jobs-"));
    tempDirs.push(jobDir);
    process.env.PI_CLAUDE_REVIEW_JOB_DIR = jobDir;
    const events: string[] = [];
    const { pi, command } = createMockPi({
      stdout: "backgrounded · session-123456",
      stderr: "",
      code: 0,
      killed: false,
    });
    pi.exec.mockImplementation(async () => {
      events.push("exec");
      return {
        stdout: "backgrounded · session-123456",
        stderr: "",
        code: 0,
        killed: false,
      };
    });
    claudeReviewExtension(pi as never);
    const ctx = createContext();
    ctx.waitForIdle = vi.fn(async () => {
      events.push("wait");
      await expect(readdir(jobDir)).resolves.toEqual([]);
    });

    await command().handler("--no-fix low", ctx);

    expect(events).toEqual(["wait", "exec"]);
    await expect(readdir(jobDir)).resolves.toHaveLength(1);
    expect(pi.exec).toHaveBeenCalledWith(
      "fake-claude",
      expect.arrayContaining(["--bg", expect.stringContaining("/code-review low")]),
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("fails background starts that do not report a session id", async () => {
    const jobDir = await mkdtemp(join(tmpdir(), "claude-review-jobs-"));
    tempDirs.push(jobDir);
    process.env.PI_CLAUDE_REVIEW_JOB_DIR = jobDir;
    const { pi } = createMockPi({
      stdout: "background session started",
      stderr: "",
      code: 0,
      killed: false,
    });
    const job = createBackgroundJob({
      claudeSessionId: undefined,
      status: "queued",
    });

    const started = await startClaudeBackgroundReview(pi as never, job, "fake-claude", "Read");

    expect(started.status).toBe("failed");
    expect(started.claudeSessionId).toBeUndefined();
    expect(started.errorMessage).toBe("Claude background session did not report a session id");
    expect(started.rawStartOutput).toBe("background session started");
  });

  it("rejects job ids that resolve outside the job store", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "claude-review-jobs-"));
    tempDirs.push(rootDir);
    const jobDir = join(rootDir, "jobs");
    const outsideDir = join(rootDir, "outside");
    process.env.PI_CLAUDE_REVIEW_JOB_DIR = jobDir;
    await mkdir(outsideDir, { recursive: true });
    await writeFile(
      join(outsideDir, "fake.json"),
      `${JSON.stringify(createBackgroundJob({ id: "claude-review-20260101000000-feedface" }))}\n`,
      "utf8",
    );

    await expect(readJob("../outside/fake")).rejects.toThrow(/Invalid Claude review job id/);
  });

  it("rejects job files with mismatched embedded ids", async () => {
    const jobDir = await mkdtemp(join(tmpdir(), "claude-review-jobs-"));
    tempDirs.push(jobDir);
    process.env.PI_CLAUDE_REVIEW_JOB_DIR = jobDir;
    const requestedId = "claude-review-20260101000000-feedface";
    await mkdir(jobDir, { recursive: true });
    await writeFile(
      join(jobDir, `${requestedId}.json`),
      `${JSON.stringify(createBackgroundJob({ id: "claude-review-20260101000000-deadbeef" }))}\n`,
      "utf8",
    );

    await expect(readJob(requestedId)).rejects.toThrow(/Claude review job id mismatch/);
  });

  it("does not cancel completed background jobs", async () => {
    const jobDir = await mkdtemp(join(tmpdir(), "claude-review-jobs-"));
    tempDirs.push(jobDir);
    process.env.PI_CLAUDE_REVIEW_JOB_DIR = jobDir;
    const { pi } = createMockPi({
      stdout: "stopped",
      stderr: "",
      code: 0,
      killed: false,
    });
    const job = createBackgroundJob({
      status: "review",
      stdout: "finished review",
      completedAt: "2026-01-01T00:05:00.000Z",
      exitCode: 0,
    });

    const cancelled = await cancelClaudeBackgroundJob(pi as never, job, "fake-claude");

    expect(cancelled).toEqual(job);
    expect(pi.exec).not.toHaveBeenCalled();
  });

  it("keeps a failed background status when logs contain review markers", async () => {
    const jobDir = await mkdtemp(join(tmpdir(), "claude-review-jobs-"));
    tempDirs.push(jobDir);
    process.env.PI_CLAUDE_REVIEW_JOB_DIR = jobDir;
    const markedReview = `${CLAUDE_REVIEW_RESULT_START}\npartial review\n${CLAUDE_REVIEW_RESULT_END}`;
    const { pi } = createMockPi({
      stdout: markedReview,
      stderr: "",
      code: 0,
      killed: false,
    });
    const job = createBackgroundJob({
      status: "failed",
      exitCode: 1,
      errorMessage: "Claude background session failed",
    });

    const withLogs = await readClaudeBackgroundLogs(pi as never, job, "fake-claude");

    expect(withLogs.status).toBe("failed");
    expect(withLogs.exitCode).toBe(1);
    expect(withLogs.stdout).toBe("partial review");
    expect(withLogs.errorMessage).toBe("Claude background session failed");
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("marks running background jobs as reviewed when logs contain review markers", async () => {
    const jobDir = await mkdtemp(join(tmpdir(), "claude-review-jobs-"));
    tempDirs.push(jobDir);
    process.env.PI_CLAUDE_REVIEW_JOB_DIR = jobDir;
    const markedReview = `${CLAUDE_REVIEW_RESULT_START}\nfinal review\n${CLAUDE_REVIEW_RESULT_END}`;
    const { pi } = createMockPi({
      stdout: markedReview,
      stderr: "",
      code: 0,
      killed: false,
    });
    const job = createBackgroundJob({
      status: "running",
      completedAt: null,
    });

    const withLogs = await readClaudeBackgroundLogs(pi as never, job, "fake-claude");

    expect(withLogs.status).toBe("review");
    expect(withLogs.stdout).toBe("final review");
    expect(withLogs.completedAt).toEqual(expect.any(String));
  });

  it("keeps terminal background jobs terminal when refreshing agent status", async () => {
    const jobDir = await mkdtemp(join(tmpdir(), "claude-review-jobs-"));
    tempDirs.push(jobDir);
    process.env.PI_CLAUDE_REVIEW_JOB_DIR = jobDir;
    const { pi } = createMockPi({
      stdout: JSON.stringify([{ id: "session-123", status: "running" }]),
      stderr: "",
      code: 0,
      killed: false,
    });
    const job = createBackgroundJob({
      status: "review",
      stdout: "final review",
      completedAt: "2026-01-01T00:05:00.000Z",
      exitCode: 0,
    });

    const refreshed = await refreshClaudeBackgroundJob(pi as never, job, "fake-claude");

    expect(refreshed.status).toBe("review");
    expect(refreshed.stdout).toBe("final review");
    expect(refreshed.completedAt).toBe("2026-01-01T00:05:00.000Z");
    expect(refreshed.rawAgentsEntry).toEqual({ id: "session-123", status: "running" });
  });

  it("ignores echoed prompt result markers when extracting review output", () => {
    const promptedPlaceholder = `${CLAUDE_REVIEW_RESULT_START}
<your concise, actionable review or no-findings summary>
${CLAUDE_REVIEW_RESULT_END}`;
    const realReview = `${CLAUDE_REVIEW_RESULT_START}
Finding: fix the edge case
${CLAUDE_REVIEW_RESULT_END}`;

    expect(
      extractMarkedReview(`user prompt:\n${promptedPlaceholder}\nassistant:\n${realReview}`),
    ).toBe("Finding: fix the edge case");
  });
});
