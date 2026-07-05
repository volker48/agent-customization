import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  CLAUDE_REVIEW_HAS_FINDINGS_END,
  CLAUDE_REVIEW_HAS_FINDINGS_START,
  CLAUDE_REVIEW_RESULT_END,
  CLAUDE_REVIEW_RESULT_START,
} from "./args.js";
import {
  type ClaudeReviewJob,
  type ClaudeReviewJobStatus,
  isTerminalJobStatus,
  writeJob,
} from "./jobs.js";

export const BACKGROUND_START_TIMEOUT_MS = 60 * 1000;
export const BACKGROUND_STATUS_TIMEOUT_MS = 30 * 1000;

const RAW_LOG_PREVIEW_CHARS = 20_000;
const ESCAPE_CHAR = String.fromCharCode(27);
const BELL_CHAR = String.fromCharCode(7);
const C1_CSI_CHAR = String.fromCharCode(0x9b);
const ANSI_OSC_SEQUENCE = `${ESCAPE_CHAR}\\][^${BELL_CHAR}]*`;
const ANSI_OSC_TERMINATOR = `(?:${BELL_CHAR}|${ESCAPE_CHAR}\\\\)`;
const ANSI_CSI_SEQUENCE = `${ESCAPE_CHAR}\\[[0-?]*[ -/]*[@-~]`;
const ANSI_FE_SEQUENCE = `${ESCAPE_CHAR}[@-Z\\\\^_]`;
const C1_CSI_SEQUENCE = `${C1_CSI_CHAR}[0-?]*[ -/]*[@-~]`;
const ANSI_ESCAPE_PATTERN = new RegExp(
  [
    `${ANSI_OSC_SEQUENCE}${ANSI_OSC_TERMINATOR}`,
    ANSI_CSI_SEQUENCE,
    ANSI_FE_SEQUENCE,
    C1_CSI_SEQUENCE,
  ].join("|"),
  "g",
);
const MISSING_MARKERS_ERROR =
  "Claude logs did not contain review result markers; refusing to forward raw logs";

interface ClaudeAgentRecord {
  [key: string]: unknown;
}

export interface MarkedReviewResult {
  review: string;
  hasFindings?: boolean;
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
    "--",
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

  const writeStartFailure = (
    status: Extract<ClaudeReviewJobStatus, "failed" | "timeout">,
    errorMessage: string,
  ): Promise<ClaudeReviewJob> =>
    writeJob({
      ...next,
      status,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.code,
      completedAt: new Date().toISOString(),
      errorMessage,
      rawStartOutput,
    });

  if (result.killed) {
    return writeStartFailure(
      "timeout",
      "Claude background session did not start before the startup timeout",
    );
  }

  if (result.code !== 0) {
    return writeStartFailure(
      "failed",
      `Claude background session failed to start with exit code ${result.code}`,
    );
  }

