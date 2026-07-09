import { execFile, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
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
// Pi acks a prompt only after preflight, which can include a full pre-prompt
// compaction pass (an LLM summarization call) on a large resumed session.
const DEFAULT_PROMPT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_TERMINATE_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_SESSION_BYTES = 1_000_000;
// After an overflow-errored agent_end, Pi starts compact-and-retry; give its
// compaction_start this long to show up before treating the error as final.
const DEFAULT_COMPACTION_GRACE_MS = 15_000;
const DEFAULT_COMPACT_USAGE_PERCENT = 80;
const DEFAULT_CANCEL_POLL_MS = 100;
const TERMINAL_STATUSES = new Set(["cancelled", "completed", "failed"]);
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
  await updateJob(job, { workerPid: child.pid });
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
  const parent = await resolveContinuationParent(selector, options);
  validateContinuationParent(parent.job, selector);
  await assertContinuableSessionSize(parent.job, options);
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
  let events = null;
  let finalText = null;
  let errorMessage = null;
  const cancellation = watchCancellation(client, job, options);
  try {
    events = await promptPi(client, job, brief, options);
    const agentEndEvent = await awaitFinalAgentEnd(client, events, job, options);
    if (await jobIsCancelling(job)) await cancelJob(job, "Pi RPC abort completed");
    else {
      finalText = await getFinalText(client, agentEndEvent);
      await completeJob(job, finalText);
    }
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
    if (await jobIsCancelling(job)) await cancelJob(job, errorMessage);
    else await failJob(job, errorMessage);
  } finally {
    events?.close();
    cancellation.cancel();
  }
  return { errorMessage, finalText };
}

async function awaitFinalAgentEnd(client, events, job, options) {
  const state = { candidate: null, compacting: false };
  while (true) {
    const event = await events.next(nextEventTimeoutMs(state, options));
    if (event === null) {
      if (state.candidate && !state.compacting) return state.candidate;
      throw new Error(client.timeoutMessage("Timed out waiting for Pi RPC agent_end event"));
    }
    const final = await handleAgentEvent(event, state, job);
    if (final) return final;
  }
}

function nextEventTimeoutMs(state, options) {
  if (state.candidate && !state.compacting) {
    return options.compactionGraceMs ?? DEFAULT_COMPACTION_GRACE_MS;
  }
  return options.agentEndTimeoutMs ?? DEFAULT_AGENT_END_TIMEOUT_MS;
}

async function handleAgentEvent(event, state, job) {
  if (event.type === "compaction_start") {
    state.compacting = true;
    await appendJobLog(job, "compaction-start", { reason: event.reason });
    return null;
  }
  if (event.type === "compaction_end") return handleCompactionEnd(event, state, job);
  if (event.willRetry === true) return null;
  if (finalAssistantOutcome(event?.messages ?? []).error) {
    state.candidate = event;
    return null;
  }
  return event;
}

async function handleCompactionEnd(event, state, job) {
  state.compacting = false;
  await appendJobLog(job, "compaction-end", {
    errorMessage: event.errorMessage,
    reason: event.reason,
    willRetry: event.willRetry,
  });
  if (event.willRetry) {
    state.candidate = null;
    return null;
  }
  if (event.errorMessage) throw new Error(`Pi compaction failed: ${event.errorMessage}`);
  return state.candidate;
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
  if (options.parentJob) await compactResumedSessionIfCrowded(client, job, options);
  const events = client.eventQueue(["agent_end", "compaction_start", "compaction_end"]);
  const agentEndWaiter = client.waitForEventHandle("agent_end", {
    predicate: isFinalAgentEndEvent,
    timeoutMs: options.agentEndTimeoutMs ?? DEFAULT_AGENT_END_TIMEOUT_MS,
  });
  try {
    await updateJob(job, { phase: "prompting" });
    await promptAcknowledged(client, brief, agentEndWaiter, options);
    await updateJob(job, { phase: "running" });
    return events;
  } catch (error) {
    events.close();
    throw error;
  } finally {
    agentEndWaiter.cancel();
  }
}

