import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { CLAUDE_REVIEW_RESULT_END, CLAUDE_REVIEW_RESULT_START } from "./args.js";
import {
  type ClaudeReviewJob,
  type ClaudeReviewJobStatus,
  isTerminalJobStatus,
  writeJob,
} from "./jobs.js";

export const BACKGROUND_START_TIMEOUT_MS = 60 * 1000;
export const BACKGROUND_STATUS_TIMEOUT_MS = 30 * 1000;

interface ClaudeAgentRecord {
  [key: string]: unknown;
}

export function claudeBackgroundArgs(
  prompt: string,
  sessionName: string,
  reviewTools: string,
): string[] {
  return [
    "--bg",
    "--name",
    sessionName,
    "--permission-mode",
    "auto",
    "--tools",
    reviewTools,
    "--allowed-tools",
    reviewTools,
    prompt,
  ];
}

export function claudeAgentsArgs(cwd: string): string[] {
  return ["agents", "--json", "--all", "--cwd", cwd];
}

export function claudeLogsArgs(sessionId: string): string[] {
  return ["logs", sessionId];
}

export function claudeStopArgs(sessionId: string): string[] {
  return ["stop", sessionId];
}

export async function startClaudeBackgroundReview(
  pi: ExtensionAPI,
  job: ClaudeReviewJob,
  claudeBinary: string,
  reviewTools: string,
  signal?: AbortSignal,
): Promise<ClaudeReviewJob> {
  let next = await writeJob({ ...job, status: "starting", errorMessage: null });
  const result = await pi.exec(
    claudeBinary,
    claudeBackgroundArgs(next.prompt, next.claudeSessionName, reviewTools),
    {
      cwd: next.cwd,
      signal,
      timeout: BACKGROUND_START_TIMEOUT_MS,
    },
  );

  const rawStartOutput = joinOutput(result);
  const claudeSessionId = parseBackgroundSessionId(rawStartOutput);

  if (result.killed) {
    return writeJob({
      ...next,
      status: "timeout",
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.code,
      completedAt: new Date().toISOString(),
      errorMessage: "Claude background session did not start before the startup timeout",
      rawStartOutput,
    });
  }

  if (result.code !== 0) {
    return writeJob({
      ...next,
      status: "failed",
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.code,
      completedAt: new Date().toISOString(),
      errorMessage: `Claude background session failed to start with exit code ${result.code}`,
      rawStartOutput,
    });
  }

  next = await writeJob({
    ...next,
    status: "running",
    claudeSessionId,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.code,
    rawStartOutput,
  });

  return next;
}

export async function refreshClaudeBackgroundJob(
  pi: ExtensionAPI,
  job: ClaudeReviewJob,
  claudeBinary: string,
): Promise<ClaudeReviewJob> {
  const result = await pi.exec(claudeBinary, claudeAgentsArgs(job.cwd), {
    cwd: job.cwd,
    timeout: BACKGROUND_STATUS_TIMEOUT_MS,
  });

  if (result.killed || result.code !== 0) {
    const errorMessage = result.killed
      ? "Timed out while checking Claude background agents"
      : `Failed to check Claude background agents with exit code ${result.code}`;
    return writeJob({
      ...job,
      stderr: result.stderr || job.stderr,
      errorMessage,
      status: isTerminalJobStatus(job.status) ? job.status : "unknown",
    });
  }

  const agents = parseAgentsJson(result.stdout);
  const agent = findMatchingAgent(job, agents);
  if (!agent) {
    return writeJob({
      ...job,
      status: isTerminalJobStatus(job.status) ? job.status : "unknown",
      errorMessage: "Claude session was not found in `claude agents --json --all` output",
    });
  }

  const status = normalizeAgentStatus(agent, job.status);
  const exitCode = pickNumber(agent, ["exitCode", "exit_code", "code"]);
  const completedAt = isTerminalJobStatus(status)
    ? (pickString(agent, [
        "completedAt",
        "completed_at",
        "endedAt",
        "ended_at",
        "stoppedAt",
        "stopped_at",
      ]) ??
      job.completedAt ??
      new Date().toISOString())
    : job.completedAt;

  return writeJob({
    ...job,
    status,
    claudeSessionId: pickAgentId(agent) ?? job.claudeSessionId,
    exitCode: exitCode ?? job.exitCode,
    completedAt,
    errorMessage: null,
    rawAgentsEntry: agent,
  });
}

export async function readClaudeBackgroundLogs(
  pi: ExtensionAPI,
  job: ClaudeReviewJob,
  claudeBinary: string,
): Promise<ClaudeReviewJob> {
  if (!job.claudeSessionId) {
    throw new Error("Claude session id is not known yet; run /claude-review-status and try again");
  }

  const result = await pi.exec(claudeBinary, claudeLogsArgs(job.claudeSessionId), {
    cwd: job.cwd,
    timeout: BACKGROUND_STATUS_TIMEOUT_MS,
  });

  const markedReview = extractMarkedReview(result.stdout);
  const status = result.code !== 0 ? "failed" : job.status;

  return writeJob({
    ...job,
    status,
    stdout: markedReview ?? result.stdout,
    stderr: result.stderr,
    lastLog: result.stdout,
    exitCode: job.exitCode,
    completedAt:
      status === "review" && !job.completedAt ? new Date().toISOString() : job.completedAt,
    errorMessage:
      result.code !== 0
        ? `Failed to read Claude logs with exit code ${result.code}`
        : job.errorMessage,
  });
}

