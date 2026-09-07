import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  createContinuationJob,
  createImplementationJob,
  completeJob,
  failJob,
  cancelJob,
  appendJobLog,
  findResumableImplementationJob,
  persistJob,
  readJob,
  updateJobRecord,
} from "./jobs.mjs";
import { PiRpcClient } from "./pi-rpc-client.mjs";
import { terminateProcessTree } from "./process-tree.mjs";
import { DEFAULT_INTENDED_MODEL, DEFAULT_THINKING_LEVEL, modelRef } from "./setup.mjs";

const WRITE_CAPABLE_TOOLS = "read,grep,find,ls,bash,edit,write";
const DEFAULT_AGENT_END_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_TERMINATE_TIMEOUT_MS = 10_000;
const DEFAULT_CANCEL_POLL_MS = 100;
const THINKING_LEVEL_SUFFIX = /:(?:off|minimal|low|medium|high|xhigh|max)$/;
const execFileAsync = promisify(execFile);

export async function startBackgroundImplement(options = {}) {
  const brief = normalizeBrief(options.brief);
  const model = selectedModel(options);
  const job = createImplementationJob({
    ...options,
    brief,
    model,
    ownerClaudeSessionId: ownerClaudeSessionId(options),
    phase: "queued",
    requestedModel: model,
    status: "queued",
  });
  await persistJob(job);
  await appendJobLog(job, "queued", { briefLength: brief.length, model });
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("../pi-companion.mjs", import.meta.url)),
      "implement",
      "--worker",
      "--job-file",
      job.jobFile,
    ],
    {
      detached: true,
      env: implementWorkerEnv(model),
      stdio: "ignore",
    },
  );
  child.unref();
  await updateJobRecord(job, { workerPid: child.pid });
  return { ok: true, jobFile: job.jobFile, jobId: job.id, report: renderBackgroundReport(job) };
}

export async function runImplementWorker(options = {}) {
  const job = await readJob(options.jobFile);
  const model = options.model ?? job.requestedModel ?? job.model;
  return runImplement({ ...options, brief: jobBrief(job), job, model });
}

export async function runImplement(options = {}) {
  const brief = normalizeBrief(options.brief);
  const model = selectedModel(options);
  const job =
    options.job ??
    createImplementationJob({
      ...options,
      brief,
      model,
      ownerClaudeSessionId: ownerClaudeSessionId(options),
      requestedModel: model,
    });
  return runJobWithPi(job, brief, { ...options, model });
}

