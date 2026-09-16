import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import claudeReviewExtension, {
  buildCodeReviewPrompt,
  claudeArgs,
  claudeBackgroundArgs,
  parseClaudeReviewArgs,
} from "../pi-extensions/claude-review/index.js";
import { renderClaudeReviewMarkdown } from "../pi-extensions/claude-review/render.js";
import { saveCapsule, type Capsule } from "../pi-extensions/lib/context-capsule.js";
import {
  CLAUDE_REVIEW_HAS_FINDINGS_END,
  CLAUDE_REVIEW_HAS_FINDINGS_START,
  CLAUDE_REVIEW_RESULT_END,
  CLAUDE_REVIEW_RESULT_START,
} from "../pi-extensions/claude-review/args.js";
import {
  cancelClaudeBackgroundJob,
  extractMarkedReview,
  extractMarkedReviewResult,
  readClaudeBackgroundLogs,
  sanitizeClaudeLog,
  refreshClaudeBackgroundJob,
  startClaudeBackgroundReview,
} from "../pi-extensions/claude-review/claude-bg.js";
import { listJobs, readJob, writeJob } from "../pi-extensions/claude-review/jobs.js";
import type { ClaudeReviewJob } from "../pi-extensions/claude-review/jobs.js";

const borderedLoaderMessages = vi.hoisted((): string[] => []);

