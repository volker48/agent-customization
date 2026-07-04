import { appendJobLog, findJob, listJobs, readJob, updateJobRecord } from "./jobs.mjs";
import { isProcessAlive, terminateProcessTree } from "./process-tree.mjs";

const ACTIVE_STATUSES = new Set(["queued", "running", "cancelling"]);
const DEFAULT_CANCEL_TIMEOUT_MS = 2_000;

export async function runCancel(selector = "latest", options = {}) {
  const result = await findJob(selector, options);
  if (!result.job) return missingResult(result, selector);
  const job = result.job;
  if (!ACTIVE_STATUSES.has(job.status)) return alreadyFinishedResult(job);
  await updateJobRecord(job, { status: "cancelling", phase: "cancelling" });
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
  const result = await listJobs({ ...options, limit: Number.POSITIVE_INFINITY });
  const cancelled = [];
  for (const job of result.jobs.filter((candidate) => ACTIVE_STATUSES.has(candidate.status))) {
    const outcome = await runCancel(job.id, options);
    cancelled.push(`${job.id}: ${outcome.job.status}`);
  }
  return {
    ok: true,
    cancelled,
    report: ["# Pi session cleanup", ...cancelled.map((line) => `- ${line}`)].join("\n"),
  };
}

async function killActiveProcesses(job) {
  const latest = await readJob(job.jobFile);
  await appendJobLog(latest, "cancel-timeout-kill", {
    piPid: latest.piPid,
    workerPid: latest.workerPid,
  });
  if (isProcessAlive(latest.piPid)) await terminateProcessTree(latest.piPid, { timeoutMs: 500 });
  if (isProcessAlive(latest.workerPid))
    await terminateProcessTree(latest.workerPid, { timeoutMs: 500 });
  await updateJobRecord(latest, {
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

function renderCancelReport(job) {
  return ["# Pi cancel", `Job: ${job.id}`, `Status: ${job.status}`, `Phase: ${job.phase}`].join(
    "\n",
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
