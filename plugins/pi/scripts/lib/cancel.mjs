import { appendJobLog, findJob, listJobs, readJob, updateJobRecord } from "./jobs.mjs";
import { isProcessAlive, terminateProcessTree } from "./process-tree.mjs";

const ACTIVE_STATUSES = new Set(["queued", "running", "cancelling"]);
const DEFAULT_CANCEL_TIMEOUT_MS = 2_000;

export async function runCancel(selector = "latest", options = {}) {
  const result = await findJob(selector, options);
  if (!result.job) return missingResult(result, selector);
  const job = result.job;
  if (!ACTIVE_STATUSES.has(job.status)) return alreadyFinishedResult(job);
  await updateJobRecord(job, (current) =>
    ACTIVE_STATUSES.has(current.status) ? { status: "cancelling", phase: "cancelling" } : null,
  );
  if (job.status !== "cancelling") return alreadyFinishedResult(job);
  await appendJobLog(job, "cancelling", { workerPid: job.workerPid, piPid: job.piPid });
  const cancelled = await waitForCancelled(
    job.jobFile,
    options.timeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS,
  );
  if (!cancelled) await killActiveProcesses(job);
  const latest = await readJob(job.jobFile);
  return { ok: true, job: latest, report: renderCancelReport(latest) };
}

export async function cleanupActiveJobs(options = {}) {
  const ownerClaudeSessionId = options.ownerClaudeSessionId;
  const result = await listJobs({ ...options, limit: Number.POSITIVE_INFINITY });
  const cancelled = [];
  const activeJobs = result.jobs.filter((candidate) =>
    cleanupMatches(candidate, ownerClaudeSessionId),
  );
  const outcomes = await Promise.all(
    activeJobs.map(async (job) => {
      try {
        return { job, outcome: await runCancel(job.id, options) };
      } catch (error) {
        return { error, job };
      }
    }),
  );
  for (const outcome of outcomes) cancelled.push(cleanupOutcomeLine(outcome));
  return {
    ok: true,
    cancelled,
    report: renderCleanupReport(cancelled, ownerClaudeSessionId),
  };
}

function cleanupOutcomeLine({ error, job, outcome }) {
  if (error) return `${job.id}: failed (${errorMessage(error)})`;
  if (outcome?.job) return `${job.id}: ${outcome.job.status}`;
  return `${job.id}: not found`;
}

function cleanupMatches(job, ownerClaudeSessionId) {
  return (
    Boolean(ownerClaudeSessionId) &&
    ACTIVE_STATUSES.has(job.status) &&
    job.ownerClaudeSessionId === ownerClaudeSessionId
  );
}

async function killActiveProcesses(job) {
  const latest = await readJob(job.jobFile);
  if (latest.status !== "cancelling") return;
  await appendJobLog(latest, "cancel-timeout-kill", {
    piPid: latest.piPid,
    workerPid: latest.workerPid,
  });
  if (isProcessAlive(latest.piPid)) await terminateProcessTree(latest.piPid, { timeoutMs: 500 });
  if (isProcessAlive(latest.workerPid))
    await terminateProcessTree(latest.workerPid, { timeoutMs: 500 });
  const current = await readJob(job.jobFile);
  if (current.status !== "cancelling") return;
  await updateJobRecord(current, {
    status: "cancelled",
    phase: "cancelled",
    cancelledAt: new Date().toISOString(),
    summary: "Cancelled after process-tree termination.",
  });
}

async function waitForCancelled(jobFile, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const latest = await readJob(jobFile);
    if (latest.status === "cancelled") return true;
    if (!ACTIVE_STATUSES.has(latest.status)) return false;
    await sleep(50);
  }
  return false;
}

function missingResult(result, selector) {
  return {
    ok: false,
    report: [`# Pi cancel`, `Job not found: ${selector}`, `Ledger: ${result.ledgerPath}`].join(
      "\n",
    ),
  };
}

function alreadyFinishedResult(job) {
  return { ok: true, job, report: renderCancelReport(job) };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function renderCancelReport(job) {
  return ["# Pi cancel", `Job: ${job.id}`, `Status: ${job.status}`, `Phase: ${job.phase}`].join(
    "\n",
  );
}

function renderCleanupReport(cancelled, ownerClaudeSessionId) {
  const lines = ["# Pi session cleanup", `Claude session: ${ownerClaudeSessionId ?? "unknown"}`];
  if (cancelled.length === 0) lines.push("No active Pi jobs matched this Claude session.");
  else lines.push(...cancelled.map((line) => `- ${line}`));
  return lines.join("\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
