import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { appendJobLog, createReviewJob, persistJob } from "./jobs.mjs";
import { PiRpcClient } from "./pi-rpc-client.mjs";
import { DEFAULT_INTENDED_MODEL, modelRef } from "./setup.mjs";

export const READ_ONLY_TOOLS = "read,grep,find,ls";
const DEFAULT_AGENT_END_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_TERMINATE_TIMEOUT_MS = 10_000;
const DEFAULT_CONTEXT_LIMITS = {
  maxFileBytes: 32_000,
  maxTotalBytes: 180_000,
  maxStatusBytes: 20_000,
};
const execFileAsync = promisify(execFile);

export async function runReview(options = {}) {
  const mode = options.mode ?? "review";
  const extraContext = normalizeText(options.context);
  const target = normalizeText(options.target);
  const job = createReviewJob(options);
  await startReviewJob(job, { extraContext, mode, target });
  let gitContext;
  try {
    gitContext = await collectGitContext(job.workspaceRoot, { ...options, target });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await failJob(job, errorMessage);
    await finishReviewJob(job, { files: [], notes: [] }, null);
    throw error;
  }
  const client = new PiRpcClient({
    command: options.piCommand ?? process.env.PI_CLI ?? "pi",
    args: buildReviewPiArgs(job, options),
    stderrMaxBytes: options.stderrMaxBytes,
    timeoutMs: options.timeoutMs,
  });

  const outcome = await executeReview(client, job, gitContext, { ...options, extraContext, mode });
  const piTerminated = await client.terminate(
    options.terminateTimeoutMs ?? DEFAULT_TERMINATE_TIMEOUT_MS,
  );
  await finishReviewJob(job, gitContext, piTerminated);
  return buildReviewResult({ client, ...outcome, gitContext, job, piTerminated });
}

export async function collectGitContext(workspaceRoot, options = {}) {
  const limits = { ...DEFAULT_CONTEXT_LIMITS, ...(options.limits ?? {}) };
  const notes = [];
  const status = await git(workspaceRoot, ["status", "--short", "--untracked-files=all"]);
  const ignored = await git(workspaceRoot, ["status", "--ignored", "--short"], {
    allowFailure: true,
  });
  const files = parseStatusFiles(status.stdout);
  addIgnoredNote(ignored.stdout, notes);
  const sections = [
    section(
      "git status --short --untracked-files=all",
      capText(status.stdout, limits.maxStatusBytes, notes),
    ),
  ];
  if (options.target) {
    sections.push(await targetDiffSection(workspaceRoot, options.target, limits, notes));
  } else {
    sections.push(...(await workingTreeSections(workspaceRoot, files, limits, notes)));
  }
  return capContext({ files, notes, status: status.stdout, text: sections.join("\n\n") }, limits);
}

export function buildReviewPiArgs(job, options = {}) {
  return [
    ...(options.piPrefixArgs ?? []),
    "--mode",
    "rpc",
    ...modelArgs(options.model ?? process.env.PI_REVIEW_MODEL ?? DEFAULT_INTENDED_MODEL),
    "--session-dir",
    job.sessionRoot,
    "--no-session",
    "--no-extensions",
    "--no-prompt-templates",
    "--no-skills",
    "--no-context-files",
    "--no-approve",
    "--tools",
    READ_ONLY_TOOLS,
  ];
}

async function startReviewJob(job, details) {
  await updateJob(job, { mode: details.mode, phase: "collecting", target: details.target });
  await appendJobLog(job, "started", details);
}

async function executeReview(client, job, gitContext, options) {
  let agentEndWaiter = null;
  let finalText = null;
  let errorMessage = null;
  try {
    agentEndWaiter = await promptPiForReview(client, job, gitContext, options);
    const agentEndEvent = await agentEndWaiter.promise;
    finalText = await getFinalText(client, agentEndEvent);
    await completeJob(job, finalText);
  } catch (error) {
    agentEndWaiter?.cancel();
    errorMessage = error instanceof Error ? error.message : String(error);
    await failJob(job, errorMessage);
  }
  return { errorMessage, finalText, ok: !errorMessage };
}

async function promptPiForReview(client, job, gitContext, options) {
  const state = await requestData(client, { type: "get_state" });
  await updateJobFromState(job, state);
  const waiter = client.waitForEventHandle("agent_end", {
    predicate: (event) => event?.willRetry !== true,
    timeoutMs: options.agentEndTimeoutMs ?? DEFAULT_AGENT_END_TIMEOUT_MS,
  });
  try {
    await updateJob(job, { phase: "prompting" });
    await requestOk(client, { type: "prompt", message: buildReviewPrompt(gitContext, options) });
    await updateJob(job, { phase: "running" });
    return waiter;
  } catch (error) {
    waiter.cancel();
    throw error;
  }
}