export async function cancelClaudeBackgroundJob(
  pi: ExtensionAPI,
  job: ClaudeReviewJob,
  claudeBinary: string,
): Promise<ClaudeReviewJob> {
  if (!job.claudeSessionId) {
    throw new Error("Claude session id is not known yet; run /claude-review-status and try again");
  }

  const result = await pi.exec(claudeBinary, claudeStopArgs(job.claudeSessionId), {
    cwd: job.cwd,
    timeout: BACKGROUND_STATUS_TIMEOUT_MS,
  });

  return writeJob({
    ...job,
    status: result.code === 0 ? "cancelled" : "failed",
    stdout: result.stdout || job.stdout,
    stderr: result.stderr || job.stderr,
    exitCode: result.code,
    completedAt: new Date().toISOString(),
    errorMessage:
      result.code === 0
        ? null
        : `Failed to stop Claude background session with exit code ${result.code}`,
  });
}

function joinOutput(result: ExecResult): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

export function parseBackgroundSessionId(output: string): string | undefined {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const commandPrefixes = ["claude attach ", "claude logs ", "claude stop "];

  for (const line of lines) {
    const backgroundedParts = line.split("·").map((part) => part.trim());
    if (backgroundedParts[0] === "backgrounded" && backgroundedParts[1]) {
      return backgroundedParts[1];
    }

    const labelMatch = line.match(/(?:session|agent)\s+(?:id|ID)[:\s]+([A-Za-z0-9_-]{6,})/i);
    if (labelMatch?.[1]) {
      return labelMatch[1];
    }

    for (const prefix of commandPrefixes) {
      if (line.startsWith(prefix)) {
        return line.slice(prefix.length).split(/\s+/)[0];
      }
    }

    if (/^[A-Za-z0-9_-]{6,}$/.test(line)) {
      return line;
    }
  }

  return undefined;
}

function parseAgentsJson(output: string): ClaudeAgentRecord[] {
  const trimmed = output.trim();
  if (!trimmed) {
    return [];
  }

  const parsed =
    parseJson(trimmed) ??
    parseJson(trimmed.slice(trimmed.indexOf("["), trimmed.lastIndexOf("]") + 1));
  if (Array.isArray(parsed)) {
    return parsed.filter(isRecord);
  }
  if (isRecord(parsed) && Array.isArray(parsed.agents)) {
    return parsed.agents.filter(isRecord);
  }
  return [];
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is ClaudeAgentRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findMatchingAgent(
  job: ClaudeReviewJob,
  agents: ClaudeAgentRecord[],
): ClaudeAgentRecord | undefined {
  return agents.find((agent) => {
    const id = pickAgentId(agent);
    if (id && job.claudeSessionId && id === job.claudeSessionId) {
      return true;
    }

    const name = pickString(agent, ["name", "displayName", "display_name", "title"]);
    if (name === job.claudeSessionName) {
      return true;
    }

    return JSON.stringify(agent).includes(job.claudeSessionName);
  });
}

function pickAgentId(agent: ClaudeAgentRecord): string | undefined {
  return pickString(agent, ["id", "sessionId", "session_id", "session"]);
}

function normalizeAgentStatus(
  agent: ClaudeAgentRecord,
  fallback: ClaudeReviewJobStatus,
): ClaudeReviewJobStatus {
  const exitCode = pickNumber(agent, ["exitCode", "exit_code", "code"]);
  if (exitCode !== undefined && exitCode !== 0) {
    return "failed";
  }

  const raw = String(
    pickString(agent, ["state", "status", "lifecycle", "phase"]) ?? "",
  ).toLowerCase();
  if (!raw) {
    return fallback === "queued" || fallback === "starting" ? "running" : fallback;
  }
  if (raw.includes("fail") || raw.includes("error")) {
    return "failed";
  }
  if (
    raw.includes("cancel") ||
    raw.includes("killed") ||
    raw.includes("stopped") ||
    raw.includes("stop")
  ) {
    return "cancelled";
  }
  if (raw.includes("blocked") || raw.includes("waiting") || raw.includes("needs input")) {
    return "blocked";
  }
  if (
    raw.includes("complete") ||
    raw.includes("done") ||
    raw.includes("finish") ||
    raw.includes("success") ||
    raw.includes("succeed")
  ) {
    return "review";
  }
  if (raw.includes("queue") || raw.includes("pending")) {
    return "queued";
  }
  if (raw.includes("start")) {
    return "starting";
  }
  if (
    raw.includes("run") ||
    raw.includes("active") ||
    raw.includes("progress") ||
    raw.includes("work")
  ) {
    return "running";
  }
  return fallback === "queued" || fallback === "starting" ? "running" : fallback;
}

function pickString(record: ClaudeAgentRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function pickNumber(record: ClaudeAgentRecord, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number") {
      return value;
    }
    if (typeof value === "string" && /^-?\d+$/.test(value)) {
      return Number.parseInt(value, 10);
    }
  }
  return undefined;
}

export function extractMarkedReview(output: string): string | undefined {
  const start = output.lastIndexOf(CLAUDE_REVIEW_RESULT_START);
  const end = output.indexOf(CLAUDE_REVIEW_RESULT_END, start + CLAUDE_REVIEW_RESULT_START.length);
  if (start === -1 || end === -1 || end <= start) {
    return undefined;
  }

  return output.slice(start + CLAUDE_REVIEW_RESULT_START.length, end).trim();
}
