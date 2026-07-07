import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  distillComment,
  evaluateSettled,
  exitCodeFor,
  hoistSharedPreamble,
  REVIEW_QUERY,
  parseNitpicks,
  parsePrView,
  parseReviewData,
  renderFindings,
  renderStatus,
  unresolvedFindings,
  type Finding,
  type PrSnapshot,
} from "../pi-extensions/pr-watch/core.js";

const fixture = (name: string) => readFileSync(`tests/fixtures/pr-watch/${name}`, "utf8");

const coderabbitInline = fixture("coderabbit-inline-comment.md");
const codexInline = fixture("codex-inline-comment.md");
const coderabbitReviewBody = fixture("coderabbit-review-body.md");

function snapshotWith(overrides: Partial<PrSnapshot>): PrSnapshot {
  return {
    ...parsePrView(JSON.parse(fixture("pr-view.json"))),
    ...overrides,
  };
}

function findingWith(overrides: Partial<Finding>): Finding {
  return {
    path: "src/a.ts",
    line: "1",
    bot: "coderabbit",
    severity: "major",
    title: "A title",
    detail: "Shared preamble.\n\nSpecific fix instructions.",
    resolved: false,
    outdated: false,
    ...overrides,
  };
}

describe("REVIEW_QUERY", () => {
  it("paginates review threads for complete finding snapshots", () => {
    expect(REVIEW_QUERY).toContain("$reviewThreadsCursor: String");
    expect(REVIEW_QUERY).toContain("reviewThreads(first: 100, after: $reviewThreadsCursor)");
    expect(REVIEW_QUERY).toContain("hasNextPage");
    expect(REVIEW_QUERY).toContain("endCursor");
  });
});

describe("parsePrView", () => {
  it("parses a real gh pr view payload into a snapshot", () => {
    const snapshot = parsePrView(JSON.parse(fixture("pr-view.json")));
    expect(snapshot.number).toBe(63);
    expect(snapshot.owner).toBe("volker48");
    expect(snapshot.repo).toBe("agent-customization");
    expect(snapshot.headRefName).toBe("github-repo-orientation");
    expect(snapshot.headOid).toMatch(/^[0-9a-f]{40}$/);
    expect(snapshot.headCommittedAt).toMatch(/Z$/);
  });

  it("maps CheckRun and StatusContext entries to check states", () => {
    const snapshot = parsePrView(JSON.parse(fixture("pr-view.json")));
    expect(snapshot.checks).toHaveLength(3);
    expect(snapshot.checks.every((c) => c.state === "passed")).toBe(true);
    expect(snapshot.checks.map((c) => c.name)).toContain("CodeRabbit");
  });

  it("treats non-completed check runs and pending contexts as pending", () => {
    const raw = JSON.parse(fixture("pr-view.json"));
    raw.statusCheckRollup = [
      { __typename: "CheckRun", name: "build", status: "IN_PROGRESS", conclusion: null },
      { __typename: "StatusContext", context: "CodeRabbit", state: "PENDING" },
      { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "FAILURE" },
    ];
    const snapshot = parsePrView(raw);
    expect(snapshot.checks.map((c) => c.state)).toEqual(["pending", "pending", "failed"]);
  });
});

describe("distillComment for CodeRabbit", () => {
  it("extracts severity, title, and the Prompt-for-AI-Agents block", () => {
    const distilled = distillComment("coderabbitai[bot]", coderabbitInline);
    expect(distilled.severity).toBe("major");
    expect(distilled.title).toContain("active statuses");
    expect(distilled.detail).toContain("Consolidate the");
    expect(distilled.detail).toContain("ACTIVE_JOB_STATUSES");
  });

  it("drops HTML noise from the distilled detail", () => {
    const distilled = distillComment("coderabbitai[bot]", coderabbitInline);
    expect(distilled.detail).not.toContain("<details>");
    expect(distilled.detail).not.toContain("<!--");
    expect(distilled.detail).not.toContain("Committable suggestion");
    expect(distilled.detail).not.toContain("fingerprinting");
  });

  it("falls back to stripped prose when no prompt block exists", () => {
    const body =
      "_⚠️ Potential issue_ | _🔴 Critical_\n\n**Bad bug.**\n\nProse here.\n\n" +
      "<details><summary>x</summary>noise</details>\n<!-- meta -->";
    const distilled = distillComment("coderabbitai", body);
    expect(distilled.severity).toBe("critical");
    expect(distilled.title).toBe("Bad bug.");
    expect(distilled.detail).toContain("Prose here.");
    expect(distilled.detail).not.toContain("noise");
  });
});

describe("distillComment for Codex", () => {
  it("extracts the P-severity, badge-free title, and prose detail", () => {
    const distilled = distillComment("chatgpt-codex-connector[bot]", codexInline);
    expect(distilled.severity).toBe("P2");
    expect(distilled.title).toBe("Do not report cancelling review races as completed");
    expect(distilled.detail).toContain("executeReview");
    expect(distilled.detail).not.toContain("Badge");
    expect(distilled.detail).not.toContain("Useful? React");
  });
});

