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
  DEFAULT_CLAUDE_MODEL,
  parseClaudeReviewArgs,
  parseClaudeReviewJobArgs,
  parseClaudeReviewResultArgs,
  type ClaudeReviewOptions,
} from "./args.js";
import {
  cancelClaudeBackgroundJob,
  claudeBackgroundArgs,
  extractMarkedReviewResult,
  readClaudeBackgroundLogs,
  refreshClaudeBackgroundJob,
  startClaudeBackgroundReview,
} from "./claude-bg.js";
import { createJob, isTerminalJobStatus, listJobs, resolveJob, writeJob } from "./jobs.js";
import type { ClaudeReviewJob } from "./jobs.js";
import type { ClaudeReviewDetails } from "./render.js";
import {
  capsuleRevisionLabel,
  extractSessionEvidence,
  generateCapsule,
  loadCapsule,
  previewCapsule,
  type Capsule,
  type SessionEntryLike,
} from "../lib/context-capsule.js";
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
const CAPSULE_REVIEW_TOOLS = "Read,Glob,Grep,LSP,WebFetch,WebSearch,Skill";

function claudeBinary(): string {
  return process.env[CLAUDE_BIN_ENV]?.trim() || DEFAULT_CLAUDE_BIN;
}

function claudeArgs(prompt: string, reviewTools = REVIEW_TOOLS): string[] {
  return [
    "--permission-mode",
    "auto",
    "--model",
    DEFAULT_CLAUDE_MODEL,
    "--tools",
    reviewTools,
    "--allowed-tools",
    reviewTools,
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

type CapsuleSessionContext = {
  sessionManager: {
    getBranch: () => unknown[];
    getSessionId: () => string;
    getSessionFile: () => string | undefined;
  };
};

/** Resolve and confirm capsule grounding before any job file or Claude process exists. */
async function prepareCapsule(
  options: ClaudeReviewOptions,
  ctx: ExtensionCommandContext,
  signal: AbortSignal,
): Promise<Capsule | undefined | null> {
  const reference = options.capsuleReference;
  if (!reference) return undefined;
  if (signal.aborted) {
    ctx.ui.notify("Claude review cancelled", "info");
    return null;
  }

  const session = ctx as unknown as CapsuleSessionContext;
  const capsuleResult =
    reference === "current"
      ? await generateCapsule(
          extractSessionEvidence(session.sessionManager.getBranch() as SessionEntryLike[], ctx.cwd),
          {
            sessionId: session.sessionManager.getSessionId(),
            sessionFile: session.sessionManager.getSessionFile(),
            cwd: ctx.cwd,
            signal,
          },
        )
      : await loadCapsule(reference);

  if (signal.aborted) {
    ctx.ui.notify("Claude review cancelled", "info");
    return null;
  }
  if ("error" in capsuleResult) {
    const { error } = capsuleResult;
    ctx.ui.notify(`Claude review capsule rejected: ${error.code}: ${error.message}`, "error");
    return null;
  }

  const capsule = capsuleResult.value;
  const preview = previewCapsule(capsule);
  ctx.ui.notify(
    `Claude review will use Context Capsule ${capsuleRevisionLabel(capsule)} as untrusted grounding.\n\n${preview.humanText}\n\nCanonical representation: ${preview.byteLength} UTF-8 bytes`,
    "info",
  );

  const interactiveContext = ctx as unknown as {
    hasUI?: boolean;
    ui: { confirm?: (title: string, message: string) => Promise<boolean> };
  };
  if (interactiveContext.hasUI === false || typeof interactiveContext.ui.confirm !== "function") {
    ctx.ui.notify(
      "Capsule-grounded Claude review requires explicit interactive confirmation; no job or subprocess was started.",
      "error",
    );
    return null;
  }
  const confirmed = await interactiveContext.ui.confirm(
    "Start Claude review with this Context Capsule?",
    `Claude receives ${capsuleRevisionLabel(capsule)} as bounded untrusted data. Review subprocess tools remain read-only.`,
  );
  if (signal.aborted) {
    ctx.ui.notify("Claude review cancelled", "info");
    return null;
  }
  if (!confirmed) {
    ctx.ui.notify("Claude review cancelled; no job or subprocess was started.", "info");
    return null;
  }
  options.capsuleProvenance = {
    capsuleId: capsule.capsuleId,
    revision: capsule.revision,
    source: reference === "current" ? "current-session" : "saved",
  };
  return capsule;
}

function sendReviewOnly(pi: ExtensionAPI, details: ClaudeReviewDetails): void {
  pi.sendMessage(toClaudeReviewMessage(details));
}

function toReviewDetails(result: ExecResult, options: ClaudeReviewOptions): ClaudeReviewDetails {
  const markedResult = extractMarkedReviewResult(result.stdout);
  return {
    status: result.killed ? "timeout" : result.code === 0 ? "review" : "failed",
    level: options.level,
    contextMessage: options.contextMessage,
    autoFix: options.autoFix,
    capsuleProvenance: options.capsuleProvenance,
    stdout: markedResult?.review ?? result.stdout,
    stderr: result.stderr,
    exitCode: result.code,
    hasFindings: markedResult?.hasFindings,
  };
}

function reviewHasFindings(details: ClaudeReviewDetails): boolean {
  return details.hasFindings === true;
}

function maybeNotifyNoFindings(ctx: ExtensionCommandContext, details: ClaudeReviewDetails): void {
  if (details.hasFindings === false) {
    ctx.ui.notify("Claude review returned no findings; no auto-fix prompt sent", "info");
  } else if (details.hasFindings == null) {
    ctx.ui.notify(
      "Claude review did not include a findings marker; no auto-fix prompt sent",
      "warning",
    );
  }
}

function logReadFailureOutput(job: ClaudeReviewJob): string {
  return job.errorMessage?.startsWith("Failed to read Claude logs") ? job.lastLog : "";
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

  updateLoader(ctx, "Claude review: waiting for Pi to become idle…", controller);
  try {
    await ctx.waitForIdle();
    const capsule = await prepareCapsule(options, ctx, controller.signal);
    if (capsule === null) return;
    const reviewPrompt = buildCodeReviewPrompt(options, { resultMarkers: true, capsule });
    updateLoader(ctx, `Claude review: running /code-review ${options.level}…`, controller);
    const reviewTools = capsule ? CAPSULE_REVIEW_TOOLS : REVIEW_TOOLS;
    const result = await pi.exec(claudeBinary(), claudeArgs(reviewPrompt, reviewTools), {
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
    const capsule = await prepareCapsule(options, ctx, controller.signal);
    if (capsule === null) return;
    const prompt = buildCodeReviewPrompt(options, { resultMarkers: true, capsule });
    job = await createJob({ cwd: ctx.cwd, options, prompt });
    updateLoader(ctx, `Claude review: starting background job ${job.id}…`, controller);
    job = await startClaudeBackgroundReview(
      pi,
      job,
      claudeBinary(),
      capsule ? CAPSULE_REVIEW_TOOLS : REVIEW_TOOLS,
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
    const output = withLogs.stdout || logReadFailureOutput(withLogs);
    const details = jobToClaudeReviewDetails(withLogs, output);
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
