import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ClaudeReviewOptions, ReviewLevel } from "./args.js";

export const JOB_STORE_ENV = "PI_CLAUDE_REVIEW_JOB_DIR";
export const JOB_BACKEND = "claude-bg";
export const JOB_SESSION_NAME_PREFIX = "pi-claude-review:";

export type ClaudeReviewJobStatus =
  | "queued"
  | "starting"
  | "running"
  | "review"
  | "failed"
  | "cancelled"
  | "timeout"
  | "unknown";

export interface ClaudeReviewJob {
  id: string;
  backend: typeof JOB_BACKEND;
  cwd: string;
  level: ReviewLevel;
  contextMessage: string;
  autoFix: boolean;
  prompt: string;
  claudeSessionId?: string;
  claudeSessionName: string;
  status: ClaudeReviewJobStatus;
  startedAt: string;
  updatedAt: string;
  completedAt?: string | null;
  exitCode?: number | null;
  stdout: string;
  stderr: string;
  lastLog: string;
  errorMessage?: string | null;
  rawStartOutput?: string;
  rawAgentsEntry?: unknown;
}

export interface CreateClaudeReviewJobInput {
  cwd: string;
  options: Pick<ClaudeReviewOptions, "autoFix" | "contextMessage" | "level">;
  prompt: string;
}

export function jobStoreDir(): string {
  const configured = process.env[JOB_STORE_ENV]?.trim();
  if (configured) {
    return configured;
  }
  return join(homedir(), ".pi", "agent", "claude-review", "jobs");
}

export function isTerminalJobStatus(status: ClaudeReviewJobStatus): boolean {
  return ["review", "failed", "cancelled", "timeout"].includes(status);
}

export function createJobId(now = new Date()): string {
  const timestamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `claude-review-${timestamp}-${randomBytes(4).toString("hex")}`;
}

export function createSessionName(jobId: string): string {
  return `${JOB_SESSION_NAME_PREFIX}${jobId}`;
}

function jobPath(id: string): string {
  return join(jobStoreDir(), `${id}.json`);
}

async function ensureJobStore(): Promise<void> {
  await mkdir(jobStoreDir(), { recursive: true });
}

export async function createJob(input: CreateClaudeReviewJobInput): Promise<ClaudeReviewJob> {
  const id = createJobId();
  const now = new Date().toISOString();
  const job: ClaudeReviewJob = {
    id,
    backend: JOB_BACKEND,
    cwd: input.cwd,
    level: input.options.level,
    contextMessage: input.options.contextMessage,
    autoFix: input.options.autoFix,
    prompt: input.prompt,
    claudeSessionName: createSessionName(id),
    status: "queued",
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    exitCode: null,
    stdout: "",
    stderr: "",
    lastLog: "",
    errorMessage: null,
  };
  await writeJob(job);
  return job;
}

export async function readJob(id: string): Promise<ClaudeReviewJob> {
  const content = await readFile(jobPath(id), "utf8");
  return JSON.parse(content) as ClaudeReviewJob;
}

export async function writeJob(job: ClaudeReviewJob): Promise<ClaudeReviewJob> {
  await ensureJobStore();
  const next = { ...job, updatedAt: new Date().toISOString() };
  await writeFile(jobPath(next.id), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export async function listJobs(options: { cwd?: string } = {}): Promise<ClaudeReviewJob[]> {
  await ensureJobStore();
  const files = await readdir(jobStoreDir()).catch(() => [] as string[]);
  const jobs: ClaudeReviewJob[] = [];

  for (const file of files) {
    if (!file.endsWith(".json")) {
      continue;
    }
    try {
      const content = await readFile(join(jobStoreDir(), file), "utf8");
      const job = JSON.parse(content) as ClaudeReviewJob;
      if (!options.cwd || job.cwd === options.cwd) {
        jobs.push(job);
      }
    } catch {
      // Ignore partial or unrelated files in the job store.
    }
  }

  return jobs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function resolveJob(jobId: string | undefined, cwd: string): Promise<ClaudeReviewJob> {
  if (jobId) {
    return readJob(jobId);
  }

  const [latest] = await listJobs({ cwd });
  if (!latest) {
    throw new Error("No Claude review jobs found for this working directory");
  }
  return latest;
}
