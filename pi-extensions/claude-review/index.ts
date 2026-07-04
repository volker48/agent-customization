import {
  BorderedLoader,
  getMarkdownTheme,
  type ExecResult,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";

import {
  buildCodeReviewPrompt,
  parseClaudeReviewArgs,
  parseClaudeReviewJobArgs,
  parseClaudeReviewResultArgs,
  type ClaudeReviewOptions,
} from "./args.js";
import {
  cancelClaudeBackgroundJob,
  claudeBackgroundArgs,
  readClaudeBackgroundLogs,
  refreshClaudeBackgroundJob,
  startClaudeBackgroundReview,
} from "./claude-bg.js";
import { createJob, isTerminalJobStatus, listJobs, resolveJob, writeJob } from "./jobs.js";
import type { ClaudeReviewJob } from "./jobs.js";
import type { ClaudeReviewDetails } from "./render.js";
import {
  buildAutoFixPrompt,
  buildJobsListDetails,
  CLAUDE_REVIEW_MESSAGE_TYPE,
  jobToClaudeReviewDetails,
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
  return [
    "--permission-mode",
    "auto",
    "--tools",
    REVIEW_TOOLS,
    "--allowed-tools",
    REVIEW_TOOLS,
    "-p",
    prompt,
  ];
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

function reviewHasFindings(details: ClaudeReviewDetails): boolean {
  const review = details.stdout.trim().toLowerCase();
  return !["", "(none)", "none", "no findings", "no findings."].includes(review);
}

function maybeNotifyNoFindings(ctx: ExtensionCommandContext, details: ClaudeReviewDetails): void {
  if (!reviewHasFindings(details)) {
    ctx.ui.notify("Claude review returned no findings; no auto-fix prompt sent", "info");
  }
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
  } else if (autoFix && reviewHasFindings(details)) {
    pi.sendUserMessage(buildAutoFixPrompt(details));
  } else {
    sendReviewOnly(pi, details);
    if (autoFix) {
      maybeNotifyNoFindings(ctx, details);
    }
  }
}

async function handleWaitClaudeReviewCommand(
  pi: ExtensionAPI,
  options: ClaudeReviewOptions,
  ctx: ExtensionCommandContext,
): Promise<void> {
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

async function handleBackgroundClaudeReviewCommand(
  pi: ExtensionAPI,
  options: ClaudeReviewOptions,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const controller = new AbortController();
  let job: ClaudeReviewJob | undefined;

  updateLoader(ctx, "Claude review: waiting for Pi to become idle…", controller);
  try {
    await ctx.waitForIdle();
    const prompt = buildCodeReviewPrompt(options, { resultMarkers: true });
    job = await createJob({ cwd: ctx.cwd, options, prompt });
    updateLoader(ctx, `Claude review: starting background job ${job.id}…`, controller);
    job = await startClaudeBackgroundReview(
      pi,
      job,
      claudeBinary(),
      REVIEW_TOOLS,
      controller.signal,
    );
    sendReviewOnly(pi, jobToClaudeReviewDetails(job));

    if (job.status === "running") {
      ctx.ui.notify(`Claude review started: ${job.id}`, "info");
    } else if (job.status === "failed" || job.status === "timeout") {
      ctx.ui.notify(`Claude review did not start: ${job.errorMessage ?? job.status}`, "error");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (job) {
      job = await writeJob({
        ...job,
        status: controller.signal.aborted ? "cancelled" : "failed",
        completedAt: new Date().toISOString(),
        errorMessage: message,
      });
      sendReviewOnly(pi, jobToClaudeReviewDetails(job));
    }
    ctx.ui.notify(
      controller.signal.aborted ? "Claude review cancelled" : `Claude review failed: ${message}`,
      "error",
    );
  } finally {
    clearLoader(ctx);
  }
}

async function handleClaudeReviewCommand(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  try {
    const options = parseClaudeReviewArgs(args);
    if (options.mode === "wait") {
      await handleWaitClaudeReviewCommand(pi, options, ctx);
    } else {
      await handleBackgroundClaudeReviewCommand(pi, options, ctx);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Claude review failed: ${message}`, "error");
  }
}

async function handleClaudeReviewStatusCommand(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  try {
    const { all, jobId } = parseClaudeReviewJobArgs(args);
    if (all) {
      throw new Error("--all is only supported by /claude-review-list");
    }
    const job = await resolveJob(jobId, ctx.cwd);
    const refreshed = await refreshClaudeBackgroundJob(pi, job, claudeBinary());
    sendReviewOnly(pi, jobToClaudeReviewDetails(refreshed, refreshed.lastLog || refreshed.stdout));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Claude review status failed: ${message}`, "error");
  }
}

async function handleClaudeReviewResultCommand(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  try {
    const options = parseClaudeReviewResultArgs(args);
    const job = await resolveJob(options.jobId, ctx.cwd);
    const refreshed = await refreshClaudeBackgroundJob(pi, job, claudeBinary());
    const withLogs = refreshed.claudeSessionId
      ? await readClaudeBackgroundLogs(pi, refreshed, claudeBinary())
      : refreshed;
    const details = jobToClaudeReviewDetails(withLogs);
    const autoFix = options.fix ?? withLogs.autoFix;
    const shouldFix = details.status === "review" && autoFix && reviewHasFindings(details);

    sendReviewOnly(pi, details);
    if (shouldFix) {
      pi.sendUserMessage(buildAutoFixPrompt(details));
    } else if (details.status === "review" && autoFix) {
      maybeNotifyNoFindings(ctx, details);
    } else if (!isTerminalJobStatus(withLogs.status)) {
      ctx.ui.notify(`Claude review is ${withLogs.status}; no auto-fix prompt sent yet`, "info");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Claude review result failed: ${message}`, "error");
  }
}

async function handleClaudeReviewLogsCommand(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  try {
    const { all, jobId } = parseClaudeReviewJobArgs(args);
    if (all) {
      throw new Error("--all is only supported by /claude-review-list");
    }
    const job = await resolveJob(jobId, ctx.cwd);
    const refreshed = await refreshClaudeBackgroundJob(pi, job, claudeBinary());
    const withLogs = refreshed.claudeSessionId
      ? await readClaudeBackgroundLogs(pi, refreshed, claudeBinary())
      : refreshed;
    sendReviewOnly(pi, jobToClaudeReviewDetails(withLogs, withLogs.lastLog || withLogs.stdout));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Claude review logs failed: ${message}`, "error");
  }
}

async function handleClaudeReviewCancelCommand(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  try {
    const { all, jobId } = parseClaudeReviewJobArgs(args);
    if (all) {
      throw new Error("--all is only supported by /claude-review-list");
    }
    const job = await resolveJob(jobId, ctx.cwd);
    const cancelled = await cancelClaudeBackgroundJob(pi, job, claudeBinary());
    sendReviewOnly(pi, jobToClaudeReviewDetails(cancelled));
    ctx.ui.notify(
      `Claude review ${cancelled.status}: ${cancelled.id}`,
      cancelled.status === "cancelled" ? "info" : "error",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Claude review cancel failed: ${message}`, "error");
  }
}

async function handleClaudeReviewListCommand(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  try {
    const { all, jobId } = parseClaudeReviewJobArgs(args);
    if (jobId) {
      throw new Error("/claude-review-list does not accept a job id");
    }
    const jobs = await listJobs(all ? {} : { cwd: ctx.cwd });
    sendReviewOnly(pi, buildJobsListDetails(jobs, ctx.cwd, all));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Claude review list failed: ${message}`, "error");
  }
}

export default function claudeReviewExtension(pi: ExtensionAPI) {
  pi.registerMessageRenderer<ClaudeReviewDetails>(CLAUDE_REVIEW_MESSAGE_TYPE, (message) => {
    return new Markdown(renderClaudeReviewMarkdown(message.details), 1, 0, getMarkdownTheme());
  });

  pi.registerCommand("claude-review", {
    description:
      "Start a durable Claude Code /code-review job; use --wait for legacy blocking mode",
    handler: (args, ctx) => handleClaudeReviewCommand(pi, args, ctx),
  });
  pi.registerCommand("claude-review-status", {
    description: "Refresh and display a Claude Code review job status",
    handler: (args, ctx) => handleClaudeReviewStatusCommand(pi, args, ctx),
  });
  pi.registerCommand("claude-review-result", {
    description: "Fetch Claude Code review output and optionally ask Pi to fix findings",
    handler: (args, ctx) => handleClaudeReviewResultCommand(pi, args, ctx),
  });
  pi.registerCommand("claude-review-logs", {
    description: "Fetch recent logs for a Claude Code review job",
    handler: (args, ctx) => handleClaudeReviewLogsCommand(pi, args, ctx),
  });
  pi.registerCommand("claude-review-cancel", {
    description: "Stop a running Claude Code review job",
    handler: (args, ctx) => handleClaudeReviewCancelCommand(pi, args, ctx),
  });
  pi.registerCommand("claude-review-list", {
    description: "List durable Claude Code review jobs for this working directory",
    handler: (args, ctx) => handleClaudeReviewListCommand(pi, args, ctx),
  });
}

export { buildCodeReviewPrompt, claudeArgs, claudeBackgroundArgs, parseClaudeReviewArgs };
