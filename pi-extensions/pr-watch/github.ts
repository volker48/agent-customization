import {
  findingsFromThreads,
  type PrCheck,
  type PrSnapshot,
  type ReviewData,
  type ReviewThread,
} from "./core.js";
import { paginationFailure, parseJsonFailure, runJson, type ForgeProvider } from "./forge.js";
import { adapterForLogin } from "./bots.js";

export const REVIEW_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $reviewThreadsCursor: String) {
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
      reviewThreads(first: 100, after: $reviewThreadsCursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
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

const PR_VIEW_FIELDS = [
  "number",
  "title",
  "state",
  "isDraft",
  "headRefName",
  "baseRefName",
  "headRefOid",
  "statusCheckRollup",
  "commits",
  "url",
];

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
        pageInfo: {
          hasNextPage: boolean;
          endCursor: string | null;
        };
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

type ReviewQueryResponse = {
  data: GraphqlReviewData;
};

export function createGitHubProvider(): ForgeProvider {
  return {
    name: "github",
    fetchSnapshot(opts) {
      const snapshot = parsePrViewJson(runJson("gh", prViewArgs(opts), "gh pr view"));
      const reviews = fetchReviewData(snapshot, opts.bots);
      return {
        ...snapshot,
        botReviews: reviews.botReviews,
        findings: opts.nitpicks ? [...reviews.findings, ...reviews.nitpicks] : reviews.findings,
      };
    },
  };
}

/** Parse `gh pr view --json` output into the snapshot skeleton (no reviews/findings yet). */
export function parsePrView(raw: unknown): PrSnapshot {
  const v = raw as GhPrView;
  const match = /github\.com\/([^/]+)\/([^/]+)\/pull\//.exec(v.url ?? "");
  if (!match) {
    throw new Error(`cannot derive owner/repo from PR url: ${v.url}`);
  }
  const lastCommit = v.commits?.at(-1);
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
    checks: parseGitHubChecks(v.statusCheckRollup ?? []),
    botReviews: [],
    findings: [],
  };
}

/** Parse the GraphQL review query response into bot reviews, thread findings, and nitpicks. */
export function parseReviewData(raw: unknown, bots: string[]): ReviewData {
  const pr = (raw as ReviewQueryResponse).data.repository.pullRequest;
  const botReviews = pr.reviews.nodes.flatMap((review) => {
    const adapter = adapterForLogin(review.author?.login ?? "", bots);
    if (!adapter) return [];
    return [
      {
        bot: adapter.shortName,
        submittedAt: review.submittedAt,
        commitOid: review.commit?.oid ?? null,
        actionable: adapter.actionableCount?.(review.body) ?? null,
      },
    ];
  });
  const nitpicks = pr.reviews.nodes.flatMap((review) => {
    const adapter = adapterForLogin(review.author?.login ?? "", bots);
    return adapter?.reviewBodyFindings?.(review.body) ?? [];
  });
  return { botReviews, findings: findingsFromThreads(githubThreads(pr), bots), nitpicks };
}

function parseGitHubChecks(checks: GhCheck[]): PrCheck[] {
  return checks.map((c): PrCheck => {
    if (c.__typename === "StatusContext") {
      return { name: c.context ?? "unknown", state: statusContextState(c.state ?? "") };
    }
    return {
      name: c.name ?? "unknown",
      state: checkRunState(c.status ?? "", c.conclusion ?? null),
    };
  });
}

function githubThreads(pr: GraphqlReviewData["repository"]["pullRequest"]): ReviewThread[] {
  return pr.reviewThreads.nodes.flatMap((thread) => {
    const first = thread.comments.nodes[0];
    if (!first) return [];
    return [
      {
        path: thread.path,
        line: thread.line,
        startLine: thread.startLine,
        author: first.author?.login ?? "",
        body: first.body,
        resolved: thread.isResolved,
        outdated: thread.isOutdated,
      },
    ];
  });
}

function checkRunState(status: string, conclusion: string | null): PrCheck["state"] {
  if (status !== "COMPLETED") return "pending";
  if (conclusion === "SUCCESS" || conclusion === "NEUTRAL") return "passed";
  if (conclusion === "SKIPPED") return "skipped";
  return "failed";
}

function statusContextState(state: string): PrCheck["state"] {
  if (state === "SUCCESS") return "passed";
  if (state === "PENDING" || state === "EXPECTED") return "pending";
  return "failed";
}

function prViewArgs(opts: { pr?: string; repo?: string }): string[] {
  const args = ["pr", "view"];
  if (opts.pr) args.push(opts.pr);
  if (opts.repo) args.push("-R", opts.repo);
  args.push("--json", PR_VIEW_FIELDS.join(","));
  return args;
}

function reviewArgs(snapshot: PrSnapshot, reviewThreadsCursor: string | null): string[] {
  const args = [
    "api",
    "graphql",
    "-f",
    `query=${REVIEW_QUERY}`,
    "-F",
    `owner=${snapshot.owner}`,
    "-F",
    `name=${snapshot.repo}`,
    "-F",
    `number=${snapshot.number}`,
  ];
  if (reviewThreadsCursor) args.push("-F", `reviewThreadsCursor=${reviewThreadsCursor}`);
  return args;
}

function fetchReviewData(snapshot: PrSnapshot, bots: string[]): ReviewData {
  const first = reviewQueryResponse(runJson("gh", reviewArgs(snapshot, null), "gh api graphql"));
  let pageInfo = first.data.repository.pullRequest.reviewThreads.pageInfo;
  while (pageInfo.hasNextPage) {
    if (!pageInfo.endCursor) throw paginationFailure("gh api graphql pagination");
    const next = reviewQueryResponse(
      runJson("gh", reviewArgs(snapshot, pageInfo.endCursor), "gh api graphql"),
    );
    first.data.repository.pullRequest.reviewThreads.nodes.push(
      ...next.data.repository.pullRequest.reviewThreads.nodes,
    );
    pageInfo = next.data.repository.pullRequest.reviewThreads.pageInfo;
  }
  return parseReviewJson(first, bots);
}

function reviewQueryResponse(raw: unknown): ReviewQueryResponse {
  return raw as ReviewQueryResponse;
}

function parsePrViewJson(raw: unknown): PrSnapshot {
  try {
    return parsePrView(raw);
  } catch (error) {
    throw parseJsonFailure("could not parse gh pr view output", error);
  }
}

function parseReviewJson(raw: unknown, bots: string[]): ReviewData {
  try {
    return parseReviewData(raw, bots);
  } catch (error) {
    throw parseJsonFailure("could not parse gh api graphql output", error);
  }
}