describe("parseNitpicks", () => {
  it("parses per-file nitpick entries from a real review body", () => {
    const nitpicks = parseNitpicks(coderabbitReviewBody, "coderabbit");
    expect(nitpicks).toHaveLength(2);
    expect(nitpicks[0].path).toBe("tests/claude-pi-jobs.test.ts");
    expect(nitpicks[0].line).toBe("42-54");
    expect(nitpicks[0].severity).toBe("trivial");
    expect(nitpicks[1].path).toBe("plugins/pi/scripts/lib/cancel.mjs");
    expect(nitpicks[1].detail).not.toContain("<details>");
  });

  it("returns nothing when the body has no nitpick section", () => {
    expect(parseNitpicks("**Actionable comments posted: 0**", "coderabbit")).toEqual([]);
  });
});

describe("parseReviewData", () => {
  const graphql = {
    data: {
      repository: {
        pullRequest: {
          reviews: {
            nodes: [
              {
                author: { login: "coderabbitai" },
                state: "COMMENTED",
                submittedAt: "2026-07-05T10:00:00Z",
                body: coderabbitReviewBody,
                commit: { oid: "abc123" },
              },
              {
                author: { login: "volker48" },
                state: "APPROVED",
                submittedAt: "2026-07-05T11:00:00Z",
                body: "",
                commit: null,
              },
            ],
          },
          reviewThreads: {
            nodes: [
              {
                isResolved: false,
                isOutdated: false,
                path: "plugins/pi/scripts/lib/jobs.mjs",
                line: 23,
                startLine: 16,
                comments: {
                  nodes: [{ author: { login: "coderabbitai" }, body: coderabbitInline }],
                },
              },
              {
                isResolved: true,
                isOutdated: false,
                path: "pi-extensions/claude-review/claude-bg.ts",
                line: 410,
                startLine: null,
                comments: {
                  nodes: [{ author: { login: "chatgpt-codex-connector" }, body: codexInline }],
                },
              },
              {
                isResolved: false,
                isOutdated: false,
                path: "README.md",
                line: 1,
                startLine: null,
                comments: { nodes: [{ author: { login: "volker48" }, body: "human comment" }] },
              },
            ],
          },
        },
      },
    },
  };

  it("keeps bot reviews with actionable counts and drops human reviews", () => {
    const data = parseReviewData(graphql, ["coderabbitai", "chatgpt-codex-connector"]);
    expect(data.botReviews).toHaveLength(1);
    expect(data.botReviews[0]).toMatchObject({
      bot: "coderabbit",
      actionable: 1,
      commitOid: "abc123",
    });
    expect(data.nitpicks).toHaveLength(2);
  });

  it("turns bot threads into findings with line ranges and skips human threads", () => {
    const data = parseReviewData(graphql, ["coderabbitai", "chatgpt-codex-connector"]);
    expect(data.findings).toHaveLength(2);
    expect(data.findings[0]).toMatchObject({
      path: "plugins/pi/scripts/lib/jobs.mjs",
      line: "16-23",
      bot: "coderabbit",
      severity: "major",
    });
    expect(data.findings[1]).toMatchObject({ bot: "codex", line: "410", resolved: true });
  });

  it("respects the configured bot list", () => {
    const data = parseReviewData(graphql, ["chatgpt-codex-connector"]);
    expect(data.botReviews).toHaveLength(0);
    expect(data.findings).toHaveLength(1);
    expect(data.findings[0].bot).toBe("codex");
  });
});

describe("hoistSharedPreamble", () => {
  it("hoists an identical first paragraph shared by all findings", () => {
    const findings = [findingWith({}), findingWith({ detail: "Shared preamble.\n\nOther fix." })];
    const { preamble, findings: hoisted } = hoistSharedPreamble(findings);
    expect(preamble).toBe("Shared preamble.");
    expect(hoisted[0].detail).toBe("Specific fix instructions.");
    expect(hoisted[1].detail).toBe("Other fix.");
  });

  it("hoists nothing when preambles differ or there is a single finding", () => {
    const differing = [findingWith({}), findingWith({ detail: "Different.\n\nFix." })];
    expect(hoistSharedPreamble(differing).preamble).toBeNull();
    expect(hoistSharedPreamble([findingWith({})]).preamble).toBeNull();
  });
});

