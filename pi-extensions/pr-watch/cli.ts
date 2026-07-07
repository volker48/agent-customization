#!/usr/bin/env -S tsx

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_BOTS,
  REVIEW_QUERY,
  evaluateSettled,
  exitCodeFor,
  parsePrView,
  parseReviewData,
  renderFindings,
  renderStatus,
  unresolvedFindings,
  type Finding,
  type PrSnapshot,
  type SettleOptions,
} from "./core.js";

type Command = "status" | "findings" | "wait";

type ValueFlag = "repo" | "bots" | "timeoutSecs" | "intervalSecs";

type ReviewQueryResponse = {
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          pageInfo: {
            hasNextPage: boolean;
            endCursor: string | null;
          };
          nodes: unknown[];
        };
      };
    };
  };
};

export type CliOptions = {
  command: Command;
  pr?: string;
  repo?: string;
  bots: string[];
  all: boolean;
  nitpicks: boolean;
  noReviews: boolean;
  timeoutSecs: number;
  intervalSecs: number;
};

type ParseState = {
  opts: CliOptions;
  waitFlagUsed: boolean;
};

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
const GH_MAX_BUFFER = 16 * 1024 * 1024;

const BOOL_FLAGS: Record<string, "all" | "nitpicks" | "noReviews"> = {
  "--all": "all",
  "--nitpicks": "nitpicks",
  "--no-reviews": "noReviews",
};

const VALUE_FLAGS: Record<string, ValueFlag> = {
  "--repo": "repo",
  "-R": "repo",
  "--bots": "bots",
  "--timeout": "timeoutSecs",
  "--interval": "intervalSecs",
};

class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly retryable = false,
  ) {
    super(message);
  }
}

class UsageError extends CliError {
  constructor(message: string) {
    super(message, 4);
  }
}

/** Parse pr-watch CLI arguments without performing any I/O. */
export function parseArgs(argv: string[]): CliOptions {
  const command = parseCommand(argv[0]);
  const state: ParseState = { opts: defaultOptions(command), waitFlagUsed: false };
  let index = 1;
  while (index < argv.length) {
    index = consumeToken(argv, index, state);
  }
  if (state.waitFlagUsed && command !== "wait") {
    throw new UsageError("--timeout and --interval are only valid with wait");
  }
  return state.opts;
}

function parseCommand(value: string | undefined): Command {
  if (value === "status" || value === "findings" || value === "wait") return value;
  throw new UsageError(value ? `unknown subcommand: ${value}` : "missing subcommand");
}

function defaultOptions(command: Command): CliOptions {
  return {
    command,
    bots: [...DEFAULT_BOTS],
    all: false,
    nitpicks: false,
    noReviews: false,
    timeoutSecs: 1800,
    intervalSecs: 30,
  };
}

function consumeToken(argv: string[], index: number, state: ParseState): number {
  const arg = argv[index] ?? "";
  const boolFlag = BOOL_FLAGS[arg];
  if (boolFlag) {
    state.opts[boolFlag] = true;
    return index + 1;
  }
  const inline = inlineValue(arg);
  if (inline && VALUE_FLAGS[inline.flag]) {
    assignValue(state, VALUE_FLAGS[inline.flag], inline.value);
    return index + 1;
  }
  const valueFlag = VALUE_FLAGS[arg];
  if (valueFlag) {
    assignValue(state, valueFlag, requiredValue(argv, index, arg));
    return index + 2;
  }
  if (arg.startsWith("-")) throw new UsageError(`unknown flag: ${arg}`);
  assignPr(state.opts, arg);
  return index + 1;
}

function inlineValue(arg: string): { flag: string; value: string } | null {
  const index = arg.startsWith("--") ? arg.indexOf("=") : -1;
  return index === -1 ? null : { flag: arg.slice(0, index), value: arg.slice(index + 1) };
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value == null || value.startsWith("-")) throw new UsageError(`${flag} requires a value`);
  return value;
}

function assignPr(opts: CliOptions, value: string): void {
  if (!/^\d+$/.test(value)) throw new UsageError(`invalid PR number: ${value}`);
  if (opts.pr) throw new UsageError(`unexpected positional argument: ${value}`);
  opts.pr = value;
}

function assignValue(state: ParseState, flag: ValueFlag, value: string): void {
  if (flag === "repo") state.opts.repo = nonEmpty(value, "--repo");
  if (flag === "bots") state.opts.bots = parseBots(value);
  if (flag === "timeoutSecs") state.opts.timeoutSecs = parseSeconds(state, value, "--timeout");
  if (flag === "intervalSecs") state.opts.intervalSecs = parseSeconds(state, value, "--interval");
}

function nonEmpty(value: string, flag: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new UsageError(`${flag} requires a value`);
  return trimmed;
}

function parseBots(value: string): string[] {
  const bots = value
    .split(",")
    .map((bot) => bot.trim())
    .filter(Boolean);
  if (bots.length === 0) throw new UsageError("--bots requires at least one bot");
  return bots;
}

function parseSeconds(state: ParseState, value: string, flag: string): number {
  state.waitFlagUsed = true;
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new UsageError(`${flag} must be a positive integer number of seconds`);
  }
  return seconds;
}

async function main(argv: string[]): Promise<number> {
  try {
    const opts = parseArgs(argv);
    if (opts.command === "status") return runStatus(opts);
    if (opts.command === "findings") return runFindings(opts);
    return await runWait(opts);
  } catch (error) {
    if (error instanceof UsageError) {
      writeUsage(error.message);
      return error.exitCode;
    }
    if (error instanceof CliError) {
      process.stderr.write(`${error.message}\n`);
      return error.exitCode;
    }
    throw error;
  }
}

