import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createImplementationJob, appendJobLog, persistJob } from "./jobs.mjs";
import { PiRpcClient } from "./pi-rpc-client.mjs";
import { DEFAULT_INTENDED_MODEL, modelRef } from "./setup.mjs";

const WRITE_CAPABLE_TOOLS = "read,grep,find,ls,bash,edit,write";
const DEFAULT_AGENT_END_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_TERMINATE_TIMEOUT_MS = 10_000;
const execFileAsync = promisify(execFile);

export async function runImplement(options = {}) {
  const brief = normalizeBrief(options.brief);
  const job = createImplementationJob(options);
  await startJob(job, brief, options);
  const client = new PiRpcClient({
    command: options.piCommand ?? process.env.PI_CLI ?? "pi",
    args: buildPiArgs(job, options),
    stderrMaxBytes: options.stderrMaxBytes,
    timeoutMs: options.timeoutMs,
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
  await updateJob(job, { phase: "starting" });
  await appendJobLog(job, "started", {
    briefLength: brief.length,
    model: options.model ?? process.env.PI_IMPLEMENT_MODEL ?? DEFAULT_INTENDED_MODEL,
  });
}

async function executeImplementation(client, job, brief, options) {
  let agentEndWaiter = null;
  let finalText = null;
  let errorMessage = null;
  try {
    agentEndWaiter = await promptPi(client, job, brief, options);
    const agentEndEvent = await agentEndWaiter.promise;
    finalText = await getFinalText(client, agentEndEvent);
    await completeJob(job, finalText);
  } catch (error) {
    agentEndWaiter?.cancel();
    errorMessage = error instanceof Error ? error.message : String(error);
    await failJob(job, errorMessage);
  }
  return { errorMessage, finalText };
}

async function promptPi(client, job, brief, options) {
  const state = await requestData(client, { type: "get_state" });
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

async function finishJob(job, piTerminated) {
  const changedFiles = await detectChangedFiles(job.workspaceRoot);
  await updateJob(job, {
    changedFiles: changedFiles.files,
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

function buildPiArgs(job, options) {
  return [
    ...(options.piPrefixArgs ?? []),
    "--mode",
    "rpc",
    ...modelArgs(options.model ?? process.env.PI_IMPLEMENT_MODEL ?? DEFAULT_INTENDED_MODEL),
    "--session-dir",
    job.sessionRoot,
    "--no-extensions",
    "--no-prompt-templates",
    "--no-skills",
    "--tools",
    WRITE_CAPABLE_TOOLS,
  ];
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
    const match = line.match(/(?:^|[.;])\s*Tests?(?: run)?:\s*(.+)$/i);
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
  Object.assign(job, changes, { updatedAt: new Date().toISOString() });
  await persistJob(job);
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

function renderImplementReport({ errorMessage, finalText, job, ok, piTerminated }) {
  return [
    "# Pi implementation result",
    `Status: ${ok ? "completed" : "failed"}`,
    `Job: ${job.id}`,
    `Model: ${job.model ?? "unknown"}`,
    `Session: ${job.sessionId ?? "unknown"}`,
    `Session file: ${job.piSessionFile ?? "unknown"}`,
    `Pi RPC termination: ${piTerminated ? "ok" : "failed"}`,
    "",
    ok ? finalText : `Error: ${errorMessage}`,
  ].join("\n");
}
