import { resolve } from "node:path";

import { StringEnum, Type, type Static } from "@earendil-works/pi-ai";
import {
  BorderedLoader,
  getMarkdownTheme,
  type ExecResult,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";

import {
  buildCodeReviewPrompt,
  CLAUDE_REVIEW_RESULT_END,
  CLAUDE_REVIEW_RESULT_START,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_REVIEW_LEVEL,
  parseClaudeReviewArgs,
  parseClaudeReviewJobArgs,
  parseClaudeReviewResultArgs,
  REVIEW_LEVELS,
  type ClaudeReviewOptions,
  type ReviewLevel,
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
const CLAUDE_REVIEW_TOOL_ACTIONS = ["start", "status", "result", "logs", "cancel", "list"] as const;

const ClaudeReviewToolParams = Type.Object({
  action: StringEnum(CLAUDE_REVIEW_TOOL_ACTIONS, {
    description: "Claude review workflow operation",
  }),
  level: Type.Optional(StringEnum(REVIEW_LEVELS)),
  context: Type.Optional(Type.String({ description: "Review context for a new job" })),
  mode: Type.Optional(StringEnum(["background", "wait"] as const)),
  autoFix: Type.Optional(Type.Boolean()),
  jobId: Type.Optional(Type.String({ description: "Explicit Claude review job id" })),
  all: Type.Optional(Type.Boolean({ description: "List jobs from every working directory" })),
});

function claudeBinary(): string {
  return process.env[CLAUDE_BIN_ENV]?.trim() || DEFAULT_CLAUDE_BIN;
}

function claudeArgs(
  prompt: string,
  effort: ReviewLevel = DEFAULT_REVIEW_LEVEL,
  reviewTools = REVIEW_TOOLS,
): string[] {
  return [
    "--permission-mode",
    "auto",
    "--model",
    DEFAULT_CLAUDE_MODEL,
    "--effort",
    effort,
    "--tools",
    reviewTools,
    "--allowed-tools",
    reviewTools,
    "-p",
    prompt,
  ];
}

type LoaderOperation = (
  controller: AbortController,
  updateStatus: (message: string) => void,
) => Promise<void>;

async function waitForIdleUnlessAborted(
  ctx: ExtensionCommandContext,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return false;

  return new Promise<boolean>((resolveIdle, rejectIdle) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      resolveIdle(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void ctx.waitForIdle().then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolveIdle(!signal.aborted);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        rejectIdle(error);
      },
    );
  });
}

async function runWithCancellableLoader(
  ctx: ExtensionCommandContext,
  initialMessage: string,
  operation: LoaderOperation,
): Promise<void> {
  const controller = new AbortController();
  const updateStatus = (message: string) => {
    ctx.ui.setStatus(LOADER_KEY, message.replace(/\n/g, " · "));
  };
  updateStatus(initialMessage);

  try {
    if (ctx.mode !== "tui") {
      await operation(controller, updateStatus);
      return;
    }

    let operationError: unknown;
    await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
      const loader = new BorderedLoader(tui, theme, initialMessage, { cancellable: true });
      loader.onAbort = () => controller.abort();
      void operation(controller, updateStatus)
        .catch((error: unknown) => {
          operationError = error;
        })
        .finally(() => done());
      return loader;
    });
    if (operationError !== undefined) {
      throw operationError;
    }
  } finally {
    ctx.ui.setStatus(LOADER_KEY, undefined);
  }
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

