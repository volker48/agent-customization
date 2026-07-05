export const DEFAULT_REVIEW_LEVEL = "medium";
export const REVIEW_LEVELS = ["low", "medium", "high", "max"] as const;
export const CLAUDE_REVIEW_HAS_FINDINGS_START = "<CLAUDE_REVIEW_HAS_FINDINGS>";
export const CLAUDE_REVIEW_HAS_FINDINGS_END = "</CLAUDE_REVIEW_HAS_FINDINGS>";
export const CLAUDE_REVIEW_RESULT_START = "<CLAUDE_REVIEW_RESULT>";
export const CLAUDE_REVIEW_RESULT_END = "</CLAUDE_REVIEW_RESULT>";

export type ReviewLevel = (typeof REVIEW_LEVELS)[number];
export type ClaudeReviewMode = "background" | "wait";

export interface ClaudeReviewOptions {
  autoFix: boolean;
  level: ReviewLevel;
  contextMessage: string;
  mode: ClaudeReviewMode;
}

export interface ClaudeReviewResultArgs {
  jobId?: string;
  fix?: boolean;
}

export interface ClaudeReviewJobArgs {
  all: boolean;
  jobId?: string;
}

const LEVELS = new Set<string>(REVIEW_LEVELS);

function tokenize(args: string): string[] {
  return args.trim().split(/\s+/).filter(Boolean);
}

export function parseClaudeReviewArgs(args: string): ClaudeReviewOptions {
  const tokens = tokenize(args);
  const remaining: string[] = [];
  let autoFix = true;
  let mode: ClaudeReviewMode | undefined;

  for (const token of tokens) {
    if (token === "--no-fix") {
      autoFix = false;
      continue;
    }
    if (token === "--fix") {
      autoFix = true;
      continue;
    }
    if (token === "--wait") {
      if (mode === "background") {
        throw new Error("Use either --wait or --background, not both");
      }
      mode = "wait";
      continue;
    }
    if (token === "--background" || token === "--bg") {
      if (mode === "wait") {
        throw new Error("Use either --wait or --background, not both");
      }
      mode = "background";
      continue;
    }
    if (token.startsWith("--")) {
      throw new Error(`Unknown option: ${token}`);
    }
    remaining.push(token);
  }

  let level: ReviewLevel = DEFAULT_REVIEW_LEVEL;
  if (remaining[0] === "ultra") {
    throw new Error("Review level 'ultra' is not supported in headless Claude review runs");
  }
  if (remaining[0] && LEVELS.has(remaining[0])) {
    level = remaining.shift() as ReviewLevel;
  }

  return {
    autoFix,
    level,
    contextMessage: remaining.join(" "),
    mode: mode ?? "background",
  };
}

export function parseClaudeReviewResultArgs(args: string): ClaudeReviewResultArgs {
  const tokens = tokenize(args);
  let fix: boolean | undefined;
  const remaining: string[] = [];

  for (const token of tokens) {
    if (token === "--fix") {
      fix = true;
      continue;
    }
    if (token === "--no-fix") {
      fix = false;
      continue;
    }
    if (token.startsWith("--")) {
      throw new Error(`Unknown option: ${token}`);
    }
    remaining.push(token);
  }

  if (remaining.length > 1) {
    throw new Error("Expected at most one Claude review job id");
  }

  return { fix, jobId: remaining[0] };
}

export function parseClaudeReviewJobArgs(args: string): ClaudeReviewJobArgs {
  const tokens = tokenize(args);
  const remaining: string[] = [];
  let all = false;

  for (const token of tokens) {
    if (token === "--all") {
      all = true;
      continue;
    }
    if (token.startsWith("--")) {
      throw new Error(`Unknown option: ${token}`);
    }
    remaining.push(token);
  }

  if (remaining.length > 1) {
    throw new Error("Expected at most one Claude review job id");
  }

  return { all, jobId: remaining[0] };
}

export function buildCodeReviewPrompt(
  options: Pick<ClaudeReviewOptions, "contextMessage" | "level">,
  format: { resultMarkers?: boolean } = {},
): string {
  const suffix = options.contextMessage ? ` ${options.contextMessage}` : "";
  const prompt = `/code-review ${options.level}${suffix}`;

  if (!format.resultMarkers) {
    return prompt;
  }

  return [
    prompt,
    "",
    "When you finish, print these exact machine-readable tags so another process can retrieve the result later:",
    "Set the findings value to true only when the review includes at least one actionable finding; otherwise set it to false.",
    CLAUDE_REVIEW_HAS_FINDINGS_START,
    "true|false",
    CLAUDE_REVIEW_HAS_FINDINGS_END,
    CLAUDE_REVIEW_RESULT_START,
    "<your concise, actionable review or no-findings summary>",
    CLAUDE_REVIEW_RESULT_END,
  ].join("\n");
}
