export const DEFAULT_REVIEW_LEVEL = "medium";
export const REVIEW_LEVELS = ["low", "medium", "high", "max"] as const;

export type ReviewLevel = (typeof REVIEW_LEVELS)[number];

export interface ClaudeReviewOptions {
  autoFix: boolean;
  level: ReviewLevel;
  contextMessage: string;
}

const LEVELS = new Set<string>(REVIEW_LEVELS);

export function parseClaudeReviewArgs(args: string): ClaudeReviewOptions {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const remaining: string[] = [];
  let autoFix = true;

  for (const token of tokens) {
    if (token === "--no-fix") {
      autoFix = false;
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
  };
}

export function buildCodeReviewPrompt(options: ClaudeReviewOptions): string {
  const suffix = options.contextMessage ? ` ${options.contextMessage}` : "";
  return `/code-review ${options.level}${suffix}`;
}