function toReviewDetails(
  result: ExecResult,
  options: ClaudeReviewOptions,
  cwd: string,
): ClaudeReviewDetails {
  const markedResult = extractMarkedReviewResult(result.stdout);
  const invalidMarkedResult =
    result.code === 0 &&
    result.stdout.includes(CLAUDE_REVIEW_RESULT_START) &&
    result.stdout.includes(CLAUDE_REVIEW_RESULT_END) &&
    !markedResult;
  return {
    status: result.killed
      ? "timeout"
      : result.code !== 0 || invalidMarkedResult
        ? "failed"
        : "review",
    level: options.level,
    contextMessage: options.contextMessage,
    autoFix: options.autoFix,
    capsuleProvenance: options.capsuleProvenance,
    stdout: invalidMarkedResult ? "" : (markedResult?.review ?? result.stdout),
    stderr: result.stderr,
    exitCode: result.code,
    hasFindings: markedResult?.hasFindings,
    cwd,
    errorMessage: invalidMarkedResult
      ? "Claude returned an invalid or placeholder review result"
      : undefined,
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
  return job.managementError?.startsWith("Failed to read Claude logs") ||
    job.managementError === "Timed out while reading Claude logs"
    ? job.lastLog
    : "";
}

function queueAutoFix(pi: ExtensionAPI, details: ClaudeReviewDetails): void {
  pi.sendUserMessage(buildAutoFixPrompt(details), { deliverAs: "followUp" });
}

function handleReviewResult(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  result: ExecResult,
  details: ClaudeReviewDetails,
  autoFix: boolean,
): void {
  if (details.status === "timeout") {
    sendReviewOnly(pi, details);
    ctx.ui.notify("Claude review timed out after 20 minutes", "error");
  } else if (details.status === "failed") {
    sendReviewOnly(pi, details);
    ctx.ui.notify(
      details.errorMessage ?? `Claude review failed with exit code ${result.code}`,
      "error",
    );
  } else if (autoFix && reviewHasFindings(details)) {
    queueAutoFix(pi, details);
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
  await runWithCancellableLoader(
    ctx,
    "Claude review: waiting for Pi to become idle…",
    async (controller, updateStatus) => {
      try {
        if (!(await waitForIdleUnlessAborted(ctx, controller.signal))) {
          ctx.ui.notify("Claude review cancelled", "info");
          return;
        }
        const capsule = await prepareCapsule(options, ctx, controller.signal);
        if (capsule === null) return;
        if (controller.signal.aborted) {
          ctx.ui.notify("Claude review cancelled", "info");
          return;
        }
        const reviewPrompt = buildCodeReviewPrompt(options, { resultMarkers: true, capsule });
        updateStatus(`Claude review: running at ${options.level} effort…`);
        const reviewTools = capsule ? CAPSULE_REVIEW_TOOLS : REVIEW_TOOLS;
        controller.signal.throwIfAborted();
        const result = await pi.exec(
          claudeBinary(),
          claudeArgs(reviewPrompt, options.level, reviewTools),
          {
            cwd: ctx.cwd,
            signal: controller.signal,
            timeout: REVIEW_TIMEOUT_MS,
          },
        );

        const details = toReviewDetails(result, options, ctx.cwd);
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
      }
    },
  );
}

async function handleBackgroundClaudeReviewCommand(
  pi: ExtensionAPI,
  options: ClaudeReviewOptions,
  ctx: ExtensionCommandContext,
): Promise<void> {
  let job: ClaudeReviewJob | undefined;

  await runWithCancellableLoader(
    ctx,
    "Claude review: waiting for Pi to become idle…",
    async (controller, updateStatus) => {
      try {
        if (!(await waitForIdleUnlessAborted(ctx, controller.signal))) {
          ctx.ui.notify("Claude review cancelled", "info");
          return;
        }
        const capsule = await prepareCapsule(options, ctx, controller.signal);
        if (capsule === null) return;
        if (controller.signal.aborted) {
          ctx.ui.notify("Claude review cancelled", "info");
          return;
        }
        const prompt = buildCodeReviewPrompt(options, { resultMarkers: true, capsule });
        job = await createJob({ cwd: ctx.cwd, options, prompt });
        updateStatus(`Claude review: starting background job ${job.id}…`);
        controller.signal.throwIfAborted();
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
          controller.signal.aborted
            ? "Claude review cancelled"
            : `Claude review failed: ${message}`,
          controller.signal.aborted ? "info" : "error",
        );
      }
    },
  );
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
    const sameWorkspace = resolve(withLogs.cwd) === resolve(ctx.cwd);
    const hasActionableReview = details.status === "review" && reviewHasFindings(details);
    const shouldFix = autoFix && sameWorkspace && hasActionableReview;

    sendReviewOnly(pi, details);
    if (shouldFix) {
      queueAutoFix(pi, details);
    } else if (autoFix && !sameWorkspace && hasActionableReview) {
      ctx.ui.notify(
        `Claude review auto-fix refused for job from ${withLogs.cwd}; current workspace is ${ctx.cwd}`,
        "error",
      );
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

type ClaudeReviewToolInput = Static<typeof ClaudeReviewToolParams>;

type ClaudeReviewToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: ClaudeReviewDetails;
};

function assertValidToolInput(input: ClaudeReviewToolInput): void {
  switch (input.action) {
    case "start":
      if (input.jobId || input.all) {
        throw new Error("claude_review start does not accept jobId or all");
      }
      return;
    case "status":
    case "logs":
    case "cancel":
      if (input.level || input.context || input.mode || input.autoFix !== undefined || input.all) {
        throw new Error(`claude_review ${input.action} accepts only jobId`);
      }
      return;
    case "result":
      if (input.level || input.context || input.mode || input.all) {
        throw new Error("claude_review result accepts only jobId and autoFix");
      }
      return;
    case "list":
      if (
        input.level ||
        input.context ||
        input.mode ||
        input.autoFix !== undefined ||
        input.jobId
      ) {
        throw new Error("claude_review list accepts only all");
      }
  }
}

function toToolResult(details: ClaudeReviewDetails, prefix?: string): ClaudeReviewToolResult {
  const rendered = renderClaudeReviewMarkdown(details);
  return {
    content: [{ type: "text", text: prefix ? `${prefix}\n\n${rendered}` : rendered }],
    details,
  };
}

async function startClaudeReviewFromTool(
  pi: ExtensionAPI,
  input: ClaudeReviewToolInput,
  signal: AbortSignal,
  ctx: ExtensionContext,
): Promise<ClaudeReviewToolResult> {
  const options: ClaudeReviewOptions = {
    autoFix: input.autoFix ?? true,
    level: input.level ?? DEFAULT_REVIEW_LEVEL,
    contextMessage: input.context?.trim() ?? "",
    mode: input.mode ?? "background",
  };
  const prompt = buildCodeReviewPrompt(options, { resultMarkers: true });

  if (options.mode === "wait") {
    const result = await pi.exec(claudeBinary(), claudeArgs(prompt, options.level), {
      cwd: ctx.cwd,
      signal,
      timeout: REVIEW_TIMEOUT_MS,
    });
    signal.throwIfAborted();
    const details = toReviewDetails(result, options, ctx.cwd);
    if (options.autoFix && details.status === "review" && reviewHasFindings(details)) {
      queueAutoFix(pi, details);
    }
    return toToolResult(details);
  }

  signal.throwIfAborted();
  let job = await createJob({ cwd: ctx.cwd, options, prompt });
  try {
    signal.throwIfAborted();
    job = await startClaudeBackgroundReview(pi, job, claudeBinary(), REVIEW_TOOLS, signal);
  } catch (error) {
    if (!signal.aborted) throw error;
    job = await writeJob({
      ...job,
      status: "cancelled",
      completedAt: new Date().toISOString(),
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
  return toToolResult(jobToClaudeReviewDetails(job), `Claude review job: ${job.id}`);
}

async function executeClaudeReviewTool(
  pi: ExtensionAPI,
  input: ClaudeReviewToolInput,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<ClaudeReviewToolResult> {
  assertValidToolInput(input);
  const operationSignal = signal ?? new AbortController().signal;
  operationSignal.throwIfAborted();

  if (input.action === "start") {
    return startClaudeReviewFromTool(pi, input, operationSignal, ctx);
  }

  if (input.action === "list") {
    const jobs = await listJobs(input.all ? {} : { cwd: ctx.cwd });
    return toToolResult(buildJobsListDetails(jobs, ctx.cwd, input.all ?? false));
  }

  const job = await resolveJob(input.jobId, ctx.cwd);
  if (input.action === "cancel") {
    const cancelled = await cancelClaudeBackgroundJob(pi, job, claudeBinary());
    return toToolResult(jobToClaudeReviewDetails(cancelled));
  }

  const refreshed = await refreshClaudeBackgroundJob(pi, job, claudeBinary());
  if (input.action === "status") {
    return toToolResult(jobToClaudeReviewDetails(refreshed, refreshed.lastLog || refreshed.stdout));
  }

  const withLogs = refreshed.claudeSessionId
    ? await readClaudeBackgroundLogs(pi, refreshed, claudeBinary())
    : refreshed;
  if (input.action === "logs") {
    return toToolResult(jobToClaudeReviewDetails(withLogs, withLogs.lastLog || withLogs.stdout));
  }

  const output = withLogs.stdout || logReadFailureOutput(withLogs);
  const details = jobToClaudeReviewDetails(withLogs, output);
  const autoFix = input.autoFix ?? withLogs.autoFix;
  const sameWorkspace = resolve(withLogs.cwd) === resolve(ctx.cwd);
  const hasActionableReview = details.status === "review" && reviewHasFindings(details);
  if (autoFix && sameWorkspace && hasActionableReview) {
    queueAutoFix(pi, details);
  }
  const refusal =
    autoFix && !sameWorkspace && hasActionableReview
      ? `Auto-fix refused: job workspace ${withLogs.cwd} differs from current workspace ${ctx.cwd}.`
      : undefined;
  return toToolResult(details, refusal);
}

export default function claudeReviewExtension(pi: ExtensionAPI) {
  pi.registerMessageRenderer<ClaudeReviewDetails>(CLAUDE_REVIEW_MESSAGE_TYPE, (message) => {
    return new Markdown(renderClaudeReviewMarkdown(message.details), 1, 0, getMarkdownTheme());
  });

  pi.registerTool({
    name: "claude_review",
    label: "Claude Review",
    description:
      "Start and manage independent Claude Code reviews. Operations execute directly and sequentially, so a completed start returns the job id needed by later operations.",
    parameters: ClaudeReviewToolParams,
    executionMode: "sequential",
    execute: (_toolCallId, params, signal, _onUpdate, ctx) =>
      executeClaudeReviewTool(pi, params, signal, ctx),
  });

  pi.registerCommand("claude-review", {
    description: "Start a durable independent Claude Code review; use --wait for blocking mode",
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
