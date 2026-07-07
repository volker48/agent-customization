/**
 * pr-watch core: pure parsing, settledness evaluation, and rendering.
 *
 * Consumes JSON produced by `gh pr view --json ...` and the GraphQL review query,
 * and distills bot review threads into token-efficient plain text (see ADR-0005).
 * No I/O lives here; `cli.ts` owns process and `gh` concerns.
 */

export type CheckState = "pending" | "passed" | "failed" | "skipped";

export type PrCheck = {
  name: string;
  state: CheckState;
};

export type BotReview = {
  bot: string;
  submittedAt: string;
  commitOid: string | null;
  actionable: number | null;
};

export type Finding = {
  path: string;
  line: string;
  bot: string;
  severity: string | null;
  title: string;
  detail: string;
  resolved: boolean;
  outdated: boolean;
};

export type PrSnapshot = {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  headOid: string;
  headCommittedAt: string | null;
  owner: string;
  repo: string;
  checks: PrCheck[];
  botReviews: BotReview[];
  findings: Finding[];
};

export type SettleOptions = {
  noReviews?: boolean;
};

export type SettleResult = {
  settled: boolean;
  checksPending: number;
  reviewLanded: boolean;
};

export const DEFAULT_BOTS = ["coderabbitai", "chatgpt-codex-connector"];

const BOT_SHORT_NAMES: Record<string, string> = {
  coderabbitai: "coderabbit",
  "chatgpt-codex-connector": "codex",
};