function buildReviewPrompt(gitContext, options) {
  const focus = options.mode === "adversarial" ? adversarialFocus() : normalFocus();
  return [
    "You are an ephemeral read-only Pi review delegate for Claude Code.",
    "Review only the supplied git context. Do not modify files or run shell commands.",
    focus,
    options.extraContext ? `Additional user context:\n${options.extraContext}` : "",
    "Git context collected outside Pi:",
    gitContext.text,
    gitContext.notes.length > 0 ? `Truncation/skips:\n${gitContext.notes.join("\n")}` : "",
    "Return concise, actionable findings with file/line references when possible.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function normalFocus() {
  return "Find correctness, safety, test, and maintainability issues in the proposed changes.";
}

function adversarialFocus() {
  return [
    "Take an adversarial review stance.",
    "Explicitly examine assumptions, design tradeoffs, failure modes, simpler alternatives,",
    "race conditions, rollback risk, and data-loss risk.",
  ].join(" ");
}

async function workingTreeSections(workspaceRoot, files, limits, notes) {
  const sections = [];
  for (const file of files) {
    if (wouldExceedTotal(sections, limits)) break;
    if (file.untracked) {
      sections.push(await untrackedSection(workspaceRoot, file.path, limits, notes));
    } else {
      sections.push(await trackedDiffSection(workspaceRoot, file.path, limits, notes));
    }
  }
  return sections.filter(Boolean);
}

async function trackedDiffSection(workspaceRoot, path, limits, notes) {
  const staged = await git(workspaceRoot, ["diff", "--cached", "--", path]);
  const unstaged = await git(workspaceRoot, ["diff", "--", path]);
  const text = [staged.stdout, unstaged.stdout].filter(Boolean).join("\n");
  if (!text.trim()) return "";
  return section(`diff for ${path}`, capFile(path, text, limits, notes));
}

async function untrackedSection(workspaceRoot, path, limits, notes) {
  if (looksSecret(path)) {
    notes.push(`- skipped likely-secret untracked file: ${path}`);
    return "";
  }
  const content = await git(workspaceRoot, ["show", `:${path}`]).catch(() => null);
  if (!content?.stdout) {
    const read = await readUntrackedWithGit(workspaceRoot, path);
    if (!read) return "";
    return section(`untracked file ${path}`, capFile(path, read, limits, notes));
  }
  return section(`untracked file ${path}`, capFile(path, content.stdout, limits, notes));
}

async function readUntrackedWithGit(workspaceRoot, path) {
  const result = await git(workspaceRoot, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
    path,
  ]);
  return result.stdout.trim() === path ? await safeGitCat(workspaceRoot, path) : "";
}

async function safeGitCat(workspaceRoot, path) {
  const result = await git(workspaceRoot, ["diff", "--no-index", "--", "/dev/null", path], {
    allowFailure: true,
  });
  if (result.stdout.includes("Binary files")) return "";
  return result.stdout;
}

async function targetDiffSection(workspaceRoot, target, limits, notes) {
  const result = await git(workspaceRoot, ["diff", `${target}...HEAD`], { allowFailure: false });
  return section(
    `git diff ${target}...HEAD`,
    capTargetDiff(`${target}...HEAD`, result.stdout, limits, notes),
  );
}

