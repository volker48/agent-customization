import { findJob, listJobs } from "./jobs.mjs";
import { renderResultReport, renderStatusReport } from "./render.mjs";

export async function runStatus(options = {}) {
  const result = await listJobs(options);
  return {
    ok: true,
    ...result,
    report: renderStatusReport(result),
  };
}

export async function runResult(selector = "latest", options = {}) {
  const result = await findJob(selector, options);
  return {
    ok: Boolean(result.job),
    ...result,
    selector,
    report: renderResultReport({ ...result, selector }),
  };
}