export const REVIEW_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviews(last: 50) {
        nodes {
          author { login }
          state
          submittedAt
          body
          commit { oid }
        }
      }
      reviewThreads(first: 100) {
        nodes {
          isResolved
          isOutdated
          path
          line
          startLine
          comments(first: 5) {
            nodes {
              author { login }
              body
            }
          }
        }
      }
    }
  }
}
`.trim();

export function normalizeBotLogin(login: string): string {
  return login.replace(/\[bot\]$/, "");
}

export function botShortName(login: string): string {
  const normalized = normalizeBotLogin(login);
  return BOT_SHORT_NAMES[normalized] ?? normalized;
}

function checkRunState(status: string, conclusion: string | null): CheckState {
  if (status !== "COMPLETED") return "pending";
  if (conclusion === "SUCCESS" || conclusion === "NEUTRAL") return "passed";
  if (conclusion === "SKIPPED") return "skipped";
  return "failed";
}

function statusContextState(state: string): CheckState {
  if (state === "SUCCESS") return "passed";
  if (state === "PENDING" || state === "EXPECTED") return "pending";
  return "failed";
}

type GhCheck = {
  __typename: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string | null;
  state?: string;
};

type GhPrView = {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  url: string;
  statusCheckRollup: GhCheck[] | null;
  commits: Array<{ oid: string; committedDate: string }>;
};

/** Parse `gh pr view --json` output into the snapshot skeleton (no reviews/findings yet). */
export function parsePrView(raw: unknown): PrSnapshot {
  const v = raw as GhPrView;
  const match = /github\.com\/([^/]+)\/([^/]+)\/pull\//.exec(v.url ?? "");
  if (!match) {
    throw new Error(`cannot derive owner/repo from PR url: ${v.url}`);
  }
  const lastCommit = v.commits?.at(-1);
  const checks = (v.statusCheckRollup ?? []).map((c): PrCheck => {
    if (c.__typename === "StatusContext") {
      return { name: c.context ?? "unknown", state: statusContextState(c.state ?? "") };
    }
    return {
      name: c.name ?? "unknown",
      state: checkRunState(c.status ?? "", c.conclusion ?? null),
    };
  });
  return {
    number: v.number,
    title: v.title,
    state: v.state,
    isDraft: v.isDraft,
    headRefName: v.headRefName,
    baseRefName: v.baseRefName,
    headOid: v.headRefOid,
    headCommittedAt: lastCommit?.committedDate ?? null,
    owner: match[1],
    repo: match[2],
    checks,
    botReviews: [],
    findings: [],
  };
}

type GraphqlReviewData = {
  repository: {
    pullRequest: {
      reviews: {
        nodes: Array<{
          author: { login: string } | null;
          state: string;
          submittedAt: string;
          body: string;
          commit: { oid: string } | null;
        }>;
      };
      reviewThreads: {
        nodes: Array<{
          isResolved: boolean;
          isOutdated: boolean;
          path: string;
          line: number | null;
          startLine: number | null;
          comments: { nodes: Array<{ author: { login: string } | null; body: string }> };
        }>;
      };
    };
  };
};

export type ReviewData = {
  botReviews: BotReview[];
  findings: Finding[];
  nitpicks: Finding[];
};

/** Parse the GraphQL review query response into bot reviews, thread findings, and nitpicks. */
export function parseReviewData(raw: unknown, bots: string[]): ReviewData {
  const pr = (raw as { data: GraphqlReviewData }).data.repository.pullRequest;
  const botSet = new Set(bots.map(normalizeBotLogin));
  const botReviews: BotReview[] = [];
  const nitpicks: Finding[] = [];
  for (const review of pr.reviews.nodes) {
    const login = normalizeBotLogin(review.author?.login ?? "");
    if (!botSet.has(login)) continue;
    botReviews.push({
      bot: botShortName(login),
      submittedAt: review.submittedAt,
      commitOid: review.commit?.oid ?? null,
      actionable: parseActionableCount(review.body),
    });
    nitpicks.push(...parseNitpicks(review.body, botShortName(login)));
  }
  const findings = pr.reviewThreads.nodes.flatMap((thread) => {
    const first = thread.comments.nodes[0];
    if (!first) return [];
    const login = normalizeBotLogin(first.author?.login ?? "");
    if (!botSet.has(login)) return [];
    const distilled = distillComment(login, first.body);
    return [
      {
        path: thread.path,
        line: formatLineRange(thread.startLine, thread.line),
        bot: botShortName(login),
        severity: distilled.severity,
        title: distilled.title,
        detail: distilled.detail,
        resolved: thread.isResolved,
        outdated: thread.isOutdated,
      },
    ];
  });
  return { botReviews, findings, nitpicks };
}

function formatLineRange(startLine: number | null, line: number | null): string {
  if (startLine != null && line != null && startLine !== line) return `${startLine}-${line}`;
  if (line != null) return String(line);
  return "?";
}

function parseActionableCount(body: string): number | null {
  const match = /\*\*Actionable comments posted: (\d+)\*\*/.exec(body);
  return match ? Number(match[1]) : null;
}

type Distilled = {
  severity: string | null;
  title: string;
  detail: string;
};

export function distillComment(login: string, body: string): Distilled {
  const normalized = normalizeBotLogin(login);
  if (normalized === "coderabbitai") return distillCodeRabbit(body);
  if (normalized === "chatgpt-codex-connector") return distillCodex(body);
  return { severity: null, title: firstProseLine(body), detail: stripNoise(body) };
}

// Not \b: the words sit inside markdown italics (`_🟠 Major_`) and `_` is a word character.
const SEVERITY_WORDS = /(?<![a-z])(critical|major|minor|trivial)(?![a-z])/i;

function distillCodeRabbit(body: string): Distilled {
  const headerMatch = /^[ \t]*_[^_\n]+_(?: \| _[^_\n]+_)+/m.exec(body);
  let severity: string | null = null;
  if (headerMatch) {
    for (const segment of headerMatch[0].split("|")) {
      const word = SEVERITY_WORDS.exec(segment);
      if (word) severity = word[1].toLowerCase();
    }
  }
  const title = /^\*\*(.+?)\*\*$/m.exec(body)?.[1] ?? firstProseLine(body);
  const prompt = extractAgentPrompt(body);
  const detail = prompt ?? stripNoise(stripAfterFirstDetails(body));
  return { severity, title, detail };
}

function distillCodex(body: string): Distilled {
  const severity = /!\[P(\d) Badge\]/.exec(body)?.[1];
  const titleLine = /^\*\*(.+?)\*\*$/m.exec(body)?.[1] ?? "";
  const title = titleLine
    .replace(/<sub>|<\/sub>/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .trim();
  const detail = stripNoise(body)
    .split("\n")
    .filter((line) => !line.startsWith("**") && !line.startsWith("Useful? React with"))
    .join("\n")
    .trim();
  return {
    severity: severity ? `P${severity}` : null,
    title: title || firstProseLine(body),
    detail,
  };
}

function extractAgentPrompt(body: string): string | null {
  const marker = body.indexOf("Prompt for AI Agents</summary>");
  if (marker === -1) return null;
  const fence = /```[^\n]*\n([\s\S]*?)```/.exec(body.slice(marker));
  return fence ? fence[1].trim() : null;
}

/** CodeRabbit prose precedes the first `<details>` block (suggestions, prompts, metadata). */
function stripAfterFirstDetails(body: string): string {
  const index = body.indexOf("<details>");
  return index === -1 ? body : body.slice(0, index);
}

export function stripNoise(body: string): string {
  let text = body;
  let previous: string;
  do {
    previous = text;
    text = text.replace(/<details\b(?:(?!<details\b)[\s\S])*?<\/details>/g, "");
  } while (text !== previous);
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?(?:sub|blockquote|summary|br)\s*\/?>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function firstProseLine(body: string): string {
  for (const line of stripNoise(body).split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed.replace(/^\*\*|\*\*$/g, "");
  }
  return "(no title)";
}

/**
 * Parse review-body nitpicks: entries shaped `` `42-54`: _category_ | _severity_ ... `` nested in
 * per-file `<details>` blocks inside the `🧹 Nitpick comments` section.
 */
export function parseNitpicks(reviewBody: string, bot: string): Finding[] {
  const section = /<summary>🧹 Nitpick comments[\s\S]*/.exec(reviewBody);
  if (!section) return [];
  const findings: Finding[] = [];
  const filePattern = /<summary>([^<(]+?) \(\d+\)<\/summary>/g;
  const fileMatches = [...section[0].matchAll(filePattern)];
  for (const [index, fileMatch] of fileMatches.entries()) {
    const start = (fileMatch.index ?? 0) + fileMatch[0].length;
    const end = fileMatches[index + 1]?.index ?? section[0].length;
    const block = section[0].slice(start, end);
    findings.push(...parseNitpickEntries(block, fileMatch[1].trim(), bot));
  }
  return findings;
}

function parseNitpickEntries(block: string, path: string, bot: string): Finding[] {
  const entryPattern = /`(\d+(?:-\d+)?)`:/g;
  const entries = [...block.matchAll(entryPattern)];
  return entries.map((entry, index) => {
    const start = (entry.index ?? 0) + entry[0].length;
    const end = entries[index + 1]?.index ?? block.length;
    const body = block.slice(start, end);
    const distilled = distillCodeRabbit(body);
    return {
      path,
      line: entry[1],
      bot,
      severity: distilled.severity,
      title: distilled.title,
      detail: distilled.detail,
      resolved: false,
      outdated: false,
    };
  });
}

/**
 * When every finding's detail opens with the same paragraph (CodeRabbit repeats the configured
 * reviewer instruction per prompt block), hoist it so it prints once instead of N times.
 */
export function hoistSharedPreamble(findings: Finding[]): {
  preamble: string | null;
  findings: Finding[];
} {
  if (findings.length < 2) return { preamble: null, findings };
  const splits = findings.map((f) => {
    const index = f.detail.indexOf("\n\n");
    return index === -1
      ? { head: null, rest: f.detail }
      : { head: f.detail.slice(0, index).trim(), rest: f.detail.slice(index + 2).trim() };
  });
  const first = splits[0].head;
  if (!first || !splits.every((s) => s.head === first)) return { preamble: null, findings };
  return {
    preamble: first,
    findings: findings.map((f, i) => ({ ...f, detail: splits[i].rest })),
  };
}

export function evaluateSettled(snapshot: PrSnapshot, opts: SettleOptions = {}): SettleResult {
  const checksPending = snapshot.checks.filter((c) => c.state === "pending").length;
  const reviewLanded = snapshot.botReviews.some(
    (r) =>
      r.commitOid === snapshot.headOid ||
      (snapshot.headCommittedAt != null && r.submittedAt >= snapshot.headCommittedAt),
  );
  // A merged/closed PR will never receive new checks or reviews; waiting on it must not hang.
  const terminal = snapshot.state !== "OPEN";
  const settled = terminal || (checksPending === 0 && (reviewLanded || opts.noReviews === true));
  return { settled, checksPending, reviewLanded };
}

export function unresolvedFindings(snapshot: PrSnapshot): Finding[] {
  return snapshot.findings.filter((f) => !f.resolved && !f.outdated);
}

export function exitCodeFor(snapshot: PrSnapshot, settle: SettleResult): number {
  if (!settle.settled) return 3;
  if (snapshot.checks.some((c) => c.state === "failed")) return 2;
  if (unresolvedFindings(snapshot).length > 0) return 1;
  return 0;
}

function summaryLine(snapshot: PrSnapshot, settle: SettleResult, label?: string): string {
  const passed = snapshot.checks.filter((c) => c.state === "passed").length;
  const failed = snapshot.checks.filter((c) => c.state === "failed").length;
  const state = label ?? (settle.settled ? "SETTLED" : "PENDING");
  const parts = [
    state,
    `findings=${unresolvedFindings(snapshot).length}`,
    `checks=${passed}/${snapshot.checks.length}`,
  ];
  if (failed > 0) parts.push(`failed=${failed}`);
  return parts.join(" ");
}

export function renderStatus(snapshot: PrSnapshot, settle: SettleResult, label?: string): string {
  const lines: string[] = [];
  const draft = snapshot.isDraft ? " DRAFT" : "";
  lines.push(
    `PR #${snapshot.number} ${snapshot.headRefName} → ${snapshot.baseRefName}` +
      ` [${snapshot.state}${draft}] ${snapshot.title}`,
  );
  lines.push(`head ${snapshot.headOid.slice(0, 8)}`);
  for (const check of snapshot.checks) {
    lines.push(`check ${check.state.padEnd(7)} ${check.name}`);
  }
  if (snapshot.botReviews.length === 0) {
    lines.push("reviews (none from bots)");
  }
  for (const review of snapshot.botReviews) {
    const oid = review.commitOid ? `@${review.commitOid.slice(0, 8)}` : "";
    const actionable = review.actionable != null ? ` actionable=${review.actionable}` : "";
    lines.push(`review ${review.bot} ${oid}${actionable} at ${review.submittedAt}`);
  }
  lines.push(summaryLine(snapshot, settle, label));
  return lines.join("\n");
}

export function renderFindings(findings: Finding[], heading: string): string {
  if (findings.length === 0) return `${heading}: none`;
  const { preamble, findings: hoisted } = hoistSharedPreamble(findings);
  const lines: string[] = [`${heading} (${findings.length}):`];
  if (preamble) lines.push("", `reviewer instruction: ${preamble.replace(/\n/g, " ")}`);
  for (const [index, finding] of hoisted.entries()) {
    const severity = finding.severity ? ` ${finding.severity}` : "";
    const flags = [finding.resolved ? "resolved" : "", finding.outdated ? "outdated" : ""]
      .filter(Boolean)
      .join(",");
    const suffix = flags ? ` (${flags})` : "";
    lines.push(
      "",
      `${index + 1}. ${finding.path}:${finding.line} [${finding.bot}${severity}]${suffix}`,
    );
    lines.push(`   ${finding.title}`);
    for (const detailLine of finding.detail.split("\n")) {
      lines.push(`   ${detailLine}`.trimEnd());
    }
  }
  return lines.join("\n");
}