  if (!claudeSessionId) {
    return writeStartFailure("failed", "Claude background session did not report a session id");
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

  if (isTerminalJobStatus(job.status)) {
    return writeJob({
      ...job,
      claudeSessionId: pickAgentId(agent) ?? job.claudeSessionId,
      rawAgentsEntry: agent,
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

  const transcript = await readClaudeTranscript(job);
  if (transcript) {
    return applyClaudeLogOutput(job, { stdout: transcript, stderr: "", code: 0 });
  }

  const result = await pi.exec(claudeBinary, claudeLogsArgs(job.claudeSessionId), {
    cwd: job.cwd,
    timeout: BACKGROUND_STATUS_TIMEOUT_MS,
  });

  if (result.code !== 0 && isTerminalJobStatus(job.status)) {
    return job;
  }
  return applyClaudeLogOutput(job, result);
}

interface ClaudeLogOutput {
  stdout: string;
  stderr: string;
  code: number;
}

async function applyClaudeLogOutput(
  job: ClaudeReviewJob,
  result: ClaudeLogOutput,
): Promise<ClaudeReviewJob> {
  const normalizedStdout = normalizeClaudeOutput(result.stdout);
  const markedResult = extractMarkedReviewResultFromNormalized(normalizedStdout);
  let status = job.status;
  let stdout = job.stdout;
  let completedAt = job.completedAt;
  let errorMessage = job.errorMessage;
  let reviewSource = job.reviewSource;
  let hasFindings = job.hasFindings;
  if (result.code !== 0) {
    status = "failed";
    completedAt = completedAt ?? new Date().toISOString();
    reviewSource = null;
    errorMessage = `Failed to read Claude logs with exit code ${result.code}`;
  } else if (markedResult) {
    if (!isTerminalJobStatus(job.status)) {
      status = "review";
      stdout = markedResult.review;
      hasFindings = markedResult.hasFindings ?? null;
      reviewSource = "marked-output";
      completedAt = completedAt ?? new Date().toISOString();
    } else if (!stdout.trim() || (job.status === "review" && !hasPersistedReview(job))) {
      stdout = markedResult.review;
      hasFindings = markedResult.hasFindings ?? null;
      reviewSource = "marked-output";
    }
  } else if (job.status === "review" && !hasPersistedReview(job)) {
    status = "failed";
    stdout = "";
    completedAt = completedAt ?? new Date().toISOString();
    reviewSource = null;
    errorMessage = MISSING_MARKERS_ERROR;
  }

  return writeJob({
    ...job,
    status,
    stdout,
    stderr: result.stderr,
    lastLog: truncateClaudeLog(normalizedStdout),
    hasFindings,
    reviewSource,
    exitCode: job.exitCode,
    completedAt,
    errorMessage,
  });
}

async function readClaudeTranscript(job: ClaudeReviewJob): Promise<string | undefined> {
  for (const path of await claudeTranscriptPaths(job)) {
    const markedResult = await readMarkedReviewFromJsonl(path);
    if (markedResult) {
      return formatMarkedReviewResult(markedResult);
    }
  }
  return undefined;
}

async function claudeTranscriptPaths(job: ClaudeReviewJob): Promise<string[]> {
  const paths = new Set<string>();
  if (!job.claudeSessionId) {
    return [];
  }
  const jobDir = join(homedir(), ".claude", "jobs", job.claudeSessionId);
  paths.add(join(jobDir, "timeline.jsonl"));

  const state = await readJsonFile(join(jobDir, "state.json"));
  if (state) {
    const linkScanPath = pickString(state, ["linkScanPath"]);
    if (linkScanPath) {
      paths.add(linkScanPath);
    }
  }
  return [...paths];
}

async function readMarkedReviewFromJsonl(path: string): Promise<MarkedReviewResult | undefined> {
  const content = await readFile(path, "utf8").catch(() => undefined);
  if (!content) {
    return undefined;
  }

  let latest: MarkedReviewResult | undefined;
  for (const line of content.split(/\r?\n/)) {
    const record = parseJson(line);
    if (!isRecord(record)) {
      continue;
    }
    for (const text of extractRecordTexts(record)) {
      const result = extractMarkedReviewResult(text);
      if (result && !isPromptPlaceholder(result.review)) {
        latest = result;
      }
    }
  }
  return latest;
}

async function readJsonFile(path: string): Promise<ClaudeAgentRecord | undefined> {
  const content = await readFile(path, "utf8").catch(() => undefined);
  const parsed = content ? parseJson(content) : undefined;
  return isRecord(parsed) ? parsed : undefined;
}

function extractRecordTexts(record: ClaudeAgentRecord): string[] {
  const texts: string[] = [];
  if (typeof record.text === "string") {
    texts.push(record.text);
  }

  const message = record.message;
  if (isRecord(message)) {
    pushMessageTexts(texts, message);
  }
  return texts;
}

function pushMessageTexts(texts: string[], message: ClaudeAgentRecord): void {
  const content = message.content;
  if (typeof content === "string") {
    texts.push(content);
  } else if (Array.isArray(content)) {
    for (const item of content) {
      if (isRecord(item) && typeof item.text === "string") {
        texts.push(item.text);
      }
    }
  }
}

export async function cancelClaudeBackgroundJob(
  pi: ExtensionAPI,
  job: ClaudeReviewJob,
  claudeBinary: string,
): Promise<ClaudeReviewJob> {
  if (isTerminalJobStatus(job.status)) {
    return job;
  }

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

export function sanitizeClaudeLog(output: string): string {
  return truncateClaudeLog(normalizeClaudeOutput(output));
}

function normalizeClaudeOutput(output: string): string {
  return stripUnsafeControls(stripAnsiControls(output).replace(/\r/g, "\n"));
}

function stripAnsiControls(output: string): string {
  return output.replace(ANSI_ESCAPE_PATTERN, "");
}

function truncateClaudeLog(output: string): string {
  if (output.length <= RAW_LOG_PREVIEW_CHARS) {
    return output;
  }
  return [
    `[Claude log truncated to last ${RAW_LOG_PREVIEW_CHARS} of ${output.length} characters]`,
    "",
    output.slice(-RAW_LOG_PREVIEW_CHARS),
  ].join("\n");
}

function hasPersistedReview(job: ClaudeReviewJob): boolean {
  const stdout = normalizeClaudeOutput(job.stdout).trim();
  if (!stdout) {
    return false;
  }
  if (job.reviewSource === "marked-output") {
    return true;
  }
  if (job.reviewSource !== undefined) {
    return false;
  }
  return !isClaudeStartupOutput(job.stdout, job) && !isMarkerlessRawStdout(job, stdout);
}

function isMarkerlessRawStdout(job: ClaudeReviewJob, stdout: string): boolean {
  const lastLog = normalizeClaudeOutput(job.lastLog).trim();
  return Boolean(lastLog && lastLog === stdout);
}

function isClaudeStartupOutput(output: string, job: ClaudeReviewJob): boolean {
  const trimmed = output.trim();
  if (job.rawStartOutput && trimmed === job.rawStartOutput.trim()) {
    return true;
  }
  if (!trimmed.startsWith("backgrounded ·")) {
    return false;
  }
  return Boolean(
    (job.claudeSessionId && trimmed.includes(job.claudeSessionId)) ||
    trimmed.includes(job.claudeSessionName),
  );
}

function stripUnsafeControls(output: string): string {
  let stripped = "";
  for (const char of output) {
    const code = char.charCodeAt(0);
    const isUnsafeControl =
      (code < 32 && char !== "\n" && char !== "\t") ||
      code === 127 ||
      (code >= 0x80 && code <= 0x9f);
    if (!isUnsafeControl) {
      stripped += char;
    }
  }
  return stripped;
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
  return extractMarkedReviewResult(output)?.review;
}

export function extractMarkedReviewResult(output: string): MarkedReviewResult | undefined {
  return extractMarkedReviewResultFromNormalized(normalizeClaudeOutput(output));
}

function extractMarkedReviewResultFromNormalized(output: string): MarkedReviewResult | undefined {
  const start = output.lastIndexOf(CLAUDE_REVIEW_RESULT_START);
  const end = output.indexOf(CLAUDE_REVIEW_RESULT_END, start + CLAUDE_REVIEW_RESULT_START.length);
  if (start === -1 || end === -1 || end <= start) {
    return undefined;
  }

  return {
    review: output.slice(start + CLAUDE_REVIEW_RESULT_START.length, end).trim(),
    hasFindings: extractHasFindingsMarker(output, start),
  };
}

function extractHasFindingsMarker(output: string, beforeIndex: number): boolean | undefined {
  const previousResultEnd = output.lastIndexOf(CLAUDE_REVIEW_RESULT_END, beforeIndex - 1);
  const markerFloor =
    previousResultEnd === -1 ? 0 : previousResultEnd + CLAUDE_REVIEW_RESULT_END.length;
  const markerStart = output.lastIndexOf(CLAUDE_REVIEW_HAS_FINDINGS_START, beforeIndex);
  if (markerStart === -1 || markerStart < markerFloor) {
    return undefined;
  }
  const valueStart = markerStart + CLAUDE_REVIEW_HAS_FINDINGS_START.length;
  const markerEnd = output.indexOf(CLAUDE_REVIEW_HAS_FINDINGS_END, valueStart);
  if (markerEnd === -1 || markerEnd > beforeIndex) {
    return undefined;
  }

  const value = output.slice(valueStart, markerEnd).trim().toLowerCase();
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return undefined;
}

function formatMarkedReviewResult(result: MarkedReviewResult): string {
  const findings =
    result.hasFindings === undefined
      ? []
      : [
          CLAUDE_REVIEW_HAS_FINDINGS_START,
          String(result.hasFindings),
          CLAUDE_REVIEW_HAS_FINDINGS_END,
        ];
  return [...findings, CLAUDE_REVIEW_RESULT_START, result.review, CLAUDE_REVIEW_RESULT_END].join(
    "\n",
  );
}

function isPromptPlaceholder(review: string): boolean {
  return review.includes("<your concise, actionable review");
}
