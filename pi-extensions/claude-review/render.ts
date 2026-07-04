import { sanitizeClaudeLog } from "./claude-bg.js";
import type { ReviewLevel } from "./args.js";
import type { ClaudeReviewJob, ClaudeReviewJobStatus } from "./jobs.js";

export const CLAUDE_REVIEW_MESSAGE_TYPE = "claude-review";

export type ClaudeReviewDetailsStatus = ClaudeReviewJobStatus | "list";

export interface ClaudeReviewDetails {
  status: ClaudeReviewDetailsStatus;
  level: ReviewLevel;
  contextMessage: string;
  autoFix: boolean;
  stdout: string;
  stderr: string;
  exitCode?: number | null;
  jobId?: string;
  backend?: string;
  cwd?: string;
  claudeSessionId?: string;
  claudeSessionName?: string;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string | null;
  errorMessage?: string | null;
}

function statusTitle(status: ClaudeReviewDetailsStatus): string {
  switch (status) {
    case "queued":
      return "Claude Code review queued";
    case "starting":
      return "Claude Code review starting";
    case "running":
      return "Claude Code review running";
    case "blocked":
      return "Claude Code review needs input";
    case "review":
      return "Claude Code review";
    case "failed":
      return "Claude review failed";
    case "cancelled":
      return "Claude review cancelled";
    case "timeout":
      return "Claude review timed out";
    case "unknown":
      return "Claude review status unknown";
    case "list":
      return "Claude review jobs";
  }
}

function sanitizeDetails(details: ClaudeReviewDetails): ClaudeReviewDetails {
  return {
    ...details,
    stdout: sanitizeClaudeLog(details.stdout),
    stderr: sanitizeClaudeLog(details.stderr),
  };
}

export function renderClaudeReviewMarkdown(details: ClaudeReviewDetails): string {
  return renderSafeClaudeReviewMarkdown(sanitizeDetails(details));
}

function renderSafeClaudeReviewMarkdown(safeDetails: ClaudeReviewDetails): string {
  const autoFix = safeDetails.autoFix ? "on" : "off";
  const lines = [
    `# ${statusTitle(safeDetails.status)}`,
    "",
    `- Review level: \`${safeDetails.level}\``,
    `- Auto-fix: \`${autoFix}\``,
  ];

  if (safeDetails.jobId) {
    lines.push(`- Job: \`${safeDetails.jobId}\``);
  }
  if (safeDetails.status !== "list") {
    lines.push(`- Status: \`${safeDetails.status}\``);
  }
  if (safeDetails.claudeSessionId) {
    lines.push(`- Claude session: \`${safeDetails.claudeSessionId}\``);
  }
  if (safeDetails.claudeSessionName) {
    lines.push(`- Claude session name: \`${safeDetails.claudeSessionName}\``);
  }
  if (safeDetails.cwd) {
    lines.push(`- Working directory: \`${safeDetails.cwd}\``);
  }
  if (safeDetails.contextMessage) {
    lines.push(`- Review context: ${safeDetails.contextMessage}`);
  }
  if (safeDetails.startedAt) {
    lines.push(`- Started: \`${safeDetails.startedAt}\``);
  }
  if (safeDetails.completedAt) {
    lines.push(`- Completed: \`${safeDetails.completedAt}\``);
  }
  if (safeDetails.exitCode !== undefined && safeDetails.exitCode !== null) {
    lines.push(`- Exit code: \`${safeDetails.exitCode}\``);
  }
  if (safeDetails.errorMessage) {
    lines.push(`- Error: ${safeDetails.errorMessage}`);
  }

  if (["blocked", "running", "queued", "starting"].includes(safeDetails.status)) {
    lines.push(
      "",
      "## Next steps",
      "",
      safeDetails.jobId
        ? `- Check status: \`/claude-review-status ${safeDetails.jobId}\``
        : "- Check status with `/claude-review-status`.",
      safeDetails.jobId
        ? `- Fetch result: \`/claude-review-result ${safeDetails.jobId}\``
        : "- Fetch the result with `/claude-review-result`.",
    );
    if (safeDetails.claudeSessionId) {
      lines.push(`- Inspect or unblock manually: \`claude attach ${safeDetails.claudeSessionId}\``);
    }
  }

  lines.push("", "## Output", "", safeDetails.stdout.trim() || "_Claude returned no output._");

  if (safeDetails.stderr.trim()) {
    lines.push("", "## stderr", "", "```text", safeDetails.stderr.trim(), "```");
  }

  return lines.join("\n");
}

export function toClaudeReviewMessage(details: ClaudeReviewDetails) {
  const safeDetails = sanitizeDetails(details);
  return {
    customType: CLAUDE_REVIEW_MESSAGE_TYPE,
    content: renderSafeClaudeReviewMarkdown(safeDetails),
    display: true,
    details: safeDetails,
  };
}

export function jobToClaudeReviewDetails(
  job: ClaudeReviewJob,
  output = job.stdout,
): ClaudeReviewDetails {
  return {
    status: job.status,
    level: job.level,
    contextMessage: job.contextMessage,
    autoFix: job.autoFix,
    stdout: output,
    stderr: job.stderr,
    exitCode: job.exitCode,
    jobId: job.id,
    backend: job.backend,
    cwd: job.cwd,
    claudeSessionId: job.claudeSessionId,
    claudeSessionName: job.claudeSessionName,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
    errorMessage: job.errorMessage,
  };
}

export function buildJobsListDetails(
  jobs: ClaudeReviewJob[],
  cwd: string,
  all: boolean,
): ClaudeReviewDetails {
  const scope = all ? "all working directories" : `\`${cwd}\``;
  const output = jobs.length
    ? jobs
        .map((job) => {
          const session = job.claudeSessionId ? ` session=${job.claudeSessionId}` : "";
          return `- \`${job.id}\` ${job.status} level=${job.level}${session} started=${job.startedAt}`;
        })
        .join("\n")
    : `_No Claude review jobs found for ${scope}._`;

  return {
    status: "list",
    level: "medium",
    contextMessage: all ? "all working directories" : cwd,
    autoFix: false,
    stdout: output,
    stderr: "",
  };
}

export function buildAutoFixPrompt(details: ClaudeReviewDetails): string {
  const review =
    sanitizeClaudeLog(details.stdout).trim() || "Claude Code review completed with no output.";
  const context = details.contextMessage ? `\nReview context: ${details.contextMessage}` : "";
  const job = details.jobId ? `\nClaude review job: ${details.jobId}` : "";
  const header = `Claude Code review completed.\n\nReview level: ${details.level}${context}${job}`;

  return [
    header,
    "",
    "<CLAUDE_REVIEW>",
    review,
    "</CLAUDE_REVIEW>",
    "",
    "Act on this review now:",
    "- Fix correctness bugs and high-confidence cleanups.",
    "- Ignore speculative or unactionable findings.",
    "- Preserve existing scope; do not implement unrelated suggestions.",
    "- If Claude returned no findings or no output, make no implementation changes unless",
    "  you can independently identify an issue.",
    "- Run the relevant formatter, type checker, and focused tests.",
  ].join("\n");
}
