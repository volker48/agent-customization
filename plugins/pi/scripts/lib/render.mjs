const ACTIVE_STATUSES = new Set(["queued", "running", "cancelling"]);

export function renderStatusReport({ jobs, ledgerPath, warnings = [] }) {
  const lines = ["# Pi jobs", `Ledger: ${ledgerPath}`];
  if (warnings.length > 0) lines.push("", ...warnings.map((warning) => `Warning: ${warning}`));
  if (jobs.length === 0) return [...lines, "", "No Pi jobs found for this workspace."].join("\n");

  lines.push(
    "",
    "| Job | Status | Phase | Model | Updated | Changed | Next |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const job of jobs) lines.push(statusRow(job));
  lines.push("", "Follow up: /pi:result latest or /pi:result <job-id>");
  return lines.join("\n");
}

export function renderResultReport({ job, selector, ledgerPath, warnings = [] }) {
  const lines = ["# Pi job result"];
  if (warnings.length > 0) lines.push(...warnings.map((warning) => `Warning: ${warning}`));
  if (!job) {
    lines.push(`Job not found: ${selector}`, `Ledger: ${ledgerPath}`);
    return lines.join("\n");
  }

  lines.push(
    `Job: ${job.id}`,
    `Kind: ${job.kind}`,
    `Status: ${job.status}`,
    `Phase: ${job.phase}`,
    `Model: ${job.model ?? "unknown"}`,
    `Created: ${job.createdAt ?? "unknown"}`,
    `Updated: ${job.updatedAt ?? "unknown"}`,
    `Completed: ${job.completedAt ?? "not completed"}`,
    `Session: ${job.sessionId ?? "unknown"}`,
    `Session file: ${job.piSessionFile ?? "unknown"}`,
    `Log: ${job.logFile ?? "unknown"}`,
    "",
    "## Summary",
    job.summary || "No summary recorded.",
    "",
    "## Changed files",
    ...listLines(job.changedFiles, "No changed files recorded."),
    "",
    "## Test evidence",
    ...testLines(job.testsRun),
    "",
    "## Final output",
    finalOutput(job),
  );
  return lines.join("\n");
}

function statusRow(job) {
  return [
    job.id,
    job.status,
    job.phase,
    job.model ?? "unknown",
    job.updatedAt ?? "unknown",
    String(job.changedFiles?.length ?? 0),
    followUpCommand(job),
  ]
    .map(escapeCell)
    .join(" | ")
    .replace(/^/, "| ")
    .replace(/$/, " |");
}

function followUpCommand(job) {
  const command = `/pi:result ${job.id}`;
  return ACTIVE_STATUSES.has(job.status) ? `${command} (running)` : command;
}

function listLines(values, empty) {
  if (!Array.isArray(values) || values.length === 0) return [empty];
  return values.map((value) => `- ${value}`);
}

function testLines(tests) {
  if (!Array.isArray(tests) || tests.length === 0) return ["No test evidence recorded."];
  return tests.map((test) => {
    if (typeof test === "string") return `- ${test}`;
    const command = test.command ?? "unknown command";
    const status = test.status ?? "unknown";
    return `- ${command}: ${status}`;
  });
}

function finalOutput(job) {
  if (job.result) return job.result;
  if (job.errorMessage) return `Error: ${job.errorMessage}`;
  return "No final output recorded.";
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}
