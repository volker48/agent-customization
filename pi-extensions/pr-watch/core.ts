/**
 * pr-watch core: normalized PR types, settledness evaluation, finding selection, and rendering.
 *
 * No forge I/O or bot-specific comment parsing lives here. Forge providers normalize raw CLI/API
 * data into these types, and bot adapters provide display names, check aliases, and distillation.
 */

import { adaptersForBots, adapterForLogin } from "./bots.js";

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

export type ReviewThread = {
  path: string;
  line: number | null;
  startLine: number | null;
  author: string;
  body: string;
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

export type ReviewData = {
  botReviews: BotReview[];
  findings: Finding[];
  nitpicks: Finding[];
};

export type SettleOptions = {
  noReviews?: boolean;
  bots?: string[];
};

export type SettleResult = {
  settled: boolean;
  checksPending: number;
  reviewLanded: boolean;
};

export { DEFAULT_BOTS } from "./bots.js";

export function formatLineRange(startLine: number | null, line: number | null): string {
  if (startLine != null && line != null && startLine !== line) return `${startLine}-${line}`;
  if (line != null) return String(line);
  return "?";
}

export function findingFromThread(thread: ReviewThread, bots: string[]): Finding | null {
  const adapter = adapterForLogin(thread.author, bots);
  if (!adapter) return null;
  const distilled = adapter.distill(thread.body);
  return {
    path: thread.path,
    line: formatLineRange(thread.startLine, thread.line),
    bot: adapter.shortName,
    severity: distilled.severity,
    title: distilled.title,
    detail: distilled.detail,
    resolved: thread.resolved,
    outdated: thread.outdated,
  };
}

export function findingsFromThreads(threads: ReviewThread[], bots: string[]): Finding[] {
  return threads.flatMap((thread) => findingFromThread(thread, bots) ?? []);
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

function botCheckLanded(snapshot: PrSnapshot, bots: string[]): boolean {
  const names = new Set(
    adaptersForBots(bots).flatMap((adapter) =>
      adapter.checkNames.map((name) => name.toLowerCase()),
    ),
  );
  return snapshot.checks.some((c) => c.state !== "pending" && names.has(c.name.toLowerCase()));
}

export function evaluateSettled(snapshot: PrSnapshot, opts: SettleOptions = {}): SettleResult {
  const checksPending = snapshot.checks.filter((c) => c.state === "pending").length;
  const reviewLanded =
    snapshot.botReviews.some(
      (r) =>
        r.commitOid === snapshot.headOid ||
        (snapshot.headCommittedAt != null && r.submittedAt >= snapshot.headCommittedAt),
    ) || botCheckLanded(snapshot, opts.bots ?? []);
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
