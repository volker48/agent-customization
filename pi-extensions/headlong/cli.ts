#!/usr/bin/env -S tsx

import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HeadlongStore } from "./store.js";
import { runPiRpcChild, runSupervisorLoop, runSupervisorWake } from "./supervisor.js";

export type SupervisorCliOptions = {
  workspace: string;
  stateRoot: string;
  timeoutMs: number;
  pollMs: number;
  once: boolean;
};

function defaultStateRoot(): string {
  const base = process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
  return join(base, "pi-headlong");
}

function positiveSeconds(value: string | undefined, label: string): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`${label} must be positive`);
  return seconds * 1_000;
}

export function parseSupervisorArgs(arguments_: string[]): SupervisorCliOptions {
  let workspace = process.cwd();
  let stateRoot = process.env.PI_HEADLONG_STATE_ROOT ?? defaultStateRoot();
  let timeoutMs = 30 * 60_000;
  let pollMs = 1_000;
  let once = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--workspace") workspace = arguments_[++index] ?? "";
    else if (argument === "--state-root") stateRoot = arguments_[++index] ?? "";
    else if (argument === "--timeout-seconds") {
      timeoutMs = positiveSeconds(arguments_[++index], "timeout");
    } else if (argument === "--poll-seconds") {
      pollMs = positiveSeconds(arguments_[++index], "poll interval");
    } else if (argument === "--once") once = true;
    else if (argument === "--help" || argument === "-h") {
      throw new Error("help");
    } else {
      throw new Error(`Unknown Headlong supervisor option: ${argument ?? ""}`);
    }
  }
  if (!workspace) throw new Error("workspace is required");
  workspace = resolve(workspace);
  if (!isAbsolute(stateRoot)) throw new Error("Headlong state root must be absolute");
  return { workspace, stateRoot, timeoutMs, pollMs, once };
}

function usage(): string {
  return [
    "Usage: pi-headlong [--workspace PATH] [--state-root PATH] [--timeout-seconds N]",
    "                   [--poll-seconds N] [--once]",
    "",
    "Runs the minimum wake-after-Pi-exit supervisor for one persistent workspace actor.",
  ].join("\n");
}

export function resolvePinnedPiCliPath(): string {
  const packageEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  return join(dirname(packageEntry), "cli.js");
}

export async function main(arguments_ = process.argv.slice(2)): Promise<void> {
  let options: SupervisorCliOptions;
  try {
    options = parseSupervisorArgs(arguments_);
  } catch (error) {
    if (error instanceof Error && error.message === "help") {
      console.log(usage());
      return;
    }
    throw error;
  }
  const store = new HeadlongStore({ stateRoot: options.stateRoot, workspace: options.workspace });
  const extensionPath = join(dirname(fileURLToPath(import.meta.url)), "index.ts");
  const runChild = (request: Parameters<typeof runPiRpcChild>[0]) =>
    runPiRpcChild(request, {
      command: process.execPath,
      prefixArgs: [resolvePinnedPiCliPath()],
    });
  const abortController = new AbortController();
  const stop = () => abortController.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    if (options.once) {
      console.log(
        JSON.stringify(
          await runSupervisorWake({
            store,
            extensionPath,
            timeoutMs: options.timeoutMs,
            runChild,
            signal: abortController.signal,
          }),
        ),
      );
      return;
    }

    const result = await runSupervisorLoop({
      store,
      extensionPath,
      timeoutMs: options.timeoutMs,
      pollMs: options.pollMs,
      runChild,
      signal: abortController.signal,
    });
    console.log(JSON.stringify(result));
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