async function compactResumedSessionIfCrowded(client, job, options) {
  const stats = await requestData(client, { type: "get_session_stats" }).catch(async (error) => {
    await appendJobLog(job, "session-stats-failed", { errorMessage: errorMessage(error) });
    return null;
  });
  const percent = stats?.contextUsage?.percent;
  const threshold = options.compactUsagePercent ?? DEFAULT_COMPACT_USAGE_PERCENT;
  if (typeof percent !== "number" || percent < threshold) return;
  await appendJobLog(job, "proactive-compaction", { contextUsage: stats.contextUsage });
  try {
    const result = await requestData(
      client,
      { type: "compact" },
      { timeoutMs: options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS },
    );
    await appendJobLog(job, "proactive-compaction-done", {
      estimatedTokensAfter: result?.estimatedTokensAfter,
      tokensBefore: result?.tokensBefore,
    });
  } catch (error) {
    // Benign failures ("Already compacted", "Nothing to compact") should not
    // block the prompt; real overflows still fail loudly on the prompt path.
    await appendJobLog(job, "proactive-compaction-failed", { errorMessage: errorMessage(error) });
  }
}

async function promptAcknowledged(client, brief, agentEndWaiter, options) {
  const ack = requestOk(
    client,
    { type: "prompt", message: buildImplementationPrompt(brief) },
    { timeoutMs: options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS },
  );
  // An agent_end without a prompt acknowledgement still means Pi ran; let the
  // final-text path report the real outcome instead of failing on the ack.
  ack.catch(() => {});
  await Promise.race([ack, agentEndWaiter.promise]);
}

async function completeJob(job, finalText) {
  await updateJobRecord(job, (current) => {
    if (current.status === "cancelling" || TERMINAL_STATUSES.has(current.status)) return null;
    return {
      status: "completed",
      phase: "completed",
      result: finalText,
      summary: firstNonEmptyLine(finalText),
      testsRun: extractTestEvidence(finalText),
    };
  });
}

async function failJob(job, errorMessage) {
  await updateJobRecord(job, (current) => {
    if (current.status === "cancelling") return cancellationChanges(errorMessage);
    if (TERMINAL_STATUSES.has(current.status)) return null;
    return {
      status: "failed",
      phase: "failed",
      errorMessage,
      summary: `Failed: ${errorMessage}`,
    };
  });
}

async function cancelJob(job, reason) {
  await updateJobRecord(job, (current) =>
    TERMINAL_STATUSES.has(current.status) ? null : cancellationChanges(reason),
  );
}

function cancellationChanges(reason) {
  return {
    status: "cancelled",
    phase: "cancelled",
    cancelledAt: new Date().toISOString(),
    summary: "Cancelled by Claude session request.",
    errorMessage: reason,
  };
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
    options.model ?? options.parentJob?.model ?? process.env.PI_IMPLEMENT_MODEL ?? DEFAULT_INTENDED_MODEL
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

function sessionArgs(parentJob) {
  return parentJob ? ["--session", parentJob.piSessionFile] : [];
}

function modelArgs(model) {
  return model ? ["--model", model] : [];
}

async function requestData(client, command, requestOptions) {
  const response = await requestOk(client, command, requestOptions);
  return response.data;
}

async function requestOk(client, command, requestOptions) {
  const response = await client.request(command, requestOptions);
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

async function assertContinuableSessionSize(job, options) {
  const limit = options.maxSessionBytes ?? DEFAULT_MAX_SESSION_BYTES;
  const size = (await stat(job.piSessionFile).catch(() => null))?.size ?? 0;
  if (size <= limit) return;
  throw new Error(
    `Pi session file for ${job.id} is ${size} bytes, over the ${limit}-byte continuation ` +
      "limit; the session likely no longer fits the model context window. Start a fresh " +
      "/pi:implement job with a summarized brief instead of continuing.",
  );
}

function normalizeInstruction(instruction) {
  const normalized = typeof instruction === "string" ? instruction.trim() : "";
  if (!normalized) throw new Error("Continuation instruction is required");
  return normalized;
}

async function getFinalText(client, agentEndEvent) {
  const response = await requestData(client, { type: "get_last_assistant_text" });
  if (typeof response?.text === "string" && response.text.trim()) return response.text;
  const outcome = finalAssistantOutcome(agentEndEvent?.messages ?? []);
  if (outcome.text) return outcome.text;
  if (outcome.error) throw new Error(`Pi agent error: ${outcome.error}`);
  throw new Error("Pi completed without a final assistant response");
}

function finalAssistantOutcome(messages) {
  for (const message of [...messages].reverse()) {
    if (message?.role !== "assistant") continue;
    const error = assistantErrorMessage(message);
    if (error) return { error };
    const text = extractMessageContentText(message.content);
    if (text) return { text };
  }
  return {};
}

function assistantErrorMessage(message) {
  if (message.stopReason !== "error") return null;
  const error = typeof message.errorMessage === "string" ? message.errorMessage.trim() : "";
  return error || null;
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
