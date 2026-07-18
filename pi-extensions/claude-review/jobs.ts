import { randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ClaudeReviewCapsuleProvenance, ClaudeReviewOptions, ReviewLevel } from "./args.js";

export const JOB_STORE_ENV = "PI_CLAUDE_REVIEW_JOB_DIR";
export const JOB_BACKEND = "claude-bg";
export const JOB_SESSION_NAME_PREFIX = "pi-claude-review:";
export const JOB_STORE_DIRECTORY_MODE = 0o700;
export const JOB_FILE_MODE = 0o600;

export type ClaudeReviewJobStatus =
  | "queued"
  | "starting"
  | "running"
  | "blocked"
  | "review"
  | "failed"
  | "cancelled"
  | "timeout"
  | "unknown";

export type ClaudeReviewSource = "marked-output";

export interface ClaudeReviewJob {
  id: string;
  backend: typeof JOB_BACKEND;
  cwd: string;
  level: ReviewLevel;
  contextMessage: string;
  autoFix: boolean;
  capsuleProvenance?: ClaudeReviewCapsuleProvenance;
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
  hasFindings?: boolean | null;
  reviewSource?: ClaudeReviewSource | null;
  errorMessage?: string | null;
  rawStartOutput?: string;
  rawAgentsEntry?: unknown;
}

export interface CreateClaudeReviewJobInput {
  cwd: string;
  options: Pick<ClaudeReviewOptions, "autoFix" | "contextMessage" | "level" | "capsuleProvenance">;
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
  const timestamp = now
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);
  return `claude-review-${timestamp}-${randomBytes(4).toString("hex")}`;
}

function assertValidJobId(id: string): void {
  if (!/^claude-review-\d{14}-[a-f0-9]{8}$/.test(id)) {
    throw new Error(`Invalid Claude review job id: ${id}`);
  }
}

export function createSessionName(jobId: string): string {
  return `${JOB_SESSION_NAME_PREFIX}${jobId}`;
}

function jobPath(id: string): string {
  assertValidJobId(id);
  return join(jobStoreDir(), `${id}.json`);
}

async function assertOwnerOnlyDirectory(path: string): Promise<void> {
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`Claude review job store is not a directory: ${path}`);
  }
  await chmod(path, JOB_STORE_DIRECTORY_MODE);
  const secured = await lstat(path);
  if (
    !secured.isDirectory() ||
    secured.isSymbolicLink() ||
    (secured.mode & 0o777) !== JOB_STORE_DIRECTORY_MODE
  ) {
    throw new Error(`Claude review job store must have mode 0700: ${path}`);
  }
}

async function ensureJobStore(): Promise<void> {
  const path = jobStoreDir();
  await mkdir(path, { recursive: true, mode: JOB_STORE_DIRECTORY_MODE });
  await assertOwnerOnlyDirectory(path);
}

async function secureJobFile(path: string): Promise<void> {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error(`Claude review job file is not a regular file: ${path}`);
  }
  await chmod(path, JOB_FILE_MODE);
  const secured = await lstat(path);
  if (!secured.isFile() || secured.isSymbolicLink() || (secured.mode & 0o777) !== JOB_FILE_MODE) {
    throw new Error(`Claude review job file must have mode 0600: ${path}`);
  }
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
    ...(input.options.capsuleProvenance
      ? { capsuleProvenance: input.options.capsuleProvenance }
      : {}),
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
    hasFindings: null,
    reviewSource: null,
    errorMessage: null,
  };
  await writeJob(job);
  return job;
}

export async function readJob(id: string): Promise<ClaudeReviewJob> {
  await ensureJobStore();
  const path = jobPath(id);
  await secureJobFile(path);
  const content = await readFile(path, "utf8");
  const job = JSON.parse(content) as ClaudeReviewJob;
  assertValidJobId(job.id);
  if (job.id !== id) {
    throw new Error(`Claude review job id mismatch: expected ${id}, got ${job.id}`);
  }
  return job;
}

export async function writeJob(job: ClaudeReviewJob): Promise<ClaudeReviewJob> {
  await ensureJobStore();
  const next = { ...job, updatedAt: new Date().toISOString() };
  const target = jobPath(next.id);
  try {
    await secureJobFile(target);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  const temporary = `${target}.${randomBytes(12).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: "utf8",
      mode: JOB_FILE_MODE,
      flag: "wx",
    });
    await chmod(temporary, JOB_FILE_MODE);
    await secureJobFile(temporary);
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  // Rename is the atomic commit boundary. The same-directory temporary file
  // was already secured, so no fallible verification follows the commit.
  return next;
}

export async function listJobs(options: { cwd?: string } = {}): Promise<ClaudeReviewJob[]> {
  await ensureJobStore();
  const files = await readdir(jobStoreDir());
  const jobs: ClaudeReviewJob[] = [];

  for (const file of files) {
    if (!file.endsWith(".json")) {
      continue;
    }
    const path = join(jobStoreDir(), file);
    await secureJobFile(path);
    const content = await readFile(path, "utf8");
    try {
      const job = JSON.parse(content) as ClaudeReviewJob;
      assertValidJobId(job.id);
      if (file !== `${job.id}.json`) {
        continue;
      }
      if (!options.cwd || job.cwd === options.cwd) {
        jobs.push(job);
      }
    } catch {
      // Ignore partial or unrelated JSON files in the job store.
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
