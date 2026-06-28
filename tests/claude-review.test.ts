import { afterEach, describe, expect, it, vi } from "vitest";

import claudeReviewExtension, {
  buildCodeReviewPrompt,
  claudeArgs,
  parseClaudeReviewArgs,
} from "../pi-extensions/claude-review/index.js";

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
  let command: RegisteredCommand | undefined;
  return {
    pi: {
      registerMessageRenderer: vi.fn(),
      registerCommand: vi.fn((_name: string, registered: RegisteredCommand) => {
        command = registered;
      }),
      exec: vi.fn(async () => execResult),
      sendUserMessage: vi.fn(),
      sendMessage: vi.fn(),
    },
    command() {
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

describe("claude review arguments", () => {
  it("defaults to auto-fix medium review with optional empty context", () => {
    expect(parseClaudeReviewArgs("")).toEqual({
      autoFix: true,
      level: "medium",
      contextMessage: "",
    });
  });

  it("parses --no-fix, level, and context message", () => {
    expect(parseClaudeReviewArgs("--no-fix high read issue #23")).toEqual({
      autoFix: false,
      level: "high",
      contextMessage: "read issue #23",
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

  afterEach(() => {
    if (originalBin === undefined) {
      delete process.env.PI_CLAUDE_REVIEW_BIN;
    } else {
      process.env.PI_CLAUDE_REVIEW_BIN = originalBin;
    }
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

    await command().handler("high read issue #23", ctx);

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

    await command().handler("--no-fix low", ctx);

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

    await command().handler("medium", ctx);

    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("- Auto-fix: `on`"),
        details: expect.objectContaining({ status: "failed", autoFix: true }),
      }),
    );
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Claude review failed with exit code 2", "error");
  });
});
