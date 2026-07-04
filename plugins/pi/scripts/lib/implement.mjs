import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import {
  createContinuationJob,
  createImplementationJob,
  appendJobLog,
  findResumableImplementationJob,
  persistJob,
  readJob,
  updateJobRecord,
} from "./jobs.mjs";
import { PiRpcClient } from "./pi-rpc-client.mjs";
import { terminateProcessTree } from "./process-tree.mjs";
import { DEFAULT_INTENDED_MODEL, modelRef } from "./setup.mjs";

const WRITE_CAPABLE_TOOLS = "read,grep,find,ls,bash,edit,write";
const DEFAULT_AGENT_END_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_TERMINATE_TIMEOUT_MS = 10_000;
const DEFAULT_CANCEL_POLL_MS = 100;
const execFileAsync = promisify(execFile);

export async function startBackgroundImplement(options = {}) {
  const brief = normalizeBrief(options.brief);
  const job = createImplementationJob({ ...options, status: "queued", phase: "queued" });
  await persistJob(job);
  await appendJobLog(job, "queued", {
    briefLength: brief.length,
    model: options.model ?? process.env.PI_IMPLEMENT_MODEL ?? DEFAULT_INTENDED_MODEL,
  });
  const child = spawn(
    process.execPath,
    [
      new URL("../pi-companion.mjs", import.meta.url).pathname,
      "implement",
      "--worker",
      "--job-file",
      job.jobFile,
    ],
    { detached: true, env: { ...process.env, PI_IMPLEMENT_BRIEF: brief }, stdio: "ignore" },
  );
  child.unref();
  await updateJob(job, { workerPid: child.pid });
  return { ok: true, jobFile: job.jobFile, jobId: job.id, report: renderBackgroundReport(job) };
}

export async function runImplementWorker(options = {}) {
  const job = await readJob(options.jobFile);
  return runImplement({ ...options, brief: process.env.PI_IMPLEMENT_BRIEF, job });
}

export async function runImplement(options = {}) {
  const brief = normalizeBrief(options.brief);
  const job = options.job ?? createImplementationJob(options);
  return runJobWithPi(job, brief, options);
}

export async function runContinue(selector = "latest", options = {}) {
  const instruction = normalizeInstruction(options.instruction);
  const parent = await resolveContinuationParent(selector, options);
  validateContinuationParent(parent.job, selector);
  const job = createContinuationJob(parent.job, options);
  return runJobWithPi(job, instruction, { ...options, parentJob: parent.job });
}

async function runJobWithPi(job, brief, options) {
  await startJob(job, brief, options);
  const client = new PiRpcClient({
    command: options.piCommand ?? process.env.PI_CLI ?? "pi",
    args: buildPiArgs(job, options),
    stderrMaxBytes: options.stderrMaxBytes,
    timeoutMs: options.timeoutMs,
    detached: true,
  });

  const outcome = await executeImplementation(client, job, brief, options);
  const piTerminated = await client.terminate(
    options.terminateTimeoutMs ?? DEFAULT_TERMINATE_TIMEOUT_MS,
  );
  await finishJob(job, piTerminated);
  const ok = job.status === "completed";
  return buildImplementResult({ client, ...outcome, job, ok, piTerminated });
}

async function startJob(job, brief, options) {
  const initialChanges = await detectChangedFiles(job.workspaceRoot);
  await updateJob(job, {
    status: "running",
    phase: "starting",
    initialChangedFiles: initialChanges.files,
    workerPid: process.pid,
  });
  await appendJobLog(job, "started", {
    briefLength: brief.length,
    changedFilesError: initialChanges.errorMessage,
    initialChangedFileCount: initialChanges.files.length,
    model: selectedModel(options),
    parentJobId: options.parentJob?.id,
  });
}

async function executeImplementation(client, job, brief, options) {
  let agentEndWaiter = null;
  let finalText = null;
  let errorMessage = null;
  const cancellation = watchCancellation(client, job, options);
  try {
    agentEndWaiter = await promptPi(client, job, brief, options);
    const agentEndEvent = await agentEndWaiter.promise;
    if (job.status === "cancelling") await cancelJob(job, "Pi RPC abort completed");
    else {
      finalText = await getFinalText(client, agentEndEvent);
      await completeJob(job, finalText);
    }
  } catch (error) {
    agentEndWaiter?.cancel();
    errorMessage = error instanceof Error ? error.message : String(error);
    if (job.status === "cancelling") await cancelJob(job, errorMessage);
    else await failJob(job, errorMessage);
  } finally {
    cancellation.cancel();
  }
  return { errorMessage, finalText };
}

