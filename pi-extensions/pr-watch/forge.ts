import { spawnSync } from "node:child_process";

import type { PrSnapshot } from "./core.js";

export type ForgeName = "github" | "gitlab";

export type SnapshotFetchOptions = {
  pr?: string;
  repo?: string;
  bots: string[];
  nitpicks: boolean;
};

export type ForgeProvider = {
  name: ForgeName;
  fetchSnapshot(opts: SnapshotFetchOptions): PrSnapshot;
};

const CLI_MAX_BUFFER = 16 * 1024 * 1024;
const CLI_TIMEOUT_MS = 30_000;

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export class UsageError extends CliError {
  constructor(message: string) {
    super(message, 4);
  }
}

export function detectForgeFromRemoteUrl(remoteUrl: string | null | undefined): ForgeName {
  const host = remoteHost(remoteUrl ?? "");
  return host.toLowerCase().includes("gitlab") ? "gitlab" : "github";
}

export function autoDetectForge(): ForgeName {
  const result = spawnSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" });
  if (result.error || result.status !== 0) return "github";
  return detectForgeFromRemoteUrl(result.stdout.trim());
}

export function runJson(command: string, args: string[], context: string): unknown {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: CLI_MAX_BUFFER,
    timeout: CLI_TIMEOUT_MS,
  });
  if (result.error) throw cliError(context, "", result.error, isRetryableSpawnError(result.error));
  if (result.signal)
    throw cliError(`${context} terminated by ${result.signal}`, result.stderr, null, true);
  if (result.status !== 0) throw cliError(context, result.stderr, null, true);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw cliError(`${context} returned invalid JSON`, result.stderr, error, false);
  }
}

export function runJsonPages(
  command: string,
  argsForPage: (page: number, perPage: number) => string[],
  context: string,
  perPage = 100,
): unknown[] {
  return collectJsonPages(
    (page, pageSize) => runJson(command, argsForPage(page, pageSize), `${context} page ${page}`),
    context,
    perPage,
  );
}

export function collectJsonPages(
  fetchPage: (page: number, perPage: number) => unknown,
  context: string,
  perPage = 100,
): unknown[] {
  const results: unknown[] = [];
  for (let page = 1; ; page += 1) {
    const items = jsonArrayPage(fetchPage(page, perPage), context, page);
    results.push(...items);
    if (items.length < perPage) return results;
  }
}

export function parseJsonFailure(context: string, cause: unknown): CliError {
  return cliError(context, "", cause, false);
}

export function paginationFailure(context: string): CliError {
  return cliError(context, "", null, false);
}

function isRetryableSpawnError(error: Error): boolean {
  return "code" in error && error.code === "ETIMEDOUT";
}

function jsonArrayPage(raw: unknown, context: string, page: number): unknown[] {
  if (Array.isArray(raw)) return raw;
  return throwExpectedArray(context, page);
}

function throwExpectedArray(context: string, page: number): never {
  throw parseJsonFailure(`${context} page ${page} returned a non-array JSON document`, null);
}

function cliError(
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

function remoteHost(remoteUrl: string): string {
  if (!remoteUrl.trim()) return "";
  try {
    return new URL(remoteUrl).host;
  } catch {
    const sshMatch = /^[^@]+@([^:]+):/.exec(remoteUrl);
    if (sshMatch) return sshMatch[1];
    const hostPath = /^([^/:]+)[:/]/.exec(remoteUrl);
    return hostPath?.[1] ?? remoteUrl;
  }
}