function runStatus(opts: CliOptions): number {
  const snapshot = fetchSnapshot(opts);
  const settle = evaluateSettled(snapshot, settleOptions(opts));
  process.stdout.write(`${renderStatus(snapshot, settle)}\n`);
  return exitCodeFor(snapshot, settle);
}

function runFindings(opts: CliOptions): number {
  const snapshot = fetchSnapshot(opts);
  process.stdout.write(`${renderFindings(selectedFindings(snapshot, opts), "findings")}\n`);
  return 0;
}

async function runWait(opts: CliOptions): Promise<number> {
  const deadline = Date.now() + opts.timeoutSecs * 1000;
  while (true) {
    try {
      const snapshot = fetchSnapshot(opts);
      const settle = evaluateSettled(snapshot, settleOptions(opts));
      if (settle.settled) return finishWait(snapshot, settle, opts);
      if (Date.now() >= deadline) {
        process.stdout.write(`${waitOutput(snapshot, settle, opts, "TIMEOUT")}\n`);
        return 3;
      }
    } catch (error) {
      if (!(error instanceof CliError) || !error.retryable) throw error;
      if (Date.now() >= deadline) throw error;
    }
    await sleep(Math.min(opts.intervalSecs * 1000, Math.max(deadline - Date.now(), 0)));
  }
}

function finishWait(
  snapshot: PrSnapshot,
  settle: ReturnType<typeof evaluateSettled>,
  opts: CliOptions,
): number {
  process.stdout.write(`${waitOutput(snapshot, settle, opts)}\n`);
  return exitCodeFor(snapshot, settle);
}

function waitOutput(
  snapshot: PrSnapshot,
  settle: ReturnType<typeof evaluateSettled>,
  opts: CliOptions,
  label?: string,
): string {
  const findings = selectedFindings(snapshot, opts);
  const blocks = [renderStatus(snapshot, settle, label)];
  if (unresolvedFindings(snapshot).length > 0) blocks.push(renderFindings(findings, "findings"));
  return blocks.join("\n\n");
}

function selectedFindings(snapshot: PrSnapshot, opts: CliOptions): Finding[] {
  return opts.all ? snapshot.findings : unresolvedFindings(snapshot);
}

function settleOptions(opts: CliOptions): SettleOptions {
  return { noReviews: opts.noReviews, bots: opts.bots };
}

function fetchSnapshot(opts: CliOptions): PrSnapshot {
  const snapshot = parsePrViewJson(runGhJson(prViewArgs(opts), "gh pr view"));
  const reviews = fetchReviewData(snapshot, opts.bots);
  return {
    ...snapshot,
    botReviews: reviews.botReviews,
    findings: opts.nitpicks ? [...reviews.findings, ...reviews.nitpicks] : reviews.findings,
  };
}

function prViewArgs(opts: CliOptions): string[] {
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

function fetchReviewData(snapshot: PrSnapshot, bots: string[]): ReturnType<typeof parseReviewData> {
  const first = reviewQueryResponse(runGhJson(reviewArgs(snapshot, null), "gh api graphql"));
  let pageInfo = first.data.repository.pullRequest.reviewThreads.pageInfo;
  while (pageInfo.hasNextPage) {
    if (!pageInfo.endCursor) throw ghError("gh api graphql pagination", "", null, false);
    const next = reviewQueryResponse(
      runGhJson(reviewArgs(snapshot, pageInfo.endCursor), "gh api graphql"),
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

function runGhJson(args: string[], context: string): unknown {
  const result = spawnSync("gh", args, { encoding: "utf8", maxBuffer: GH_MAX_BUFFER });
  if (result.error) throw ghError(context, "", result.error, false);
  if (result.status !== 0) throw ghError(context, result.stderr, null, true);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw ghError(`${context} returned invalid JSON`, result.stderr, error, false);
  }
}

function parsePrViewJson(raw: unknown): PrSnapshot {
  try {
    return parsePrView(raw);
  } catch (error) {
    throw ghError("could not parse gh pr view output", "", error, false);
  }
}

function parseReviewJson(raw: unknown, bots: string[]): ReturnType<typeof parseReviewData> {
  try {
    return parseReviewData(raw, bots);
  } catch (error) {
    throw ghError("could not parse gh api graphql output", "", error, false);
  }
}

function ghError(
  context: string,
  stderr: string | null | undefined,
  cause: unknown,
  retryable: boolean,
): CliError {
  const lines = [`${context} failed`];
  if (stderr?.trim()) lines.push(stderr.trimEnd());
  if (cause instanceof Error) lines.push(cause.message);
  return new CliError(lines.join("\n"), 4, retryable);
}

function writeUsage(message: string): void {
  process.stderr.write(`${message}\n${usage()}\n`);
}

function usage(): string {
  return [
    "Usage: pr-watch status|findings|wait [<pr>] [options]",
    "Options:",
    "  -R, --repo <owner/repo>",
    "  --bots <csv>",
    "  --all",
    "  --nitpicks",
    "  --no-reviews",
    "  --timeout <secs>    wait only (default 1800)",
    "  --interval <secs>   wait only (default 30)",
  ].join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMain(): boolean {
  return process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMain()) {
  process.exitCode = await main(process.argv.slice(2));
}