async function promptPi(client, job, brief, options) {
  const state = await requestData(client, { type: "get_state" });
  await updateJob(job, { piPid: client.process?.pid });
  await updateJobFromState(job, state);
  await appendJobLog(job, "state", {
    model: job.model,
    sessionId: job.sessionId,
    piSessionFile: job.piSessionFile,
  });
  const agentEndWaiter = client.waitForEventHandle("agent_end", {
    predicate: isFinalAgentEndEvent,
    timeoutMs: options.agentEndTimeoutMs ?? DEFAULT_AGENT_END_TIMEOUT_MS,
  });
  try {
    await updateJob(job, { phase: "prompting" });
    await requestOk(client, { type: "prompt", message: buildImplementationPrompt(brief) });
    await updateJob(job, { phase: "running" });
    return agentEndWaiter;
  } catch (error) {
    agentEndWaiter.cancel();
    throw error;
  }
}

async function completeJob(job, finalText) {
  await updateJob(job, {
    status: "completed",
    phase: "completed",
    result: finalText,
    summary: firstNonEmptyLine(finalText),
    testsRun: extractTestEvidence(finalText),
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

async function cancelJob(job, reason) {
  await updateJob(job, {
    status: "cancelled",
    phase: "cancelled",
    cancelledAt: new Date().toISOString(),
    summary: "Cancelled by Claude session request.",
    errorMessage: reason,
  });
}

async function finishJob(job, piTerminated) {
  const changedFiles = await detectChangedFiles(job.workspaceRoot);
  await updateJob(job, {
    changedFiles: changedFilesDelta(changedFiles.files, job.initialChangedFiles),
    completedAt: new Date().toISOString(),
  });
  await appendJobLog(job, "finished", {
    status: job.status,
    changedFileCount: job.changedFiles.length,
    changedFilesError: changedFiles.errorMessage,
    piTerminated,
  });
}

function normalizeBrief(brief) {
  const normalized = typeof brief === "string" ? brief.trim() : "";
  if (!normalized) throw new Error("Implementation brief is required");
  return normalized;
}

function watchCancellation(client, job, options) {
  let stopped = false;
  let aborting = false;
  const timer = setInterval(async () => {
    if (stopped || aborting || job.status === "cancelled") return;
    const latest = await readJob(job.jobFile).catch(() => null);
    if (latest?.status !== "cancelling") return;
    aborting = true;
    await updateJob(job, { status: "cancelling", phase: "aborting" });
    await appendJobLog(job, "abort-requested", { piPid: job.piPid });
    client.abort().catch((error) =>
      appendJobLog(job, "abort-failed", {
        errorMessage: error instanceof Error ? error.message : String(error),
      }),
    );
    setTimeout(() => terminateCancellationProcess(job), options.cancelKillTimeoutMs ?? 1_000);
  }, options.cancelPollMs ?? DEFAULT_CANCEL_POLL_MS);
  return {
    cancel: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

async function terminateCancellationProcess(job) {
  const latest = await readJob(job.jobFile).catch(() => null);
  if (latest?.status !== "cancelling") return;
  await appendJobLog(job, "abort-timeout-kill", { piPid: latest.piPid });
  await terminateProcessTree(latest.piPid, { timeoutMs: 500 });
}

function buildPiArgs(job, options) {
  return [
    ...(options.piPrefixArgs ?? []),
    "--mode",
    "rpc",
    ...modelArgs(selectedModel(options)),
    "--session-dir",
    job.sessionRoot,
    ...sessionArgs(options.parentJob),
    "--no-extensions",
    "--no-prompt-templates",
    "--no-skills",
    "--tools",
    WRITE_CAPABLE_TOOLS,
  ];
}

function selectedModel(options) {
  return (
    options.model ?? options.parentJob?.model ?? process.env.PI_IMPLEMENT_MODEL ?? DEFAULT_INTENDED_MODEL
  );
}

function sessionArgs(parentJob) {
  return parentJob ? ["--session", parentJob.piSessionFile] : [];
}

function modelArgs(model) {
  return model ? ["--model", model] : [];
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

function isFinalAgentEndEvent(event) {
  return event?.willRetry !== true;
}

function buildImplementationPrompt(brief) {
  return [
    "You are the Pi implementation delegate for Claude Code.",
    "Implement the following brief, edit files as needed, and run relevant tests.",
    "Return a concise implementation report with files changed and tests run.",
    "",
    "Implementation brief:",
    brief?.trim() ?? "",
  ].join("\n");
}

async function resolveContinuationParent(selector, options) {
  return findResumableImplementationJob(selector, options);
}

function validateContinuationParent(job, selector) {
  if (!job) throw new Error(`No resumable implementation job found for selector: ${selector}`);
  if (typeof job.piSessionFile !== "string" || !job.piSessionFile.trim()) {
    throw new Error(`Implementation job ${job.id} has no usable Pi session file metadata`);
  }
  if (typeof job.sessionId !== "string" || !job.sessionId.trim()) {
    throw new Error(`Implementation job ${job.id} has no usable Pi session id metadata`);
  }
}

function normalizeInstruction(instruction) {
  const normalized = typeof instruction === "string" ? instruction.trim() : "";
  if (!normalized) throw new Error("Continuation instruction is required");
  return normalized;
}

async function getFinalText(client, agentEndEvent) {
  const response = await requestData(client, { type: "get_last_assistant_text" });
  if (typeof response?.text === "string" && response.text.trim()) return response.text;
  const fallback = extractLastAssistantText(agentEndEvent?.messages ?? []);
  if (fallback) return fallback;
  throw new Error("Pi completed without a final assistant response");
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

function extractTestEvidence(text) {
  const evidence = [];
  for (const line of text.split("\n")) {
    const match = line.match(/(?:^|[.;])\s*(?:[-*+]\s*)?Tests?(?: run)?:\s*(.+)$/i);
    if (match?.[1]) evidence.push(testEvidenceFromText(match[1]));
  }
  return evidence;
}

function testEvidenceFromText(text) {
  const command = text.trim().replace(/[.]$/, "");
  if (/not run|not-run|skipped/i.test(command)) return { command, status: "not-run" };
  if (/fail/i.test(command)) return { command, status: "failed" };
  if (/pass/i.test(command)) return { command, status: "passed" };
  return { command, status: "reported" };
}

async function updateJob(job, changes) {
  await updateJobRecord(job, changes);
}

async function detectChangedFiles(workspaceRoot) {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--short"], {
      cwd: workspaceRoot,
      maxBuffer: 1024 * 1024,
    });
    return { files: parseGitStatus(stdout) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { errorMessage: `git status failed in ${workspaceRoot}: ${message}`, files: [] };
  }
}

function parseGitStatus(output) {
  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .map((path) => path.split(" -> ").pop())
    .filter(Boolean);
}

function changedFilesDelta(files, initialFiles = []) {
  const initial = new Set(initialFiles);
  return files.filter((file) => !initial.has(file));
}

function buildImplementResult(input) {
  return {
    ok: input.ok,
    errorMessage: input.errorMessage,
    finalText: input.finalText,
    jobFile: input.job.jobFile,
    jobId: input.job.id,
    piTerminated: input.piTerminated,
    report: renderImplementReport(input),
    stderr: input.client.stderr,
  };
}

function renderBackgroundReport(job) {
  return [
    "# Pi implementation started",
    "Status: queued",
    `Job: ${job.id}`,
    `Ledger: ${job.jobFile}`,
    "",
    `Follow up: /pi:status or /pi:result ${job.id}`,
    `Cancel: /pi:cancel ${job.id}`,
  ].join("\n");
}

function renderImplementReport({ errorMessage, finalText, job, ok, piTerminated }) {
  return [
    "# Pi implementation result",
    `Status: ${ok ? "completed" : "failed"}`,
    `Job: ${job.id}`,
    ...(job.parentJobId ? [`Parent job: ${job.parentJobId}`] : []),
    ...(job.rootJobId ? [`Root job: ${job.rootJobId}`] : []),
    `Model: ${job.model ?? "unknown"}`,
    `Session: ${job.sessionId ?? "unknown"}`,
    `Session file: ${job.piSessionFile ?? "unknown"}`,
    `Pi RPC termination: ${piTerminated ? "ok" : "failed"}`,
    "",
    ok ? finalText : `Error: ${errorMessage}`,
  ].join("\n");
}
