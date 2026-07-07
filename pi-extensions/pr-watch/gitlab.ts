import {
  findingFromThread,
  type BotReview,
  type PrCheck,
  type PrSnapshot,
  type ReviewThread,
} from "./core.js";
import { parseJsonFailure, runJson, runJsonPages, type ForgeProvider } from "./forge.js";
import { adapterForLogin } from "./bots.js";

export type GitLabMrParseResult = {
  snapshot: PrSnapshot;
  projectId: string;
  pipelineId: string | null;
};

type GitLabMergeRequest = {
  iid: number;
  title: string;
  state: string;
  draft?: boolean;
  source_branch: string;
  target_branch: string;
  sha: string;
  web_url: string;
  project_id: number | string;
  head_pipeline?: { id: number | string } | null;
};

type GitLabJob = {
  name: string;
  status: string;
};

type GitLabNote = {
  body: string;
  resolvable: boolean;
  resolved?: boolean;
  created_at: string;
  author?: { username: string } | null;
  position?: {
    new_path?: string | null;
    old_path?: string | null;
    new_line?: number | null;
    old_line?: number | null;
  } | null;
};

type GitLabDiscussion = {
  notes: GitLabNote[];
};

type GitLabCommit = {
  committed_date: string;
};

export function createGitLabProvider(): ForgeProvider {
  return {
    name: "gitlab",
    fetchSnapshot(opts) {
      const mr = parseGitLabMrJson(runJson("glab", mrViewArgs(opts), "glab mr view"));
      const checks = mr.pipelineId ? fetchPipelineJobs(mr.projectId, mr.pipelineId) : [];
      const discussions = runJsonPages(
        "glab",
        (page, perPage) => discussionsArgs(mr.projectId, mr.snapshot.number, page, perPage),
        "glab api discussions",
      ) as GitLabDiscussion[];
      const commit = runJson(
        "glab",
        commitArgs(mr.projectId, mr.snapshot.headOid),
        "glab api commit",
      ) as GitLabCommit;
      return {
        ...mr.snapshot,
        headCommittedAt: commit.committed_date,
        checks,
        botReviews: parseGitLabBotReviews(discussions, opts.bots),
        findings: parseGitLabFindings(discussions, opts.bots),
      };
    },
  };
}

export function parseGitLabMr(raw: unknown): GitLabMrParseResult {
  const mr = raw as GitLabMergeRequest;
  const { owner, repo } = parseGitLabProjectPath(mr.web_url ?? "");
  return {
    projectId: String(mr.project_id),
    pipelineId: mr.head_pipeline?.id == null ? null : String(mr.head_pipeline.id),
    snapshot: {
      number: mr.iid,
      title: mr.title,
      state: gitLabMrState(mr.state),
      isDraft: mr.draft === true,
      headRefName: mr.source_branch,
      baseRefName: mr.target_branch,
      headOid: mr.sha,
      headCommittedAt: null,
      owner,
      repo,
      checks: [],
      botReviews: [],
      findings: [],
    },
  };
}

export function parseGitLabJobs(raw: unknown): PrCheck[] {
  return (raw as GitLabJob[]).map((job) => ({ name: job.name, state: gitLabJobState(job.status) }));
}

export function parseGitLabFindings(raw: unknown, bots: string[]): PrSnapshot["findings"] {
  return gitLabThreads(raw as GitLabDiscussion[])
    .map((thread) => findingFromThread(thread, bots))
    .filter((finding): finding is NonNullable<typeof finding> => finding != null);
}

export function parseGitLabBotReviews(raw: unknown, bots: string[]): BotReview[] {
  const latest = new Map<string, BotReview>();
  for (const note of topLevelBotNotes(raw as GitLabDiscussion[], bots)) {
    const adapter = adapterForLogin(note.author?.username ?? "", bots);
    if (!adapter) continue;
    const review = {
      bot: adapter.shortName,
      submittedAt: note.created_at,
      commitOid: null,
      actionable: adapter.actionableCount?.(note.body) ?? null,
    };
    const existing = latest.get(adapter.login);
    if (!existing || review.submittedAt > existing.submittedAt) latest.set(adapter.login, review);
  }
  return [...latest.values()];
}

function gitLabThreads(discussions: GitLabDiscussion[]): ReviewThread[] {
  return discussions.flatMap((discussion) => {
    const first = discussion.notes[0];
    if (!first?.resolvable) return [];
    const position = first.position;
    return [
      {
        path: position?.new_path ?? position?.old_path ?? "?",
        line: position?.new_line ?? position?.old_line ?? null,
        startLine: null,
        author: first.author?.username ?? "",
        body: first.body,
        resolved: first.resolved === true,
        outdated: false,
      },
    ];
  });
}

function topLevelBotNotes(discussions: GitLabDiscussion[], bots: string[]): GitLabNote[] {
  return discussions.flatMap((discussion) => {
    const first = discussion.notes[0];
    if (!first || first.resolvable || !adapterForLogin(first.author?.username ?? "", bots))
      return [];
    return [first];
  });
}

function gitLabMrState(state: string): string {
  if (state === "opened") return "OPEN";
  if (state === "merged") return "MERGED";
  if (state === "closed") return "CLOSED";
  return state.toUpperCase();
}

function gitLabJobState(status: string): PrCheck["state"] {
  if (status === "success") return "passed";
  if (status === "skipped" || status === "manual") return "skipped";
  if (status === "failed" || status === "canceled") return "failed";
  return "pending";
}

function parseGitLabProjectPath(webUrl: string): { owner: string; repo: string } {
  const match = /^https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\//.exec(webUrl);
  if (!match) return { owner: "", repo: "" };
  const parts = match[1].split("/");
  return { owner: parts.slice(0, -1).join("/"), repo: parts.at(-1) ?? "" };
}

function mrViewArgs(opts: { pr?: string; repo?: string }): string[] {
  const args = ["mr", "view"];
  if (opts.pr) args.push(opts.pr);
  args.push("-F", "json");
  if (opts.repo) args.push("-R", opts.repo);
  return args;
}

function fetchPipelineJobs(projectId: string, pipelineId: string): PrCheck[] {
  return parseGitLabJobsJson(
    runJsonPages(
      "glab",
      (page, perPage) => jobsArgs(projectId, pipelineId, page, perPage),
      "glab api pipeline jobs",
    ),
  );
}

function jobsArgs(projectId: string, pipelineId: string, page: number, perPage: number): string[] {
  return [
    "api",
    `projects/${projectId}/pipelines/${pipelineId}/jobs?per_page=${perPage}&page=${page}`,
  ];
}

function discussionsArgs(projectId: string, iid: number, page: number, perPage: number): string[] {
  return [
    "api",
    `projects/${projectId}/merge_requests/${iid}/discussions?per_page=${perPage}&page=${page}`,
  ];
}

function commitArgs(projectId: string, sha: string): string[] {
  return ["api", `projects/${projectId}/repository/commits/${sha}`];
}

function parseGitLabMrJson(raw: unknown): GitLabMrParseResult {
  try {
    return parseGitLabMr(raw);
  } catch (error) {
    throw parseJsonFailure("could not parse glab mr view output", error);
  }
}

function parseGitLabJobsJson(raw: unknown): PrCheck[] {
  try {
    return parseGitLabJobs(raw);
  } catch (error) {
    throw parseJsonFailure("could not parse glab pipeline jobs output", error);
  }
}
