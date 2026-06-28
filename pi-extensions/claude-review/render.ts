import type { ReviewLevel } from "./args.js";

export const CLAUDE_REVIEW_MESSAGE_TYPE = "claude-review";

export interface ClaudeReviewDetails {
  status: "review" | "failed" | "timeout";
  level: ReviewLevel;
  contextMessage: string;
  autoFix: boolean;
  stdout: string;
  stderr: string;
  exitCode?: number;
}

export function renderClaudeReviewMarkdown(details: ClaudeReviewDetails): string {
  const title = details.status === "review" ? "Claude Code review" : "Claude review failed";
  const autoFix = details.autoFix ? "on" : "off";
  const lines = [
    `# ${title}`,
    "",
    `- Review level: \`${details.level}\``,
    `- Auto-fix: \`${autoFix}\``,
  ];

  if (details.contextMessage) {
    lines.push(`- Review context: ${details.contextMessage}`);
  }
  if (details.exitCode !== undefined) {
    lines.push(`- Exit code: \`${details.exitCode}\``);
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

export function buildAutoFixPrompt(details: ClaudeReviewDetails): string {
  const review = details.stdout.trim() || "Claude Code review completed with no output.";
  const context = details.contextMessage ? `\nReview context: ${details.contextMessage}` : "";
  const header = `Claude Code review completed.\n\nReview level: ${details.level}${context}`;

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