vi.mock("@earendil-works/pi-coding-agent", () => ({
  BorderedLoader: class {
    private readonly controller = new AbortController();
    onAbort?: () => void;

    constructor(_tui: unknown, _theme: unknown, message: string) {
      borderedLoaderMessages.push(message);
    }

    get signal(): AbortSignal {
      return this.controller.signal;
    }

    handleInput(data: string): void {
      if (data === "\u001b") {
        this.controller.abort();
        this.onAbort?.();
      }
    }

    render(): string[] {
      return [];
    }

    invalidate(): void {}

    dispose(): void {}
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

type MockClaudeReviewToolInput = {
  action: "start" | "status" | "result" | "logs" | "cancel" | "list";
  level?: "low" | "medium" | "high" | "max";
  context?: string;
  mode?: "background" | "wait";
  autoFix?: boolean;
  jobId?: string;
  all?: boolean;
};

type RegisteredTool = {
  name: string;
  executionMode?: "sequential" | "parallel";
  execute: (
    toolCallId: string,
    params: MockClaudeReviewToolInput,
    signal: AbortSignal,
    onUpdate: undefined,
    ctx: MockCommandContext,
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: {
      jobId?: string;
      status: string;
      autoFix: boolean;
      contextMessage: string;
      claudeSessionId?: string;
      errorMessage?: string | null;
    };
  }>;
};

type MockCommandContext = {
  cwd: string;
  mode?: "tui" | "rpc" | "json" | "print";
  hasUI?: boolean;
  waitForIdle: () => Promise<void>;
  sessionManager?: {
    getBranch: () => unknown[];
    getSessionId: () => string;
    getSessionFile: () => string | undefined;
  };
  ui: {
    notify: (message: string, type?: "info" | "warning" | "error") => void;
    setStatus: (key: string, value: string | undefined) => void;
    setWidget: (key: string, value: unknown) => void;
    custom?: <T>(
      factory: (
        tui: unknown,
        theme: unknown,
        keybindings: unknown,
        done: (result: T) => void,
      ) => { handleInput?: (data: string) => void },
    ) => Promise<T>;
    confirm?: (title: string, message: string) => Promise<boolean>;
  };
};

const execFileAsync = promisify(execFile);

function testCapsule(): Capsule {
  return {
    kind: "pi-context-capsule",
    schemaVersion: 1,
    capsuleId: "capsule-review-test",
    revision: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    source: { sessionId: "session-review", cwd: "/repo" },
    objective: "Review the current change",
    constraints: ["Keep the review read-only"],
    decisions: [],
    resources: [],
    observedChanges: [],
    validation: [],
    blockers: [],
    risks: [],
    nextAction: "Inspect the diff",
    exclusions: [],
  };
}

function createMockPi(execResult = { stdout: "review", stderr: "", code: 0, killed: false }) {
  const commands = new Map<string, RegisteredCommand>();
  const tools = new Map<string, RegisteredTool>();
  return {
    pi: {
      registerMessageRenderer: vi.fn(),
      registerCommand: vi.fn((_name: string, registered: RegisteredCommand) => {
        commands.set(_name, registered);
      }),
      registerTool: vi.fn((tool: RegisteredTool) => {
        tools.set(tool.name, tool);
      }),
      exec: vi.fn(async (_bin?: string, _args?: string[]) => execResult),
      sendUserMessage: vi.fn(),
      sendMessage: vi.fn(),
    },
    command(name = "claude-review") {
      const command = commands.get(name);
      if (!command) throw new Error("missing command");
      return command;
    },
    tool(name = "claude_review") {
      const tool = tools.get(name);
      if (!tool) throw new Error("missing tool");
      return tool;
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

function createCurrentCapsuleContext(): MockCommandContext {
  const context = createContext();
  context.hasUI = true;
  context.ui.confirm = vi.fn(async () => true);
  context.sessionManager = {
    getBranch: () => [
      {
        type: "message",
        message: { role: "user", content: "Review issue #94 without widening scope" },
      },
    ],
    getSessionId: () => "current-review-session",
    getSessionFile: () => "/sessions/current-review-session.jsonl",
  };
  return context;
}

function markedReviewOutput(review: string, hasFindings: boolean): string {
  return [
    CLAUDE_REVIEW_HAS_FINDINGS_START,
    String(hasFindings),
    CLAUDE_REVIEW_HAS_FINDINGS_END,
    CLAUDE_REVIEW_RESULT_START,
    review,
    CLAUDE_REVIEW_RESULT_END,
  ].join("\n");
}

function createTranscriptLine(
  review: string,
  hasFindings = true,
  role: "assistant" | "user" = "assistant",
): string {
  return `${JSON.stringify({
    type: role,
    message: {
      role,
      content: [{ type: "text", text: markedReviewOutput(review, hasFindings) }],
    },
  })}\n`;
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

  it("parses current and saved capsule references", () => {
    expect(parseClaudeReviewArgs("--capsule --no-fix low")).toMatchObject({
      capsuleReference: "current",
      autoFix: false,
      level: "low",
    });
    expect(parseClaudeReviewArgs("--capsule-ref saved-capsule --wait")).toMatchObject({
      capsuleReference: "saved-capsule",
      mode: "wait",
    });
  });

  it("keeps review arguments after the current-session capsule shorthand", () => {
    expect(parseClaudeReviewArgs("--capsule high inspect")).toEqual({
      autoFix: true,
      level: "high",
      contextMessage: "inspect",
      mode: "background",
      capsuleReference: "current",
    });
  });

  it("rejects ultra for headless review runs", () => {
    expect(() => parseClaudeReviewArgs("ultra review deeply")).toThrow(/ultra/);
  });

  it("builds a self-contained review contract without relying on a local slash command", () => {
    const options = parseClaudeReviewArgs("max inspect the current branch");
    const prompt = buildCodeReviewPrompt(options);

    expect(prompt).toContain("Perform an independent code review");
    expect(prompt).toContain("Review context from the caller:\ninspect the current branch");
    expect(prompt).toContain("Do not modify files");
    expect(prompt).not.toContain("/code-review");
  });

  it("renders compact capsule provenance without dumping capsule contents", () => {
    const rendered = renderClaudeReviewMarkdown({
      status: "running",
      level: "medium",
      contextMessage: "",
      autoFix: false,
      stdout: "review output",
      stderr: "",
      capsuleProvenance: {
        capsuleId: "capsule-review-test",
        revision: 2,
        source: "saved",
      },
    });
    expect(rendered).toContain("capsule-review-test@2");
    expect(rendered).toContain("(saved)");
    expect(rendered).not.toContain("Review the current change");
  });

  it("delimits capsule grounding as untrusted data", () => {
    const prompt = buildCodeReviewPrompt(parseClaudeReviewArgs("high inspect the current branch"), {
      capsule: testCapsule(),
      resultMarkers: true,
    });
    expect(prompt).toContain("BEGIN UNTRUSTED CONTEXT CAPSULE");
    expect(prompt).toContain("END UNTRUSTED CONTEXT CAPSULE");
    expect(prompt).toContain('"objective":"Review the current change"');
    expect(prompt).toContain("inspect referenced repository files");
    expect(prompt).not.toContain("changes with git");
    expect(prompt).toContain(CLAUDE_REVIEW_RESULT_START);
  });

  it("asks Claude for machine-readable review result markers", () => {
    const options = parseClaudeReviewArgs("high inspect the current branch");
    const prompt = buildCodeReviewPrompt(options, { resultMarkers: true });

    expect(prompt).toContain(CLAUDE_REVIEW_HAS_FINDINGS_START);
    expect(prompt).toContain("true|false");
    expect(prompt).toContain(CLAUDE_REVIEW_RESULT_START);
  });

  it("pins wait-mode reviews to the current Opus model and requested effort", () => {
    expect(claudeArgs("review prompt", "high", "Read")).toEqual([
      "--permission-mode",
      "auto",
      "--model",
      "opus",
      "--effort",
      "high",
      "--tools",
      "Read",
      "--allowed-tools",
      "Read",
      "-p",
      "review prompt",
    ]);
  });

  it("separates the background prompt from variadic Claude tool options", () => {
    expect(claudeBackgroundArgs("review prompt", "review-session", "Read", "max")).toEqual([
      "--bg",
      "--name",
      "review-session",
      "--permission-mode",
      "auto",
      "--model",
      "opus",
      "--effort",
      "max",
      "--tools",
      "Read",
      "--allowed-tools",
      "Read",
      "--",
      "review prompt",
    ]);
  });
});

describe("Claude review shell helper", () => {
  it("runs from the caller's repository with an explicit tool set and effort", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-review-script-"));
    const targetRepo = join(root, "target-repo");
    const argsPath = join(root, "args.txt");
    const cwdPath = join(root, "cwd.txt");
    const claudeStub = join(root, "claude-stub.sh");
    await mkdir(targetRepo);
    await writeFile(
      claudeStub,
      `#!/bin/bash\nset -euo pipefail\nprintf '%s\\n' "$PWD" > "$CAPTURE_CWD"\nprintf '%s\\n' "$@" > "$CAPTURE_ARGS"\n`,
      { encoding: "utf8", mode: 0o700 },
    );

    try {
      await execFileAsync(
        resolve("skills/claude-review/scripts/run-claude-review.sh"),
        ["high", "focus on correctness"],
        {
          cwd: targetRepo,
          env: {
            ...process.env,
            PI_CLAUDE_REVIEW_BIN: claudeStub,
            CAPTURE_ARGS: argsPath,
            CAPTURE_CWD: cwdPath,
          },
        },
      );

      const capturedArgs = (await readFile(argsPath, "utf8")).trim().split("\n");
      expect((await readFile(cwdPath, "utf8")).trim()).toBe(await realpath(targetRepo));
      expect(capturedArgs).toEqual(
        expect.arrayContaining([
          "--effort",
          "high",
          "--tools",
          "Bash,Read,Glob,Grep,LSP,WebFetch,WebSearch,Skill",
          "--allowed-tools",
          "Bash,Read,Glob,Grep,LSP,WebFetch,WebSearch,Skill",
        ]),
      );
      expect(capturedArgs.join("\n")).toContain("Perform an independent code review");
      expect(capturedArgs.join("\n")).not.toContain("/code-review");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe("claude review command", () => {
  const originalBin = process.env.PI_CLAUDE_REVIEW_BIN;
  const originalHome = process.env.HOME;
  const originalJobDir = process.env.PI_CLAUDE_REVIEW_JOB_DIR;
  const originalCapsuleDir = process.env.PI_CODING_AGENT_DIR;
  const tempDirs: string[] = [];

  afterEach(async () => {
    if (originalBin === undefined) {
      delete process.env.PI_CLAUDE_REVIEW_BIN;
    } else {
      process.env.PI_CLAUDE_REVIEW_BIN = originalBin;
    }
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalJobDir === undefined) {
      delete process.env.PI_CLAUDE_REVIEW_JOB_DIR;
    } else {
      process.env.PI_CLAUDE_REVIEW_JOB_DIR = originalJobDir;
    }
    if (originalCapsuleDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = originalCapsuleDir;
    }
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
  });

  it("runs Claude Code and asks Pi to fix successful review findings", async () => {
    process.env.PI_CLAUDE_REVIEW_BIN = "fake-claude";
    const { pi, command } = createMockPi({
      stdout: markedReviewOutput("Finding: fix the edge case", true),
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
      claudeArgs(
        buildCodeReviewPrompt(parseClaudeReviewArgs("high read issue #23"), {
          resultMarkers: true,
        }),
        "high",
      ),
      expect.objectContaining({ cwd: "/repo", timeout: 20 * 60 * 1000 }),
    );
    expect(pi.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("Finding: fix the edge case"),
      { deliverAs: "followUp" },
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

  it.each(["(none)", "No findings reported.", "Nothing actionable here."])(
    "does not trigger Pi when a wait-mode review marks no findings: %s",
    async (stdout) => {
      const { pi, command } = createMockPi({
        stdout: markedReviewOutput(stdout, false),
        stderr: "",
        code: 0,
        killed: false,
      });
      claudeReviewExtension(pi as never);
      const ctx = createContext();

      await command().handler("--wait low", ctx);

      expect(pi.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          customType: "claude-review",
          details: expect.objectContaining({ stdout, hasFindings: false }),
        }),
      );
      expect(pi.sendUserMessage).not.toHaveBeenCalled();
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Claude review returned no findings; no auto-fix prompt sent",
        "info",
      );
    },
  );

  it("does not auto-fix successful wait-mode reviews with missing findings markers", async () => {
    const { pi, command } = createMockPi({
      stdout: [
        CLAUDE_REVIEW_RESULT_START,
        "Finding: fix the edge case",
        CLAUDE_REVIEW_RESULT_END,
      ].join("\n"),
      stderr: "",
      code: 0,
      killed: false,
    });
    claudeReviewExtension(pi as never);
    const ctx = createContext();

    await command().handler("--wait low", ctx);

    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ hasFindings: undefined }),
      }),
    );
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Claude review did not include a findings marker; no auto-fix prompt sent",
      "warning",
    );
  });

  it.each([
    ["opening", `${CLAUDE_REVIEW_RESULT_START}\nFinding: fix the edge case`],
    ["closing", `Finding: fix the edge case\n${CLAUDE_REVIEW_RESULT_END}`],
    [
      "trailing opening",
      `${markedReviewOutput("Earlier complete review", true)}\n${CLAUDE_REVIEW_RESULT_START}`,
    ],
    [
      "leading closing",
      `${CLAUDE_REVIEW_RESULT_END}\n${markedReviewOutput("Later complete review", true)}`,
    ],
  ])("rejects a wait-mode review with an unpaired %s result marker", async (_kind, stdout) => {
    const { pi, command } = createMockPi({
      stdout,
      stderr: "",
      code: 0,
      killed: false,
    });
    claudeReviewExtension(pi as never);
    const ctx = createContext();

    await command().handler("--wait medium", ctx);

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          status: "failed",
          stdout: "",
          errorMessage: "Claude returned an invalid or placeholder review result",
        }),
      }),
    );
  });

  it("rejects a wait-mode placeholder instead of storing it as a review", async () => {
    const { pi, command } = createMockPi({
      stdout: markedReviewOutput("<your concise, actionable review or no-findings summary>", true),
      stderr: "",
      code: 0,
      killed: false,
    });
    claudeReviewExtension(pi as never);
    const ctx = createContext();

    await command().handler("--wait medium", ctx);

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          status: "failed",
          stdout: "",
          errorMessage: "Claude returned an invalid or placeholder review result",
        }),
      }),
    );
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

  it("rejects invalid saved capsules before starting foreground Claude", async () => {
    const { pi, command } = createMockPi();
    claudeReviewExtension(pi as never);
    const ctx = createContext();

    await command().handler("--wait --capsule-ref /missing/capsule.json", ctx);

    expect(pi.exec).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Claude review capsule rejected"),
      "error",
    );
  });

  it("previews and confirms a saved capsule before foreground review", async () => {
    const capsuleRoot = await mkdtemp(join(tmpdir(), "claude-review-capsules-"));
    tempDirs.push(capsuleRoot);
    process.env.PI_CODING_AGENT_DIR = capsuleRoot;
    await saveCapsule(testCapsule());
    const { pi, command } = createMockPi({
      stdout: markedReviewOutput("Capsule finding", false),
      stderr: "",
      code: 0,
      killed: false,
    });
    claudeReviewExtension(pi as never);
    const ctx = createContext();
    ctx.hasUI = true;
    ctx.ui.confirm = vi.fn(async () => true);

    await command().handler("--wait --no-fix --capsule-ref capsule-review-test", ctx);

    expect(ctx.ui.confirm).toHaveBeenCalledOnce();
    expect(pi.exec).toHaveBeenCalledWith(
      "claude",
      expect.arrayContaining([expect.stringContaining("BEGIN UNTRUSTED CONTEXT CAPSULE")]),
      expect.anything(),
    );
    const foregroundArgs = pi.exec.mock.calls[0][1] as string[];
    expect(foregroundArgs.slice(0, 10)).toEqual([
      "--permission-mode",
      "auto",
      "--model",
      "opus",
      "--effort",
      "medium",
      "--tools",
      "Read,Glob,Grep,LSP,WebFetch,WebSearch,Skill",
      "--allowed-tools",
      "Read,Glob,Grep,LSP,WebFetch,WebSearch,Skill",
    ]);
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          capsuleProvenance: {
            capsuleId: "capsule-review-test",
            revision: 2,
            source: "saved",
          },
        }),
      }),
    );
  });

  it("uses a current-session capsule while keeping auto-fix in Pi", async () => {
    const { pi, command } = createMockPi({
      stdout: markedReviewOutput("Fix the grounded edge case", true),
      stderr: "",
      code: 0,
      killed: false,
    });
    claudeReviewExtension(pi as never);
    const ctx = createCurrentCapsuleContext();

    await command().handler("--wait --capsule=current high", ctx);

    expect(pi.exec).toHaveBeenCalledOnce();
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("Fix the grounded edge case"),
      { deliverAs: "followUp" },
    );
    expect(pi.sendUserMessage).toHaveBeenCalledWith(
      expect.stringMatching(/Context Capsule: .+@1 \(current-session\)/),
      { deliverAs: "followUp" },
    );
  });

  it("rejects invalid saved capsules before persisting a background job", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "claude-review-invalid-capsule-"));
    const jobDir = await mkdtemp(join(tmpdir(), "claude-review-jobs-"));
    tempDirs.push(rootDir, jobDir);
    process.env.PI_CLAUDE_REVIEW_JOB_DIR = jobDir;
    const invalidCapsulePath = join(rootDir, "unsupported.json");
    await writeFile(
      invalidCapsulePath,
      JSON.stringify({ ...testCapsule(), schemaVersion: 999 }),
      "utf8",
    );
    const { pi, command } = createMockPi();
    claudeReviewExtension(pi as never);
    const ctx = createContext();

    await command().handler(`--capsule-ref ${invalidCapsulePath}`, ctx);

    expect(pi.exec).not.toHaveBeenCalled();
    await expect(readdir(jobDir)).resolves.toEqual([]);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("unsupported-version"),
      "error",
    );
  });

  it("does not persist a background job when capsule confirmation is declined", async () => {
    const capsuleRoot = await mkdtemp(join(tmpdir(), "claude-review-capsules-"));
    const jobDir = await mkdtemp(join(tmpdir(), "claude-review-jobs-"));
    tempDirs.push(capsuleRoot, jobDir);
    process.env.PI_CODING_AGENT_DIR = capsuleRoot;
    process.env.PI_CLAUDE_REVIEW_JOB_DIR = jobDir;
    await saveCapsule(testCapsule());
    const { pi, command } = createMockPi({
      stdout: "backgrounded · session-123456",
      stderr: "",
      code: 0,
      killed: false,
    });
    claudeReviewExtension(pi as never);
    const ctx = createContext();
    ctx.hasUI = true;
    ctx.ui.confirm = vi.fn(async () => false);

    await command().handler("--capsule-ref capsule-review-test", ctx);

    expect(pi.exec).not.toHaveBeenCalled();
    await expect(readdir(jobDir)).resolves.toEqual([]);
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
      expect.arrayContaining([
        "--effort",
        "low",
        "--",
        expect.stringContaining("Review level: low"),
      ]),
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("persists saved-capsule provenance for background recovery", async () => {
    const capsuleRoot = await mkdtemp(join(tmpdir(), "claude-review-capsules-"));
    const jobDir = await mkdtemp(join(tmpdir(), "claude-review-jobs-"));
    tempDirs.push(capsuleRoot, jobDir);
    process.env.PI_CODING_AGENT_DIR = capsuleRoot;
    process.env.PI_CLAUDE_REVIEW_JOB_DIR = jobDir;
    await saveCapsule(testCapsule());
    const { pi, command } = createMockPi({
      stdout: "backgrounded · session-grounded",
      stderr: "",
      code: 0,
      killed: false,
    });
    claudeReviewExtension(pi as never);
    const ctx = createContext();
    ctx.hasUI = true;
    ctx.ui.confirm = vi.fn(async () => true);

    await command().handler("--no-fix --capsule saved capsule-review-test", ctx);

    const [jobFile] = await readdir(jobDir);
    const recovered = await readJob(jobFile.replace(/\.json$/, ""));
    expect(recovered.capsuleProvenance).toEqual({
      capsuleId: "capsule-review-test",
      revision: 2,
      source: "saved",
    });
    const backgroundArgs = pi.exec.mock.calls[0][1] as string[];
    expect(backgroundArgs[backgroundArgs.indexOf("--tools") + 1]).toBe(
      "Read,Glob,Grep,LSP,WebFetch,WebSearch,Skill",
    );
    expect(backgroundArgs[backgroundArgs.indexOf("--allowed-tools") + 1]).toBe(
      "Read,Glob,Grep,LSP,WebFetch,WebSearch,Skill",
    );
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("capsule-review-test@2"),
        details: expect.objectContaining({ capsuleProvenance: recovered.capsuleProvenance }),
      }),
    );
  });

  it("lets Escape cancel a pending idle wait before creating a job or subprocess", async () => {
    const jobDir = await mkdtemp(join(tmpdir(), "claude-review-jobs-"));
    tempDirs.push(jobDir);
    process.env.PI_CLAUDE_REVIEW_JOB_DIR = jobDir;
    const { pi, command } = createMockPi();
    claudeReviewExtension(pi as never);
    const ctx = createCurrentCapsuleContext();
    let releaseIdle: (() => void) | undefined;
    ctx.waitForIdle = vi.fn(
      () =>
        new Promise<void>((resolveIdle) => {
          releaseIdle = resolveIdle;
        }),
    );
    ctx.mode = "tui";
    ctx.ui.custom = vi.fn(
      async (factory) =>
        new Promise((done) => {
          const component = factory({}, {}, {}, done);
          component.handleInput?.("\u001b");
        }),
    ) as MockCommandContext["ui"]["custom"];

    await command().handler("--capsule=current", ctx);

    expect(ctx.ui.custom).toHaveBeenCalledOnce();
    expect(ctx.ui.setWidget).not.toHaveBeenCalled();
    expect(pi.exec).not.toHaveBeenCalled();
    await expect(readdir(jobDir)).resolves.toEqual([]);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Claude review cancelled", "info");

    releaseIdle?.();
    await Promise.resolve();
    expect(pi.exec).not.toHaveBeenCalled();
    await expect(readdir(jobDir)).resolves.toEqual([]);
  });

  it("updates the visible TUI loader when Claude starts running", async () => {
    borderedLoaderMessages.length = 0;
    const { pi, command } = createMockPi({
      stdout: markedReviewOutput("No findings", false),
      stderr: "",
      code: 0,
      killed: false,
    });
    claudeReviewExtension(pi as never);
    const ctx = createContext();
    ctx.mode = "tui";
    ctx.ui.custom = vi.fn(
      async (factory) =>
        new Promise((done) => {
          factory({ requestRender: vi.fn() }, {}, {}, done);
        }),
    ) as MockCommandContext["ui"]["custom"];

    await command().handler("--wait --no-fix low", ctx);

    expect(borderedLoaderMessages).toEqual([
      "Claude review: waiting for Pi to become idle…",
      "Claude review: running at low effort…",
    ]);
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

  it("stops and records a Claude session when cancellation wins background startup", async () => {
    const jobDir = await mkdtemp(join(tmpdir(), "claude-review-jobs-"));
    tempDirs.push(jobDir);
    process.env.PI_CLAUDE_REVIEW_JOB_DIR = jobDir;
    const { pi, tool } = createMockPi();
    const controller = new AbortController();
    pi.exec
      .mockImplementationOnce(async () => {
        controller.abort();
        return {
          stdout: "backgrounded · session-cancelled-start",
          stderr: "",
          code: 0,
          killed: false,
        };
      })
      .mockResolvedValueOnce({ stdout: "stopped", stderr: "", code: 0, killed: false });
    claudeReviewExtension(pi as never);

    const result = await tool().execute(
      "call-start",
      { action: "start" },
      controller.signal,
      undefined,
      createContext(),
    );

    expect(result.details).toMatchObject({
      status: "cancelled",
      claudeSessionId: "session-cancelled-start",
    });
    expect(pi.exec).toHaveBeenNthCalledWith(
      2,
      "claude",
      ["stop", "session-cancelled-start"],
      expect.objectContaining({ cwd: "/repo" }),
    );
    const stored = await readJob(result.details.jobId as string);
    expect(stored.status).toBe("cancelled");
    expect(stored.claudeSessionId).toBe("session-cancelled-start");
  });

  it("repairs permissive env-overridden job stores and files before persistence", async () => {
    const jobDir = await mkdtemp(join(tmpdir(), "claude-review-jobs-"));
    tempDirs.push(jobDir);
    process.env.PI_CLAUDE_REVIEW_JOB_DIR = jobDir;
    await chmod(jobDir, 0o755);

    const job = createBackgroundJob();
    await writeJob(job);
    const [jobFile] = await readdir(jobDir);
    const jobPath = join(jobDir, jobFile);
    expect((await stat(jobDir)).mode & 0o777).toBe(0o700);
    expect((await stat(jobPath)).mode & 0o777).toBe(0o600);

    await chmod(jobPath, 0o644);
    await expect(readJob(job.id)).resolves.toMatchObject({ id: job.id });
    expect((await stat(jobPath)).mode & 0o777).toBe(0o600);
  });

  it("fails closed for an env-overridden store that is not a directory", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "claude-review-jobs-"));
    tempDirs.push(rootDir);
    const storePath = join(rootDir, "not-a-directory");
    process.env.PI_CLAUDE_REVIEW_JOB_DIR = storePath;
    await writeFile(storePath, "not a store", "utf8");

    await expect(writeJob(createBackgroundJob())).rejects.toThrow(/EEXIST|job store/);
    await expect(listJobs()).rejects.toThrow(/EEXIST|job store/);
  });

  it("fails closed instead of reading a job file through a symlink", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "claude-review-jobs-"));
    tempDirs.push(rootDir);
    const jobDir = join(rootDir, "jobs");
    const outsidePath = join(rootDir, "outside.json");
    process.env.PI_CLAUDE_REVIEW_JOB_DIR = jobDir;
    await mkdir(jobDir);
    await writeFile(outsidePath, JSON.stringify(createBackgroundJob()), "utf8");
    const jobPath = join(jobDir, "claude-review-20260101000000-abcdef12.json");
    await symlink(outsidePath, jobPath);

    await expect(listJobs()).rejects.toThrow(/regular file/);
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

  it("keeps stop-command failures retryable and treats killed stops as timeouts", async () => {
    const jobDir = await mkdtemp(join(tmpdir(), "claude-review-jobs-"));
    tempDirs.push(jobDir);
    process.env.PI_CLAUDE_REVIEW_JOB_DIR = jobDir;
    const { pi } = createMockPi();
    const job = createBackgroundJob({ status: "running" });
    pi.exec
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "temporary supervisor failure",
        code: 1,
        killed: false,
      })
      .mockResolvedValueOnce({ stdout: "", stderr: "", code: 0, killed: true })
      .mockResolvedValueOnce({ stdout: "stopped", stderr: "", code: 0, killed: false });

    const failedStop = await cancelClaudeBackgroundJob(pi as never, job, "fake-claude");
    expect(failedStop.status).toBe("running");
    expect(failedStop.completedAt).toBeNull();
    expect(failedStop.managementError).toBe(
      "Failed to stop Claude background session with exit code 1",
    );
    expect(failedStop.managementErrorSource).toBe("cancel");

    const timedOutStop = await cancelClaudeBackgroundJob(pi as never, failedStop, "fake-claude");
    expect(timedOutStop.status).toBe("running");
    expect(timedOutStop.managementError).toBe("Timed out while stopping Claude background session");

    const cancelled = await cancelClaudeBackgroundJob(pi as never, timedOutStop, "fake-claude");
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.managementError).toBeNull();
    expect(pi.exec).toHaveBeenCalledTimes(3);
  });

  it("clears a failed cancellation diagnostic after a successful retry", async () => {
    const jobDir = await mkdtemp(join(tmpdir(), "claude-review-jobs-"));
    tempDirs.push(jobDir);
    process.env.PI_CLAUDE_REVIEW_JOB_DIR = jobDir;
    const { pi } = createMockPi();
    pi.exec
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "temporary supervisor failure",
        code: 1,
        killed: false,
      })
      .mockResolvedValueOnce({ stdout: "stopped", stderr: "", code: 0, killed: false });
    const job = createBackgroundJob({ status: "running" });

    const failedStop = await cancelClaudeBackgroundJob(pi as never, job, "fake-claude");
    const cancelled = await cancelClaudeBackgroundJob(pi as never, failedStop, "fake-claude");

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.stderr).toBe("");
    expect(cancelled.managementError).toBeNull();
  });

  it("does not treat unmarked Claude logs as review output", async () => {
    const jobDir = await mkdtemp(join(tmpdir(), "claude-review-jobs-"));
    tempDirs.push(jobDir);
    process.env.PI_CLAUDE_REVIEW_JOB_DIR = jobDir;
    const rawLog = "\u001b[31mfull raw history\u001b[39m\n".repeat(100);
    const { pi } = createMockPi({
      stdout: rawLog,
      stderr: "",
      code: 0,
      killed: false,
    });
    const job = createBackgroundJob({
      status: "review",
      stdout: rawLog,
      lastLog: rawLog,
    });

    const withLogs = await readClaudeBackgroundLogs(pi as never, job, "fake-claude");

    expect(withLogs.status).toBe("review");
    expect(withLogs.stdout).toBe("");
    expect(withLogs.lastLog).not.toContain("\u001b");
    expect(withLogs.errorMessage).toBeNull();
    expect(withLogs.managementError).toMatch(/did not contain review result markers/);
  });

  it("uses Claude's persisted transcript instead of terminal logs for results", async () => {
    process.env.PI_CLAUDE_REVIEW_BIN = "fake-claude";
    const homeDir = await mkdtemp(join(tmpdir(), "claude-home-"));
    const jobDir = await mkdtemp(join(tmpdir(), "claude-review-jobs-"));
    tempDirs.push(homeDir, jobDir);
    process.env.HOME = homeDir;
    process.env.PI_CLAUDE_REVIEW_JOB_DIR = jobDir;
    const transcriptDir = join(homeDir, ".claude", "jobs", "session-123");
    await mkdir(transcriptDir, { recursive: true });
    const cleanReview = "The `--` arg fix and `extractMarkedReview` control-stripping are correct.";
    await writeFile(
      join(transcriptDir, "timeline.jsonl"),
      createTranscriptLine(cleanReview),
      "utf8",
    );
    const startupOutput = "backgrounded · session-123";
    const job = await writeJob(
      createBackgroundJob({
        status: "running",
        stdout: startupOutput,
        lastLog: "",
        rawStartOutput: startupOutput,
        autoFix: true,
      }),
    );
    const { pi, command } = createMockPi();
    pi.exec.mockImplementation(async (_bin: string, args: string[]) => {
      if (args[0] === "agents") {
        return {
          stdout: JSON.stringify([{ id: "session-123", status: "completed", exitCode: 0 }]),
          stderr: "",
          code: 0,
          killed: false,
        };
      }
      throw new Error("claude logs should not be read when transcript has markers");
    });
    claudeReviewExtension(pi as never);
    const ctx = createContext();

    await command("claude-review-result").handler(job.id, ctx);

    const stored = await readJob(job.id);
    expect(stored.stdout).toBe(cleanReview);
    expect(stored.hasFindings).toBe(true);
    expect(pi.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("Reviewed working directory: /repo"),
      { deliverAs: "followUp" },
    );
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining(cleanReview), {
      deliverAs: "followUp",
    });
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.not.stringContaining("fixand"), {
      deliverAs: "followUp",
    });
  });

  it("ignores user-authored and placeholder transcript results until an assistant responds", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "claude-home-"));
    const jobDir = await mkdtemp(join(tmpdir(), "claude-review-jobs-"));
    tempDirs.push(homeDir, jobDir);
    process.env.HOME = homeDir;
    process.env.PI_CLAUDE_REVIEW_JOB_DIR = jobDir;
    const transcriptDir = join(homeDir, ".claude", "jobs", "session-123");
    const transcriptPath = join(transcriptDir, "timeline.jsonl");
    await mkdir(transcriptDir, { recursive: true });
    await writeFile(
      transcriptPath,
      [
        createTranscriptLine("user-authored finding", true, "user"),
        createTranscriptLine("<your concise, actionable review or no-findings summary>"),
      ].join(""),
      "utf8",
    );
    const { pi } = createMockPi({
      stdout: "temporary log lookup failure",
      stderr: "",
      code: 1,
      killed: false,
    });
    const job = createBackgroundJob({ status: "running" });

    const beforeAssistant = await readClaudeBackgroundLogs(pi as never, job, "fake-claude");
    expect(beforeAssistant.status).toBe("running");
    expect(beforeAssistant.stdout).toBe("");
    expect(beforeAssistant.reviewSource).not.toBe("marked-output");
    expect(beforeAssistant.managementError).toBe("Failed to read Claude logs with exit code 1");

    await writeFile(transcriptPath, createTranscriptLine("assistant finding", true), {
      encoding: "utf8",
      flag: "a",
    });
    const afterAssistant = await readClaudeBackgroundLogs(
      pi as never,
      beforeAssistant,
      "fake-claude",
    );
    expect(afterAssistant.status).toBe("review");
    expect(afterAssistant.stdout).toBe("assistant finding");
    expect(afterAssistant.hasFindings).toBe(true);
    expect(afterAssistant.managementError).toBeNull();
  });

  it("inspects cross-workspace jobs but refuses to auto-fix them", async () => {
    const jobDir = await mkdtemp(join(tmpdir(), "claude-review-jobs-"));
    tempDirs.push(jobDir);
    process.env.PI_CLAUDE_REVIEW_JOB_DIR = jobDir;
    const job = await writeJob(
      createBackgroundJob({
        cwd: "/other-repo",
        status: "review",
        stdout: "Finding in the other repository",
        hasFindings: true,
        reviewSource: "marked-output",
        completedAt: "2026-01-01T00:05:00.000Z",
      }),
    );
    const { pi, command } = createMockPi({
      stdout: JSON.stringify([{ id: "session-123", status: "completed", exitCode: 0 }]),
      stderr: "",
      code: 0,
      killed: false,
    });
    claudeReviewExtension(pi as never);
    const ctx = createContext();

    await command("claude-review-result").handler(job.id, ctx);

    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ cwd: "/other-repo", stdout: expect.any(String) }),
      }),
    );
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("refused for job from /other-repo"),
      "error",
    );
  });

  it("treats symlink aliases as the same workspace for listing and auto-fix", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "claude-review-workspace-"));
    const jobDir = await mkdtemp(join(tmpdir(), "claude-review-jobs-"));
    tempDirs.push(rootDir, jobDir);
    process.env.PI_CLAUDE_REVIEW_JOB_DIR = jobDir;
    const workspace = join(rootDir, "workspace");
    const workspaceAlias = join(rootDir, "workspace-alias");
    await mkdir(workspace);
    await symlink(workspace, workspaceAlias);
    const job = await writeJob(
      createBackgroundJob({
        cwd: workspaceAlias,
        claudeSessionId: undefined,
        status: "review",
        stdout: "Finding through a workspace alias",
        hasFindings: true,
        reviewSource: "marked-output",
        completedAt: "2026-01-01T00:05:00.000Z",
      }),
    );
    const { pi, tool } = createMockPi({
      stdout: JSON.stringify([{ name: job.claudeSessionName, status: "completed", exitCode: 0 }]),
      stderr: "",
      code: 0,
      killed: false,
    });
    claudeReviewExtension(pi as never);
    const ctx = { ...createContext(), cwd: workspace };
    const signal = new AbortController().signal;

    const listed = await tool().execute("call-list", { action: "list" }, signal, undefined, ctx);
    const result = await tool().execute(
      "call-result",
      { action: "result", jobId: job.id },
      signal,
      undefined,
      ctx,
    );

    expect(listed.content[0]?.text).toContain(job.id);
    expect(result.content[0]?.text).not.toContain("Auto-fix refused");
    expect(pi.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("Finding through a workspace alias"),
      { deliverAs: "followUp" },
    );
  });

  it("executes structured tool starts directly without reparsing context as options", async () => {
    const jobDir = await mkdtemp(join(tmpdir(), "claude-review-jobs-"));
    tempDirs.push(jobDir);
    process.env.PI_CLAUDE_REVIEW_JOB_DIR = jobDir;
    const { pi, tool } = createMockPi({
      stdout: "backgrounded · session-tool-123",
      stderr: "",
      code: 0,
      killed: false,
    });
    claudeReviewExtension(pi as never);
    const ctx = createContext();

    const result = await tool().execute(
      "call-1",
      {
        action: "start",
        level: "high",
        context: "Review --fix and --tools behavior",
        autoFix: false,
      },
      new AbortController().signal,
      undefined,
      ctx,
    );

    expect(tool().executionMode).toBe("sequential");
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(pi.exec).toHaveBeenCalledOnce();
    expect(result.details).toMatchObject({
      status: "running",
      autoFix: false,
      contextMessage: "Review --fix and --tools behavior",
    });
    const stored = await readJob(result.details.jobId as string);
    expect(stored.autoFix).toBe(false);
    expect(stored.contextMessage).toBe("Review --fix and --tools behavior");
    expect(stored.prompt).toContain(
      "Review context from the caller:\nReview --fix and --tools behavior",
    );
  });

  it("persists structured background startup failures as terminal jobs", async () => {
    const jobDir = await mkdtemp(join(tmpdir(), "claude-review-jobs-"));
    tempDirs.push(jobDir);
    process.env.PI_CLAUDE_REVIEW_JOB_DIR = jobDir;
    const { pi, tool } = createMockPi();
    pi.exec.mockRejectedValueOnce(new Error("failed to launch Claude"));
    claudeReviewExtension(pi as never);

    const result = await tool().execute(
      "call-start",
      { action: "start" },
      new AbortController().signal,
      undefined,
      createContext(),
    );

    expect(result.details).toMatchObject({
      status: "failed",
      errorMessage: "failed to launch Claude",
    });
    const stored = await readJob(result.details.jobId as string);
    expect(stored.status).toBe("failed");
    expect(stored.completedAt).toBeTruthy();
  });

  it("completes a tool start before a later status operation resolves the latest job", async () => {
    const jobDir = await mkdtemp(join(tmpdir(), "claude-review-jobs-"));
    tempDirs.push(jobDir);
    process.env.PI_CLAUDE_REVIEW_JOB_DIR = jobDir;
    const { pi, tool } = createMockPi();
    pi.exec
      .mockResolvedValueOnce({
        stdout: "backgrounded · session-tool-123",
        stderr: "",
        code: 0,
        killed: false,
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([{ id: "session-tool-123", status: "running" }]),
        stderr: "",
        code: 0,
        killed: false,
      });
    claudeReviewExtension(pi as never);
    const ctx = createContext();
    const signal = new AbortController().signal;

    const started = await tool().execute(
      "call-start",
      { action: "start", autoFix: false },
      signal,
      undefined,
      ctx,
    );
    const status = await tool().execute(
      "call-status",
      { action: "status" },
      signal,
      undefined,
      ctx,
    );

    expect(started.details.jobId).toBeTruthy();
    expect(status.details).toMatchObject({
      jobId: started.details.jobId,
      status: "running",
    });
    expect(pi.exec).toHaveBeenCalledTimes(2);
  });

  it("aborts an in-flight structured status subprocess", async () => {
    const jobDir = await mkdtemp(join(tmpdir(), "claude-review-jobs-"));
    tempDirs.push(jobDir);
    process.env.PI_CLAUDE_REVIEW_JOB_DIR = jobDir;
    const job = await writeJob(createBackgroundJob());
    const { pi, tool } = createMockPi();
    let subprocessSignal: AbortSignal | undefined;
    pi.exec.mockImplementation(
      async (_bin: string, _args: string[], options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          subprocessSignal = options?.signal;
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          });
        }),
    );
    claudeReviewExtension(pi as never);
    const controller = new AbortController();

    const status = tool().execute(
      "call-status",
      { action: "status", jobId: job.id },
      controller.signal,
      undefined,
      createContext(),
    );
    await vi.waitFor(() => expect(subprocessSignal).toBe(controller.signal));
    controller.abort(new Error("status cancelled"));

    await expect(status).rejects.toThrow("status cancelled");
  });

  it.each(["(none)", "No findings reported.", "Nothing actionable here."])(
    "does not auto-fix background reviews that mark no findings: %s",
    async (review) => {
      process.env.PI_CLAUDE_REVIEW_BIN = "fake-claude";
      const homeDir = await mkdtemp(join(tmpdir(), "claude-home-"));
      const jobDir = await mkdtemp(join(tmpdir(), "claude-review-jobs-"));
      tempDirs.push(homeDir, jobDir);
      process.env.HOME = homeDir;
      process.env.PI_CLAUDE_REVIEW_JOB_DIR = jobDir;
      const transcriptDir = join(homeDir, ".claude", "jobs", "session-123");
      await mkdir(transcriptDir, { recursive: true });
      await writeFile(
        join(transcriptDir, "timeline.jsonl"),
        createTranscriptLine(review, false),
        "utf8",
      );
      const job = await writeJob(
        createBackgroundJob({
          status: "running",
          stdout: "",
          lastLog: "",
          autoFix: true,
        }),
      );
      const { pi, command } = createMockPi();
      pi.exec.mockImplementation(async (_bin: string, args: string[]) => {
        if (args[0] === "agents") {
          return {
            stdout: JSON.stringify([{ id: "session-123", status: "completed", exitCode: 0 }]),
            stderr: "",
            code: 0,
            killed: false,
          };
        }
        throw new Error("claude logs should not be read when transcript has markers");
      });
      claudeReviewExtension(pi as never);
      const ctx = createContext();

      await command("claude-review-result").handler(job.id, ctx);

      expect(pi.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.objectContaining({ stdout: review, hasFindings: false }),
        }),
      );
      expect(pi.sendUserMessage).not.toHaveBeenCalled();
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Claude review returned no findings; no auto-fix prompt sent",
        "info",
      );
    },
  );

  it("rejects markerless completed jobs whose stdout is only the startup session banner", async () => {
    process.env.PI_CLAUDE_REVIEW_BIN = "fake-claude";
    const homeDir = await mkdtemp(join(tmpdir(), "claude-home-"));
    const jobDir = await mkdtemp(join(tmpdir(), "claude-review-jobs-"));
    tempDirs.push(homeDir, jobDir);
    process.env.HOME = homeDir;
    process.env.PI_CLAUDE_REVIEW_JOB_DIR = jobDir;
    const startupOutput = "backgrounded · session-123";
    const job = await writeJob(
      createBackgroundJob({
        status: "running",
        stdout: startupOutput,
        lastLog: "",
        autoFix: true,
      }),
    );
    const { pi, command } = createMockPi();
    pi.exec.mockImplementation(async (_bin: string, args: string[]) => {
      if (args[0] === "agents") {
        return {
          stdout: JSON.stringify([{ id: "session-123", status: "completed", exitCode: 0 }]),
          stderr: "",
          code: 0,
          killed: false,
        };
      }
      return { stdout: "markerless completed output", stderr: "", code: 0, killed: false };
    });
    claudeReviewExtension(pi as never);
    const ctx = createContext();

    await command("claude-review-result").handler(job.id, ctx);
    const stored = await readJob(job.id);

    expect(stored.status).toBe("review");
    expect(stored.stdout).toBe("");
    expect(stored.errorMessage).toBeNull();
    expect(stored.managementError).toMatch(/did not contain review result markers/);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          status: "review",
          stdout: "",
          managementError: expect.stringMatching(/did not contain review result markers/),
        }),
      }),
    );
  });

  it("does not treat startup stdout as a persisted review", async () => {
    process.env.PI_CLAUDE_REVIEW_BIN = "fake-claude";
    const homeDir = await mkdtemp(join(tmpdir(), "claude-home-"));
    const jobDir = await mkdtemp(join(tmpdir(), "claude-review-jobs-"));
    tempDirs.push(homeDir, jobDir);
    process.env.HOME = homeDir;
    process.env.PI_CLAUDE_REVIEW_JOB_DIR = jobDir;
    const startupOutput = [
      "backgrounded · session-123 · pi-claude-review:claude-review-20260101000000-abcdef12",
      "  claude attach session-123    open in this terminal",
      "  claude logs session-123      show recent output",
    ].join("\n");
    const job = await writeJob(
      createBackgroundJob({
        status: "running",
        stdout: startupOutput,
        lastLog: "",
        rawStartOutput: startupOutput,
        autoFix: true,
      }),
    );
    const { pi, command } = createMockPi();
    pi.exec.mockImplementation(async (_bin: string, args: string[]) => {
      if (args[0] === "agents") {
        return {
          stdout: JSON.stringify([{ id: "session-123", status: "completed", exitCode: 0 }]),
          stderr: "",
          code: 0,
          killed: false,
        };
      }
      return { stdout: "markerless completed output", stderr: "", code: 0, killed: false };
    });
    claudeReviewExtension(pi as never);
    const ctx = createContext();

    await command("claude-review-result").handler(job.id, ctx);
    const stored = await readJob(job.id);

    expect(stored.status).toBe("review");
    expect(stored.stdout).toBe("");
    expect(stored.errorMessage).toBeNull();
    expect(stored.managementError).toMatch(/did not contain review result markers/);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ status: "review", stdout: "" }),
      }),
    );
  });

  it("does not auto-fix or inject raw logs when result markers are missing", async () => {
    process.env.PI_CLAUDE_REVIEW_BIN = "fake-claude";
    const jobDir = await mkdtemp(join(tmpdir(), "claude-review-jobs-"));
    tempDirs.push(jobDir);
    process.env.PI_CLAUDE_REVIEW_JOB_DIR = jobDir;
    const rawLog = "\u001b[31mfull raw history\u001b[39m\n".repeat(100);
    const job = await writeJob(
      createBackgroundJob({
        status: "running",
        stdout: "",
        lastLog: "",
        autoFix: true,
      }),
    );
    const { pi, command } = createMockPi();
    pi.exec.mockImplementation(async (_bin: string, args: string[]) => {
      if (args[0] === "agents") {
        return {
          stdout: JSON.stringify([{ id: "session-123", status: "completed", exitCode: 0 }]),
          stderr: "",
          code: 0,
          killed: false,
        };
      }
      return { stdout: rawLog, stderr: "", code: 0, killed: false };
    });
    claudeReviewExtension(pi as never);
    const ctx = createContext();

    await command("claude-review-result").handler(job.id, ctx);

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.not.stringContaining("full raw history"),
        details: expect.objectContaining({
          status: "review",
          stdout: "",
          managementError: expect.stringMatching(/did not contain review result markers/),
        }),
      }),
    );
  });

  it("surfaces log-read diagnostics in /claude-review-result output", async () => {
    process.env.PI_CLAUDE_REVIEW_BIN = "fake-claude";
    const jobDir = await mkdtemp(join(tmpdir(), "claude-review-jobs-"));
    tempDirs.push(jobDir);
    process.env.PI_CLAUDE_REVIEW_JOB_DIR = jobDir;
    const startupOutput = "backgrounded · session-123";
    const job = await writeJob(
      createBackgroundJob({
        status: "running",
        stdout: startupOutput,
        rawStartOutput: startupOutput,
        lastLog: "",
        autoFix: true,
      }),
    );
    const { pi, command } = createMockPi();
    pi.exec.mockImplementation(async (_bin: string, args: string[]) => {
      if (args[0] === "agents") {
        return {
          stdout: JSON.stringify([{ id: "session-123", status: "completed", exitCode: 0 }]),
          stderr: "",
          code: 0,
          killed: false,
        };
      }
      return { stdout: "session not found", stderr: "", code: 1, killed: false };
    });
    claudeReviewExtension(pi as never);
    const ctx = createContext();

    await command("claude-review-result").handler(job.id, ctx);

    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("session not found"),
        details: expect.objectContaining({
          status: "review",
          stdout: "session not found",
          managementError: "Failed to read Claude logs with exit code 1",
        }),
      }),
    );
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("keeps a failed background status when logs contain review markers", async () => {
    const jobDir = await mkdtemp(join(tmpdir(), "claude-review-jobs-"));
    tempDirs.push(jobDir);
    process.env.PI_CLAUDE_REVIEW_JOB_DIR = jobDir;
    const markedReview = markedReviewOutput("partial review", true);
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
    expect(withLogs.stdout).toBe("");
    expect(withLogs.lastLog).toContain("partial review");
    expect(withLogs.errorMessage).toBe("Claude background session failed");
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("does not let transcript reads overwrite terminal job output", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "claude-home-"));
    const jobDir = await mkdtemp(join(tmpdir(), "claude-review-jobs-"));
    tempDirs.push(homeDir, jobDir);
    process.env.HOME = homeDir;
    process.env.PI_CLAUDE_REVIEW_JOB_DIR = jobDir;
    const transcriptDir = join(homeDir, ".claude", "jobs", "session-123");
    await mkdir(transcriptDir, { recursive: true });
    await writeFile(
      join(transcriptDir, "timeline.jsonl"),
      createTranscriptLine("stale review"),
      "utf8",
    );
    const { pi } = createMockPi();
    const job = createBackgroundJob({
      status: "cancelled",
      stdout: "cancelled by user",
      completedAt: "2026-01-01T00:05:00.000Z",
      errorMessage: null,
    });

    const withLogs = await readClaudeBackgroundLogs(pi as never, job, "fake-claude");

    expect(withLogs.status).toBe("cancelled");
    expect(withLogs.stdout).toBe("cancelled by user");
    expect(withLogs.reviewSource).toBeUndefined();
    expect(pi.exec).not.toHaveBeenCalled();
  });

  it("does not trust marked terminal logs without an assistant transcript record", async () => {
    const jobDir = await mkdtemp(join(tmpdir(), "claude-review-jobs-"));
    tempDirs.push(jobDir);
    process.env.PI_CLAUDE_REVIEW_JOB_DIR = jobDir;
    const markedReview = markedReviewOutput("final review", true);
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

    expect(withLogs.status).toBe("running");
    expect(withLogs.stdout).toBe("");
    expect(withLogs.reviewSource).not.toBe("marked-output");
    expect(withLogs.lastLog).toContain("final review");
  });

  it("preserves completed background reviews when later successful log reads lack markers", async () => {
    const jobDir = await mkdtemp(join(tmpdir(), "claude-review-jobs-"));
    tempDirs.push(jobDir);
    process.env.PI_CLAUDE_REVIEW_JOB_DIR = jobDir;
    const { pi } = createMockPi({
      stdout: "markerless later log read",
      stderr: "",
      code: 0,
      killed: false,
    });
    const job = await writeJob(
      createBackgroundJob({
        status: "review",
        stdout: "final review",
        lastLog: createTranscriptLine("final review"),
        completedAt: "2026-01-01T00:05:00.000Z",
        exitCode: 0,
      }),
    );

    const withLogs = await readClaudeBackgroundLogs(pi as never, job, "fake-claude");
    const stored = await readJob(job.id);

    expect(withLogs.status).toBe("review");
    expect(withLogs.stdout).toBe("final review");
    expect(withLogs.completedAt).toBe("2026-01-01T00:05:00.000Z");
    expect(withLogs.errorMessage).toBeNull();
    expect(stored.status).toBe("review");
    expect(stored.stdout).toBe("final review");
  });

  it("preserves legacy completed reviews after lastLog markers have been truncated", async () => {
    const jobDir = await mkdtemp(join(tmpdir(), "claude-review-jobs-"));
    tempDirs.push(jobDir);
    process.env.PI_CLAUDE_REVIEW_JOB_DIR = jobDir;
    const { pi } = createMockPi({
      stdout: "markerless later log read",
      stderr: "",
      code: 0,
      killed: false,
    });
    const job = await writeJob(
      createBackgroundJob({
        status: "review",
        stdout: "final review",
        lastLog: "x".repeat(20_000),
        reviewSource: undefined,
        completedAt: "2026-01-01T00:05:00.000Z",
        exitCode: 0,
      }),
    );

    const withLogs = await readClaudeBackgroundLogs(pi as never, job, "fake-claude");
    const stored = await readJob(job.id);

    expect(withLogs.status).toBe("review");
    expect(withLogs.stdout).toBe("final review");
    expect(withLogs.completedAt).toBe("2026-01-01T00:05:00.000Z");
    expect(withLogs.errorMessage).toBeNull();
    expect(stored.status).toBe("review");
    expect(stored.stdout).toBe("final review");
  });

  it("preserves completed background reviews when later log reads fail", async () => {
    const jobDir = await mkdtemp(join(tmpdir(), "claude-review-jobs-"));
    tempDirs.push(jobDir);
    process.env.PI_CLAUDE_REVIEW_JOB_DIR = jobDir;
    const { pi } = createMockPi({
      stdout: "",
      stderr: "session not found",
      code: 1,
      killed: false,
    });
    const job = await writeJob(
      createBackgroundJob({
        status: "review",
        stdout: "final review",
        completedAt: "2026-01-01T00:05:00.000Z",
        exitCode: 0,
      }),
    );

    const withLogs = await readClaudeBackgroundLogs(pi as never, job, "fake-claude");
    const stored = await readJob(job.id);

    expect(withLogs.status).toBe("review");
    expect(withLogs.stdout).toBe("final review");
    expect(withLogs.managementError).toBe("Failed to read Claude logs with exit code 1");
    expect(stored.status).toBe("review");
    expect(stored.stdout).toBe("final review");
    expect(stored.completedAt).toBe("2026-01-01T00:05:00.000Z");
    expect(stored.exitCode).toBe(0);
    expect(stored.errorMessage).toBeNull();
  });

  it("keeps status polling failures retryable and clears diagnostics after recovery", async () => {
    const jobDir = await mkdtemp(join(tmpdir(), "claude-review-jobs-"));
    tempDirs.push(jobDir);
    process.env.PI_CLAUDE_REVIEW_JOB_DIR = jobDir;
    const { pi } = createMockPi();
    pi.exec
      .mockResolvedValueOnce({ stdout: "", stderr: "timeout", code: 0, killed: true })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([{ id: "session-123", status: "running" }]),
        stderr: "",
        code: 0,
        killed: false,
      });
    const job = createBackgroundJob({ status: "running" });

    const unavailable = await refreshClaudeBackgroundJob(pi as never, job, "fake-claude");
    expect(unavailable.status).toBe("running");
    expect(unavailable.managementError).toBe("Timed out while checking Claude background agents");
    expect(unavailable.managementErrorSource).toBe("status");
    expect(unavailable.stderr).toBe("timeout");

    const recovered = await refreshClaudeBackgroundJob(pi as never, unavailable, "fake-claude");
    expect(recovered.status).toBe("running");
    expect(recovered.managementError).toBeNull();
    expect(recovered.managementErrorSource).toBeNull();
    expect(recovered.stderr).toBe("");
  });

  it("preserves a failed status diagnostic when log retrieval succeeds", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "claude-home-"));
    const jobDir = await mkdtemp(join(tmpdir(), "claude-review-jobs-"));
    tempDirs.push(homeDir, jobDir);
    process.env.HOME = homeDir;
    process.env.PI_CLAUDE_REVIEW_JOB_DIR = jobDir;
    const transcriptDir = join(homeDir, ".claude", "jobs", "session-123");
    await mkdir(transcriptDir, { recursive: true });
    await writeFile(
      join(transcriptDir, "timeline.jsonl"),
      createTranscriptLine("assistant finding", true),
      "utf8",
    );
    const { pi } = createMockPi({
      stdout: "",
      stderr: "status supervisor unavailable",
      code: 1,
      killed: false,
    });
    const job = createBackgroundJob({ status: "running" });

    const unavailable = await refreshClaudeBackgroundJob(pi as never, job, "fake-claude");
    const withLogs = await readClaudeBackgroundLogs(pi as never, unavailable, "fake-claude");

    expect(withLogs.stdout).toBe("assistant finding");
    expect(withLogs.managementError).toBe(
      "Failed to check Claude background agents with exit code 1",
    );
    expect(withLogs.managementErrorSource).toBe("status");
    expect(withLogs.stderr).toBe("status supervisor unavailable");
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

  it("rejects prompt placeholders as marked review results", () => {
    const placeholder = markedReviewOutput(
      "<your concise, actionable review or no-findings summary>",
      true,
    );

    expect(extractMarkedReview(placeholder)).toBeUndefined();
    expect(extractMarkedReviewResult(placeholder)).toBeUndefined();
  });

  it("extracts machine-readable findings markers", () => {
    expect(extractMarkedReviewResult(markedReviewOutput("No action needed", false))).toEqual({
      review: "No action needed",
      hasFindings: false,
    });
  });

  it("does not reuse findings markers from earlier review blocks", () => {
    const mixedOutput = [
      markedReviewOutput("first review", true),
      CLAUDE_REVIEW_RESULT_START,
      "later review",
      CLAUDE_REVIEW_RESULT_END,
    ].join("\n");

    expect(extractMarkedReviewResult(mixedOutput)).toEqual({
      review: "later review",
      hasFindings: undefined,
    });
  });

  it("strips terminal controls before extracting review markers", () => {
    const markedReview = `${CLAUDE_REVIEW_RESULT_START}
\u001b[31mFinding: fix the edge case\u001b[39m
${CLAUDE_REVIEW_RESULT_END}`;

    expect(extractMarkedReview(markedReview)).toBe("Finding: fix the edge case");
  });

  it("strips OSC terminal controls from review output", () => {
    const escape = String.fromCharCode(27);
    const bell = String.fromCharCode(7);
    const markedReview = `${CLAUDE_REVIEW_RESULT_START}
Finding${escape}]0;window title${bell}: fix the edge case
${CLAUDE_REVIEW_RESULT_END}`;

    expect(extractMarkedReview(markedReview)).toBe("Finding: fix the edge case");
    expect(sanitizeClaudeLog(`before${escape}]0;window title${bell}after`)).toBe("beforeafter");
  });

  it("strips 8-bit C1 terminal controls from review output", () => {
    const c1Csi = String.fromCharCode(0x9b);
    const markedReview = `${CLAUDE_REVIEW_RESULT_START}
${c1Csi}31mFinding: fix the edge case${c1Csi}39m
${CLAUDE_REVIEW_RESULT_END}`;

    expect(extractMarkedReview(markedReview)).toBe("Finding: fix the edge case");
    expect(sanitizeClaudeLog(`${c1Csi}31mred${c1Csi}39m`)).toBe("red");
  });
});
