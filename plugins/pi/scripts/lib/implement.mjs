import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { PiRpcClient } from "./pi-rpc-client.mjs";
import { DEFAULT_INTENDED_MODEL, modelRef } from "./setup.mjs";

const WRITE_CAPABLE_TOOLS = "read,grep,find,ls,bash,edit,write";
const DEFAULT_AGENT_END_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_DATA_DIR = join(homedir(), ".local", "state", "claude-pi-companion");
const DEFAULT_TERMINATE_TIMEOUT_MS = 10_000;

export async function runImplement(options = {}) {
  const brief = normalizeBrief(options.brief);
  const job = createJob(options);
  await persistJob(job);
  const client = new PiRpcClient({
    command: options.piCommand ?? process.env.PI_CLI ?? "pi",
    args: buildPiArgs(job, options),
    stderrMaxBytes: options.stderrMaxBytes,
    timeoutMs: options.timeoutMs,
  });

  let agentEnd = null;
  let finalText = null;
  let errorMessage = null;
  try {
    const state = await requestData(client, { type: "get_state" });
    updateJobFromState(job, state);
    agentEnd = client.waitForEvent("agent_end", {
      predicate: isFinalAgentEndEvent,
      timeoutMs: options.agentEndTimeoutMs ?? DEFAULT_AGENT_END_TIMEOUT_MS,
    });
    await requestOk(client, { type: "prompt", message: buildImplementationPrompt(brief) });
    const agentEndEvent = await agentEnd;
    finalText = await getFinalText(client, agentEndEvent);
    job.status = "completed";
    job.result = finalText;
    job.summary = firstNonEmptyLine(finalText);
  } catch (error) {
    if (agentEnd) void agentEnd.catch(() => {});
    errorMessage = error instanceof Error ? error.message : String(error);
    job.status = "failed";
    job.errorMessage = errorMessage;
  }

  const piTerminated = await client.terminate(
    options.terminateTimeoutMs ?? DEFAULT_TERMINATE_TIMEOUT_MS,
  );
  job.completedAt = new Date().toISOString();
  job.updatedAt = job.completedAt;
  await persistJob(job);
  const ok = job.status === "completed";
  return buildImplementResult({ client, errorMessage, finalText, job, ok, piTerminated });
}

function createJob(options) {
  const dataDir = options.dataDir ?? process.env.PI_COMPANION_DATA_DIR ?? DEFAULT_DATA_DIR;
  const id = `impl-${randomUUID()}`;
  const now = new Date().toISOString();
  return {
    id,
    kind: "implement",
    status: "running",
    phase: "delegating",
    workspaceRoot: options.workspaceRoot ?? process.cwd(),
    sessionRoot: join(dataDir, "pi-sessions"),
    jobFile: join(dataDir, "jobs", `${id}.json`),
    createdAt: now,
    updatedAt: now,
  };
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

function updateJobFromState(job, state) {
  job.sessionId = state?.sessionId;
  job.piSessionFile = state?.sessionFile;
  job.model = modelRef(state?.model);
  job.updatedAt = new Date().toISOString();
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

async function persistJob(job) {
  await mkdir(dirname(job.jobFile), { recursive: true });
  await mkdir(job.sessionRoot, { recursive: true });
  await writeFile(job.jobFile, `${JSON.stringify(job, null, 2)}\n`);
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