describe("evaluateSettled", () => {
  const base = snapshotWith({
    state: "OPEN",
    headOid: "feedface".padEnd(40, "0"),
    headCommittedAt: "2026-07-06T12:00:00Z",
  });

  it("is not settled while any check is pending", () => {
    const snapshot = {
      ...base,
      checks: [{ name: "CodeRabbit", state: "pending" as const }],
      botReviews: [
        { bot: "coderabbit", submittedAt: "2026-07-06T13:00:00Z", commitOid: null, actionable: 0 },
      ],
    };
    expect(evaluateSettled(snapshot)).toMatchObject({ settled: false, checksPending: 1 });
  });

  it("requires a bot review at or after the head commit", () => {
    const stale = {
      ...base,
      botReviews: [
        { bot: "coderabbit", submittedAt: "2026-07-06T11:00:00Z", commitOid: "old", actionable: 0 },
      ],
    };
    expect(evaluateSettled(stale)).toMatchObject({ settled: false, reviewLanded: false });

    const byTime = {
      ...base,
      botReviews: [
        { bot: "coderabbit", submittedAt: "2026-07-06T12:30:00Z", commitOid: "old", actionable: 0 },
      ],
    };
    expect(evaluateSettled(byTime).settled).toBe(true);

    const byOid = {
      ...base,
      botReviews: [
        {
          bot: "codex",
          submittedAt: "2026-07-06T09:00:00Z",
          commitOid: base.headOid,
          actionable: null,
        },
      ],
    };
    expect(evaluateSettled(byOid).settled).toBe(true);
  });

  it("settles on checks alone with noReviews", () => {
    expect(evaluateSettled({ ...base, botReviews: [] }).settled).toBe(false);
    expect(evaluateSettled({ ...base, botReviews: [] }, { noReviews: true }).settled).toBe(true);
  });

  it("treats merged and closed PRs as settled so wait cannot hang", () => {
    const merged = {
      ...base,
      state: "MERGED",
      checks: [{ name: "ci", state: "pending" as const }],
      botReviews: [],
    };
    expect(evaluateSettled(merged).settled).toBe(true);
    expect(evaluateSettled({ ...merged, state: "CLOSED" }).settled).toBe(true);
  });
});

describe("exitCodeFor", () => {
  const settled = { settled: true, checksPending: 0, reviewLanded: true };

  it("maps snapshot state to the documented exit codes", () => {
    const clean = snapshotWith({});
    expect(exitCodeFor(clean, settled)).toBe(0);
    expect(exitCodeFor(clean, { ...settled, settled: false })).toBe(3);

    const withFindings = snapshotWith({ findings: [findingWith({})] });
    expect(exitCodeFor(withFindings, settled)).toBe(1);

    const failed = snapshotWith({ checks: [{ name: "ci", state: "failed" }] });
    expect(exitCodeFor(failed, settled)).toBe(2);

    const failedAndFindings = snapshotWith({
      checks: [{ name: "ci", state: "failed" }],
      findings: [findingWith({})],
    });
    expect(exitCodeFor(failedAndFindings, settled)).toBe(2);
  });

  it("ignores resolved and outdated findings", () => {
    const snapshot = snapshotWith({
      findings: [findingWith({ resolved: true }), findingWith({ outdated: true })],
    });
    expect(unresolvedFindings(snapshot)).toHaveLength(0);
    expect(exitCodeFor(snapshot, settled)).toBe(0);
  });
});

describe("rendering", () => {
  it("renders a status block ending in a machine-stable summary line", () => {
    const snapshot = snapshotWith({
      findings: [findingWith({})],
      botReviews: [
        {
          bot: "coderabbit",
          submittedAt: "2026-07-06T12:30:00Z",
          commitOid: "abc123",
          actionable: 1,
        },
      ],
    });
    const text = renderStatus(snapshot, { settled: true, checksPending: 0, reviewLanded: true });
    const lines = text.split("\n");
    expect(lines[0]).toContain("PR #63 github-repo-orientation → main [MERGED]");
    expect(lines.at(-1)).toBe("SETTLED findings=1 checks=3/3");
    expect(text).toContain("review coderabbit @abc123 actionable=1");
  });

  it("labels the summary line on timeout and reports check failures", () => {
    const snapshot = snapshotWith({ checks: [{ name: "ci", state: "failed" }] });
    const text = renderStatus(
      snapshot,
      { settled: false, checksPending: 0, reviewLanded: false },
      "TIMEOUT",
    );
    expect(text.split("\n").at(-1)).toBe("TIMEOUT findings=0 checks=0/1 failed=1");
  });

  it("renders findings with hoisted preamble and severity tags", () => {
    const findings = [
      findingWith({}),
      findingWith({
        path: "b.ts",
        line: "410",
        bot: "codex",
        severity: "P2",
        title: "Codex title",
        detail: "Shared preamble.\n\nCodex fix.",
      }),
    ];
    const text = renderFindings(findings, "findings");
    expect(text).toContain("findings (2):");
    expect(text).toContain("reviewer instruction: Shared preamble.");
    expect(text).toContain("1. src/a.ts:1 [coderabbit major]");
    expect(text).toContain("2. b.ts:410 [codex P2]");
    expect(text).toContain("   Codex fix.");
    expect(text.match(/Shared preamble\./g)).toHaveLength(1);
  });

  it("renders an explicit none marker for empty findings", () => {
    expect(renderFindings([], "findings")).toBe("findings: none");
  });
});
