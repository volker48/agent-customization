#!/usr/bin/env -S tsx

import { pathToFileURL } from "node:url";

import {
  evaluateSettled,
  exitCodeFor,
  renderFindings,
  renderStatus,
  unresolvedFindings,
  type Finding,
  type PrSnapshot,
  type SettleOptions,
} from "./core.js";
import { DEFAULT_BOTS } from "./bots.js";
import { createGitHubProvider } from "./github.js";
import { createGitLabProvider } from "./gitlab.js";
import {
  autoDetectForge,
  CliError,
  UsageError,
  type ForgeName,
  type ForgeProvider,
} from "./forge.js";

type Command = "status" | "findings" | "wait";

type ValueFlag = "repo" | "bots" | "timeoutSecs" | "intervalSecs" | "forge";

export type CliOptions = {
  command: Command;
  pr?: string;
  repo?: string;
  bots: string[];
  forge?: ForgeName;
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

const BOOL_FLAGS: Record<string, "all" | "nitpicks" | "noReviews"> = {
  "--all": "all",
  "--nitpicks": "nitpicks",
  "--no-reviews": "noReviews",
};

const VALUE_FLAGS: Record<string, ValueFlag> = {
  "--repo": "repo",
  "-R": "repo",
  "--bots": "bots",
  "--forge": "forge",
  "--timeout": "timeoutSecs",
  "--interval": "intervalSecs",
};

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
  if (flag === "forge") state.opts.forge = parseForge(value);
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

function parseForge(value: string): ForgeName {
  if (value === "github" || value === "gitlab") return value;
  throw new UsageError("--forge must be github or gitlab");
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
  return forgeProvider(opts).fetchSnapshot({
    pr: opts.pr,
    repo: opts.repo,
    bots: opts.bots,
    nitpicks: opts.nitpicks,
  });
}

function forgeProvider(opts: CliOptions): ForgeProvider {
  const forge = opts.forge ?? autoDetectForge();
  return forge === "gitlab" ? createGitLabProvider() : createGitHubProvider();
}

function writeUsage(message: string): void {
  process.stderr.write(`${message}\n${usage()}\n`);
}

function usage(): string {
  return [
    "Usage: pr-watch status|findings|wait [<pr>] [options]",
    "Options:",
    "  -R, --repo <owner/repo>",
    "  --forge <github|gitlab>  default: auto (origin host containing gitlab => gitlab)",
    "  --bots <csv>",
    "  --all",
    "  --nitpicks",
    "  --no-reviews",
    "  --timeout <secs>        wait only (default 1800)",
    "  --interval <secs>       wait only (default 30)",
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