async function git(cwd, args, options = {}) {
  try {
    return await execFileAsync("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  } catch (error) {
    if (options.allowFailure) return { stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
    throw error;
  }
}

function parseStatusFiles(output) {
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => ({
      path: line.slice(3).trim().split(" -> ").pop(),
      untracked: line.startsWith("??"),
    }))
    .filter((file) => file.path);
}

function addIgnoredNote(output, notes) {
  const count = output.split("\n").filter((line) => line.startsWith("!!")).length;
  if (count > 0) notes.push(`- ignored files were detected and omitted: ${count}`);
}

function capContext(context, limits) {
  if (Buffer.byteLength(context.text) <= limits.maxTotalBytes) return context;
  context.notes.push(`- total git context truncated to ${limits.maxTotalBytes} bytes`);
  return { ...context, text: truncateBytes(context.text, limits.maxTotalBytes) };
}

function capText(text, maxBytes, notes) {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  notes.push(`- git status truncated to ${maxBytes} bytes`);
  return truncateBytes(text, maxBytes);
}

function capFile(path, text, limits, notes) {
  if (Buffer.byteLength(text) <= limits.maxFileBytes) return text;
  notes.push(`- ${path} truncated to ${limits.maxFileBytes} bytes`);
  return truncateBytes(text, limits.maxFileBytes);
}

function capTargetDiff(label, text, limits, notes) {
  if (Buffer.byteLength(text) <= limits.maxTotalBytes) return text;
  notes.push(`- target diff ${label} truncated to ${limits.maxTotalBytes} bytes`);
  return truncateBytes(text, limits.maxTotalBytes);
}

function truncateBytes(text, maxBytes) {
  const buffer = Buffer.from(text);
  return `${buffer.subarray(0, maxBytes).toString("utf8")}\n[... truncated ...]`;
}

function looksSecret(path) {
  const name = path.toLowerCase();
  return /(^|\/)(\.env|.*secret.*|.*credential.*|.*token.*|.*key)(\.|$)/.test(name);
}

function wouldExceedTotal(sections, limits) {
  return Buffer.byteLength(sections.join("\n\n")) > limits.maxTotalBytes;
}

function section(title, body) {
  return [`## ${title}`, body || "(empty)"].join("\n");
}

function modelArgs(model) {
  return model ? ["--model", model] : [];
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

async function requestData(client, command) {
  const response = await requestOk(client, command);
  return response.data;
}

async function requestOk(client, command) {
  const response = await client.request(command);
  if (response.success) return response;
  throw new Error(`Pi RPC ${command.type} failed: ${response.error ?? "unknown error"}`);
}

async function updateJobFromState(job, state) {
  await updateJob(job, {
    phase: "delegating",
    sessionId: state?.sessionId,
    piSessionFile: state?.sessionFile,
    model: modelRef(state?.model),
  });
}

async function completeJob(job, finalText) {
  await updateJob(job, {
    status: "completed",
    phase: "completed",
    result: finalText,
    summary: firstNonEmptyLine(finalText),
  });
}

async function failJob(job, errorMessage) {
  await updateJob(job, {
    status: "failed",
    phase: "failed",
    errorMessage,
    summary: `Failed: ${errorMessage}`,
  });
}

async function finishReviewJob(job, gitContext, piTerminated) {
  await updateJob(job, {
    changedFiles: gitContext.files.map((file) => file.path),
    completedAt: new Date().toISOString(),
  });
  await appendJobLog(job, "finished", { status: job.status, piTerminated });
}

async function getFinalText(client, agentEndEvent) {
  const response = await requestData(client, { type: "get_last_assistant_text" });
  if (typeof response?.text === "string" && response.text.trim()) return response.text;
  const fallback = extractLastAssistantText(agentEndEvent?.messages ?? []);
  if (fallback) return fallback;
  throw new Error("Pi review completed without a final assistant response");
}

function extractLastAssistantText(messages) {
  for (const message of [...messages].reverse()) {
    if (message?.role !== "assistant") continue;
    const text = extractMessageContentText(message.content);
    if (text) return text;
  }
  return null;
}

function extractMessageContentText(content) {
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
  return text || null;
}

function firstNonEmptyLine(text) {
  return (
    text
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ?? ""
  );
}

async function updateJob(job, changes) {
  Object.assign(job, changes, { updatedAt: new Date().toISOString() });
  await persistJob(job);
}

function buildReviewResult(input) {
  return {
    ok: input.ok,
    errorMessage: input.errorMessage,
    finalText: input.finalText,
    jobFile: input.job.jobFile,
    jobId: input.job.id,
    piTerminated: input.piTerminated,
    report: renderReviewReport(input),
    stderr: input.client.stderr,
  };
}

function renderReviewReport({ errorMessage, finalText, gitContext, job, ok, piTerminated }) {
  return [
    "# Pi review result",
    `Status: ${ok ? "completed" : "failed"}`,
    `Job: ${job.id}`,
    `Mode: ${job.mode ?? "review"}`,
    `Target: ${job.target || "working tree"}`,
    `Model: ${job.model ?? "unknown"}`,
    `Session: ${job.sessionId ?? "unknown"}`,
    `Session file: ${job.piSessionFile ?? "unknown"}`,
    `Pi RPC termination: ${piTerminated ? "ok" : "failed"}`,
    ...gitContext.notes.map((note) => `Note: ${note}`),
    "",
    ok ? finalText : `Error: ${errorMessage}`,
  ].join("\n");
}
