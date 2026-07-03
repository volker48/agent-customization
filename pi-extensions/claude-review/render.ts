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

export function renderClaudeReviewMarkdown(details: ClaudeReviewDetails): string {
  const autoFix = details.autoFix ? "on" : "off";
  const lines = [
    `# ${statusTitle(details.status)}`,
    "",
    `- Review level: \`${details.level}\``,
    `- Auto-fix: \`${autoFix}\``,
  ];

  if (details.jobId) {
    lines.push(`- Job: \`${details.jobId}\``);
  }
  if (details.status !== "list") {
    lines.push(`- Status: \`${details.status}\``);
  }
  if (details.claudeSessionId) {
    lines.push(`- Claude session: \`${details.claudeSessionId}\``);
  }
  if (details.claudeSessionName) {
    lines.push(`- Claude session name: \`${details.claudeSessionName}\``);
  }
  if (details.cwd) {
    lines.push(`- Working directory: \`${details.cwd}\``);
  }
  if (details.contextMessage) {
    lines.push(`- Review context: ${details.contextMessage}`);
  }
  if (details.startedAt) {
    lines.push(`- Started: \`${details.startedAt}\``);
  }
  if (details.completedAt) {
    lines.push(`- Completed: \`${details.completedAt}\``);
  }
  if (details.exitCode !== undefined && details.exitCode !== null) {
    lines.push(`- Exit code: \`${details.exitCode}\``);
  }
  if (details.errorMessage) {
    lines.push(`- Error: ${details.errorMessage}`);
  }

  if (["blocked", "running", "queued", "starting"].includes(details.status)) {
    lines.push(
      "",
      "## Next steps",
      "",
      details.jobId
        ? `- Check status: \`/claude-review-status ${details.jobId}\``
        : "- Check status with `/claude-review-status`.",
      details.jobId
        ? `- Fetch result: \`/claude-review-result ${details.jobId}\``
        : "- Fetch the result with `/claude-review-result`.",
    );
    if (details.claudeSessionId) {
      lines.push(`- Inspect or unblock manually: \`claude attach ${details.claudeSessionId}\``);
    }
  }

  lines.push("", "## Output", "", details.stdout.trim() || "_Claude returned no output._");

  if (details.stderr.trim()) {
    lines.push("", "## stderr", "", "```text", details.stderr.trim(), "```");
  }

  return lines.join("\n");
}

export function toClaudeReviewMessage(details: ClaudeReviewDetails) {
  return {
    customType: CLAUDE_REVIEW_MESSAGE_TYPE,
    content: renderClaudeReviewMarkdown(details),
    display: true,
    details,
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
  const review = details.stdout.trim() || "Claude Code review completed with no output.";
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