export async function runContinue(selector = "latest", options = {}) {
  const instruction = normalizeInstruction(options.instruction);
  const parent = await findResumableImplementationJob(selector, options);
  validateContinuationParent(parent.job, selector);
  const model = selectedModel({ ...options, parentJob: parent.job });
  const job = createContinuationJob(parent.job, {
    ...options,
    model,
    ownerClaudeSessionId: ownerClaudeSessionId(options),
    requestedModel: model,
  });
  return runJobWithPi(job, instruction, { ...options, model, parentJob: parent.job });
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
  await updateJobRecord(job, {
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
    if (await jobIsCancelling(job)) await cancelJob(job, "Pi RPC abort completed");
    else {
      finalText = await client.getFinalText(agentEndEvent);
      await completeJob(job, finalText, extractTestEvidence(finalText));
    }
  } catch (error) {
    agentEndWaiter?.cancel();
    errorMessage = error instanceof Error ? error.message : String(error);
    if (await jobIsCancelling(job)) await cancelJob(job, errorMessage);
    else await failJob(job, errorMessage);
  } finally {
    cancellation.cancel();
  }
  return { errorMessage, finalText };
}

async function promptPi(client, job, brief, options) {
  const state = await client.requestData({ type: "get_state" });
  await updateJobRecord(job, { piPid: client.process?.pid });
  await updateJobFromState(job, state);
  await appendJobLog(job, "state", {
    model: job.model,
    sessionId: job.sessionId,
    piSessionFile: job.piSessionFile,
  });
  const agentEndWaiter = client.waitForEventHandle("agent_end", {
    predicate: (event) => event?.willRetry !== true,
    timeoutMs: options.agentEndTimeoutMs ?? DEFAULT_AGENT_END_TIMEOUT_MS,
  });
  try {
    await updateJobRecord(job, { phase: "prompting" });
    await client.requestData({ type: "prompt", message: buildImplementationPrompt(brief) });
    await updateJobRecord(job, { phase: "running" });
    return agentEndWaiter;
  } catch (error) {
    agentEndWaiter.cancel();
    throw error;
  }
}

async function finishJob(job, piTerminated) {
  const changedFiles = await detectChangedFiles(job.workspaceRoot);
  await updateJobRecord(job, {
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

function jobBrief(job) {
  if (typeof job.brief === "string" && job.brief.trim()) return job.brief;
  return process.env.PI_IMPLEMENT_BRIEF;
}

function implementWorkerEnv(model) {
  const env = { ...process.env, PI_IMPLEMENT_MODEL: model };
  delete env.PI_IMPLEMENT_BRIEF;
  return env;
}

function selectedModel(options) {
  return (
    options.model ??
    options.parentJob?.model ??
    process.env.PI_IMPLEMENT_MODEL ??
    DEFAULT_INTENDED_MODEL
  );
}

function ownerClaudeSessionId(options) {
  return (
    options.ownerClaudeSessionId ??
    process.env.CLAUDE_CODE_SESSION_ID ??
    process.env.CLAUDE_SESSION_ID
  );
}

function watchCancellation(client, job, options) {
  let stopped = false;
  let aborting = false;
  let killTimer = null;
  const timer = setInterval(async () => {
    if (stopped || aborting || job.status === "cancelled") return;
    aborting = true;
    try {
      const latest = await readJob(job.jobFile).catch(() => null);
      if (latest?.status !== "cancelling") {
        aborting = false;
        return;
      }
      await updateJobRecord(job, (current) =>
        current.status === "cancelling" ? { status: "cancelling", phase: "aborting" } : null,
      );
      if (job.status !== "cancelling") {
        aborting = false;
        return;
      }
      await appendJobLog(job, "abort-requested", { piPid: job.piPid });
      void client.abort().catch(async (error) => {
        aborting = false;
        await appendJobLog(job, "abort-failed", { errorMessage: errorMessage(error) }).catch(
          () => {},
        );
      });
      killTimer = setTimeout(() => {
        killTimer = null;
        void terminateCancellationProcess(job);
      }, options.cancelKillTimeoutMs ?? 1_000);
    } catch (error) {
      aborting = false;
      await appendJobLog(job, "abort-watch-failed", { errorMessage: errorMessage(error) }).catch(
        () => {},
      );
    }
  }, options.cancelPollMs ?? DEFAULT_CANCEL_POLL_MS);
  return {
    cancel: () => {
      stopped = true;
      clearInterval(timer);
      if (killTimer) clearTimeout(killTimer);
    },
  };
}

async function jobIsCancelling(job) {
  const latest = await readJob(job.jobFile).catch(() => job);
  return latest.status === "cancelling";
}

async function terminateCancellationProcess(job) {
  const latest = await readJob(job.jobFile).catch(() => null);
  if (latest?.status !== "cancelling") return;
  await appendJobLog(job, "abort-timeout-kill", { piPid: latest.piPid });
  await terminateProcessTree(latest.piPid, { timeoutMs: 500 });
}

function buildPiArgs(job, options) {
  const model = selectedModel(options);
  return [
    ...(options.piPrefixArgs ?? []),
    "--mode",
    "rpc",
    ...(model ? ["--model", model] : []),
    ...thinkingArgs(model, options),
    "--session-dir",
    job.sessionRoot,
    ...(options.parentJob ? ["--session", options.parentJob.piSessionFile] : []),
    "--no-extensions",
    "--no-prompt-templates",
    "--no-skills",
    "--tools",
    WRITE_CAPABLE_TOOLS,
  ];
}

function thinkingArgs(model, options) {
  const configuredLevel = options.thinkingLevel ?? process.env.PI_IMPLEMENT_THINKING_LEVEL;
  if (configuredLevel !== undefined) return ["--thinking", configuredLevel];
  if (THINKING_LEVEL_SUFFIX.test(model ?? "")) return [];
  return ["--thinking", DEFAULT_THINKING_LEVEL];
}

async function updateJobFromState(job, state) {
  await updateJobRecord(job, {
    phase: "delegating",
    sessionId: state?.sessionId,
    piSessionFile: state?.sessionFile,
    model: modelRef(state?.model),
  });
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

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
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
    `Model: ${job.model ?? "unknown"}`,
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
