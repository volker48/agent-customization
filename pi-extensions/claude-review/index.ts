import {
  BorderedLoader,
  getMarkdownTheme,
  type ExecResult,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";

import { buildCodeReviewPrompt, parseClaudeReviewArgs, type ClaudeReviewOptions } from "./args.js";
import type { ClaudeReviewDetails } from "./render.js";
import {
  buildAutoFixPrompt,
  CLAUDE_REVIEW_MESSAGE_TYPE,
  renderClaudeReviewMarkdown,
  toClaudeReviewMessage,
} from "./render.js";

const CLAUDE_BIN_ENV = "PI_CLAUDE_REVIEW_BIN";
const DEFAULT_CLAUDE_BIN = "claude";
const LOADER_KEY = "claude-review";
const REVIEW_TIMEOUT_MS = 20 * 60 * 1000;
const REVIEW_TOOLS = "Bash,Read,Glob,Grep,LSP,WebFetch,WebSearch,Skill";

function claudeBinary(): string {
  return process.env[CLAUDE_BIN_ENV]?.trim() || DEFAULT_CLAUDE_BIN;
}

function claudeArgs(prompt: string): string[] {
  return ["--permission-mode", "auto", "--allowed-tools", REVIEW_TOOLS, "-p", prompt];
}

function updateLoader(ctx: ExtensionCommandContext, message: string, controller: AbortController) {
  ctx.ui.setStatus(LOADER_KEY, message.replace(/\n/g, " · "));
  ctx.ui.setWidget(LOADER_KEY, (tui, theme) => {
    const loader = new BorderedLoader(tui, theme, message, { cancellable: true });
    loader.onAbort = () => controller.abort();
    return loader;
  });
}

function clearLoader(ctx: ExtensionCommandContext) {
  ctx.ui.setStatus(LOADER_KEY, undefined);
  ctx.ui.setWidget(LOADER_KEY, undefined);
}

function sendReviewOnly(pi: ExtensionAPI, details: ClaudeReviewDetails): void {
  pi.sendMessage(toClaudeReviewMessage(details));
}

function toReviewDetails(result: ExecResult, options: ClaudeReviewOptions): ClaudeReviewDetails {
  return {
    status: result.killed ? "timeout" : result.code === 0 ? "review" : "failed",
    level: options.level,
    contextMessage: options.contextMessage,
    autoFix: options.autoFix,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.code,
  };
}

function handleReviewResult(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  result: ExecResult,
  details: ClaudeReviewDetails,
  autoFix: boolean,
): void {
  if (result.killed) {
    sendReviewOnly(pi, details);
    ctx.ui.notify("Claude review timed out after 20 minutes", "error");
  } else if (result.code !== 0) {
    sendReviewOnly(pi, details);
    ctx.ui.notify(`Claude review failed with exit code ${result.code}`, "error");
  } else if (autoFix) {
    pi.sendUserMessage(buildAutoFixPrompt(details));
  } else {
    sendReviewOnly(pi, details);
  }
}

async function handleClaudeReviewCommand(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const options = parseClaudeReviewArgs(args);
  const controller = new AbortController();
  const reviewPrompt = buildCodeReviewPrompt(options);

  updateLoader(ctx, "Claude review: waiting for Pi to become idle…", controller);
  try {
    await ctx.waitForIdle();
    updateLoader(ctx, `Claude review: running /code-review ${options.level}…`, controller);
    const result = await pi.exec(claudeBinary(), claudeArgs(reviewPrompt), {
      cwd: ctx.cwd,
      signal: controller.signal,
      timeout: REVIEW_TIMEOUT_MS,
    });

    const details = toReviewDetails(result, options);
    if (controller.signal.aborted) {
      ctx.ui.notify("Claude review cancelled", "info");
    } else {
      handleReviewResult(pi, ctx, result, details, options.autoFix);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (controller.signal.aborted) {
      ctx.ui.notify("Claude review cancelled", "info");
    } else {
      ctx.ui.notify(`Claude review failed: ${message}`, "error");
    }
  } finally {
    clearLoader(ctx);
  }
}

export default function claudeReviewExtension(pi: ExtensionAPI) {
  pi.registerMessageRenderer<ClaudeReviewDetails>(CLAUDE_REVIEW_MESSAGE_TYPE, (message) => {
    return new Markdown(renderClaudeReviewMarkdown(message.details), 1, 0, getMarkdownTheme());
  });

  pi.registerCommand("claude-review", {
    description: "Run Claude Code /code-review and optionally ask Pi to fix findings",
    handler: (args, ctx) => handleClaudeReviewCommand(pi, args, ctx),
  });
}

export { buildCodeReviewPrompt, claudeArgs, parseClaudeReviewArgs };
