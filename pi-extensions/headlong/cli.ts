#!/usr/bin/env -S tsx

import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HeadlongStore } from "./store.js";
import {
  runPiRpcChild,
  runSupervisorLoop,
  runSupervisorWake,
  type SupervisorLoopResult,
  type SupervisorWakeResult,
} from "./supervisor.js";

export type SupervisorCliOptions = {
  workspace: string;
  stateRoot: string;
  timeoutMs: number;
  pollMs: number;
  once: boolean;
  allowUnsandboxedHostTools: boolean;
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
  let allowUnsandboxedHostTools = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--workspace") workspace = arguments_[++index] ?? "";
    else if (argument === "--state-root") stateRoot = arguments_[++index] ?? "";
    else if (argument === "--timeout-seconds") {
      timeoutMs = positiveSeconds(arguments_[++index], "timeout");
    } else if (argument === "--poll-seconds") {
      pollMs = positiveSeconds(arguments_[++index], "poll interval");
    } else if (argument === "--once") once = true;
    else if (argument === "--allow-unsandboxed-host-tools") allowUnsandboxedHostTools = true;
    else if (argument === "--help" || argument === "-h") {
      throw new Error("help");
    } else {
      throw new Error(`Unknown Headlong supervisor option: ${argument ?? ""}`);
    }
  }
  if (!workspace) throw new Error("workspace is required");
  workspace = resolve(workspace);
  if (!isAbsolute(stateRoot)) throw new Error("Headlong state root must be absolute");
  return { workspace, stateRoot, timeoutMs, pollMs, once, allowUnsandboxedHostTools };
}

function usage(): string {
  return [
    "Usage: pi-headlong [--workspace PATH] [--state-root PATH] [--timeout-seconds N]",
    "                   [--poll-seconds N] [--once] [--allow-unsandboxed-host-tools]",
    "",
    "Runs the minimum wake-after-Pi-exit supervisor for one persistent workspace actor.",
    "Filesystem tools are disabled by default. The unsandboxed flag grants model-facing tools",
    "access to the host filesystem and should be used only inside an operator-provided sandbox.",
  ].join("\n");
}

export function resolvePinnedPiCliPath(): string {
  const packageEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  return join(dirname(packageEntry), "cli.js");
}

export function supervisorWakeExitCode(result: SupervisorWakeResult): number {
  return result.kind === "failed-closed" || result.kind === "owned" ? 1 : 0;
}

export function supervisorLoopExitCode(result: SupervisorLoopResult): number {
  if (result.kind === "aborted") return 0;
  if (result.kind !== "terminal") return 1;
  return result.status === "completed" || result.status === "stopped" ? 0 : 1;
}

export async function main(arguments_ = process.argv.slice(2)): Promise<number> {
  let options: SupervisorCliOptions;
  try {
    options = parseSupervisorArgs(arguments_);
  } catch (error) {
    if (error instanceof Error && error.message === "help") {
      console.log(usage());
      return 0;
    }
    throw error;
  }
  if (options.allowUnsandboxedHostTools) {
    console.error(
      "WARNING: Headlong host filesystem tools are enabled without built-in sandboxing. " +
        "Run this supervisor inside an operator-controlled container or equivalent boundary.",
    );
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
  const onWarning = (message: string, error?: unknown) => {
    console.error(
      `${message}${error ? `: ${error instanceof Error ? error.message : String(error)}` : ""}`,
    );
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    if (options.once) {
      const result = await runSupervisorWake({
        store,
        extensionPath,
        timeoutMs: options.timeoutMs,
        allowUnsandboxedHostTools: options.allowUnsandboxedHostTools,
        runChild,
        onWarning,
        signal: abortController.signal,
      });
      console.log(JSON.stringify(result));
      return supervisorWakeExitCode(result);
    }

    const result = await runSupervisorLoop({
      store,
      extensionPath,
      timeoutMs: options.timeoutMs,
      pollMs: options.pollMs,
      allowUnsandboxedHostTools: options.allowUnsandboxedHostTools,
      runChild,
      onWarning,
      signal: abortController.signal,
    });
    console.log(JSON.stringify(result));
    return supervisorLoopExitCode(result);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
