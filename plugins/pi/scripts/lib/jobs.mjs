import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export const DEFAULT_DATA_DIR = join(homedir(), ".local", "state", "claude-pi-companion");
export const RECENT_JOBS_LIMIT = 20;

export function createImplementationJob(options = {}) {
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const dataDir = resolveDataDir(options.dataDir);
  const workspaceId = workspaceIdForRoot(workspaceRoot);
  const workspaceRootPath = workspaceStateRoot(dataDir, workspaceRoot);
  const id = options.id ?? `impl-${randomUUID()}`;
  const now = new Date().toISOString();
  return {
    id,
    kind: "implement",
    status: options.status ?? "running",
    phase: options.phase ?? "starting",
    workspaceRoot,
    workspaceId,
    sessionRoot: join(dataDir, "pi-sessions"),
    jobFile: join(workspaceRootPath, "jobs", `${id}.json`),
    logFile: join(workspaceRootPath, "logs", `${id}.jsonl`),
    createdAt: now,
    updatedAt: now,
    changedFiles: [],
    testsRun: [],
  };
}

export async function persistJob(job) {
  await mkdir(dirname(job.jobFile), { recursive: true });
  await mkdir(job.sessionRoot, { recursive: true });
  await mkdir(dirname(job.logFile), { recursive: true });
  await atomicWriteJson(job.jobFile, job);
}

export async function readJob(path) {
  return normalizeJobRecord(JSON.parse(await readFile(path, "utf8")), path);
}

export async function updateJobRecord(job, changes) {
  Object.assign(job, changes, { updatedAt: new Date().toISOString() });
  await persistJob(job);
  return job;
}

export async function appendJobLog(job, event, details = {}) {
  await mkdir(dirname(job.logFile), { recursive: true });
  const entry = {
    timestamp: new Date().toISOString(),
    jobId: job.id,
    event,
    ...details,
  };
  await appendFile(job.logFile, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

export async function listJobs(options = {}) {
  const root = workspaceStateRoot(resolveDataDir(options.dataDir), workspaceRoot(options));
  const jobsDir = join(root, "jobs");
  const warnings = [];
  const records = await readJobRecords(jobsDir, warnings);
  const jobs = sortJobs(records).slice(0, options.limit ?? RECENT_JOBS_LIMIT);
  return { jobs, ledgerPath: jobsDir, warnings };
}

export async function findJob(selector = "latest", options = {}) {
  const result = await listJobs({ ...options, limit: Number.POSITIVE_INFINITY });
  if (selector === "latest" || !selector) return { ...result, job: result.jobs[0] ?? null };
  const job = result.jobs.find((candidate) => candidate.id === selector) ?? null;
  return { ...result, job };
}

export function resolveDataDir(dataDir) {
  return dataDir ?? process.env.PI_COMPANION_DATA_DIR ?? DEFAULT_DATA_DIR;
}

export function workspaceIdForRoot(root) {
  return createHash("sha256").update(root).digest("hex").slice(0, 16);
}

export function workspaceStateRoot(dataDir, root) {
  return join(dataDir, "workspaces", workspaceIdForRoot(root));
}

async function atomicWriteJson(path, data) {
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, path);
}

async function readJobRecords(jobsDir, warnings) {
  let entries;
  try {
    entries = await readdir(jobsDir, { withFileTypes: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isMissingFileError(error)) return [];
    warnings.push(`Could not read job ledger ${jobsDir}: ${message}`);
    return [];
  }
  const jobs = [];
  for (const entry of entries) await addJobRecord(jobs, jobsDir, entry, warnings);
  return jobs;
}

async function addJobRecord(jobs, jobsDir, entry, warnings) {
  if (!entry.isFile() || !entry.name.endsWith(".json")) return;
  const path = join(jobsDir, entry.name);
  try {
    jobs.push(normalizeJobRecord(JSON.parse(await readFile(path, "utf8")), path));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`Skipped unreadable job record ${basename(path)}: ${message}`);
  }
}

function isMissingFileError(error) {
  return error && typeof error === "object" && error.code === "ENOENT";
}

function normalizeJobRecord(record, path) {
  const job = record && typeof record === "object" ? record : {};
  return {
    ...job,
    id: typeof job.id === "string" ? job.id : basename(path, ".json"),
    kind: typeof job.kind === "string" ? job.kind : "unknown",
    status: typeof job.status === "string" ? job.status : "unknown",
    phase: typeof job.phase === "string" ? job.phase : "unknown",
    jobFile: typeof job.jobFile === "string" ? job.jobFile : path,
    changedFiles: Array.isArray(job.changedFiles) ? job.changedFiles : [],
    testsRun: Array.isArray(job.testsRun) ? job.testsRun : [],
  };
}

function sortJobs(jobs) {
  return [...jobs].sort((left, right) => timestamp(right) - timestamp(left));
}

function timestamp(job) {
  const value = Date.parse(job.updatedAt ?? job.createdAt ?? "");
  return Number.isNaN(value) ? 0 : value;
}

function workspaceRoot(options) {
  return options.workspaceRoot ?? process.cwd();
}
