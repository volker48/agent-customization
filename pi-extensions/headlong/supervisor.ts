import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, resolve } from "node:path";
import { ActorLease } from "./lease.js";
import { buildHeadlongWakePrompt } from "./index.js";
import type { HeadlongActorStatus, HeadlongStore } from "./store.js";

export type SupervisorChildRequest = {
  wakeId: string;
  leaseToken: string;
  sessionFile: string;
  workspace: string;
  extensionPath: string;
  stateRoot: string;
  prompt: string;
  timeoutMs: number;
  signal?: AbortSignal;
};

export type SupervisorChildResult = {
  settled: boolean;
  timedOut: boolean;
  aborted?: boolean;
  exitCode?: number | null;
  stderr?: string;
};

export type SupervisorWakeResult =
  | { kind: "not-due"; status: HeadlongActorStatus }
  | { kind: "owned" }
  | { kind: "transitioned"; status: HeadlongActorStatus; wakeId: string }
  | { kind: "failed-closed"; reason: string; wakeId?: string };

export type RunSupervisorWakeOptions = {
  store: HeadlongStore;
  extensionPath: string;
  now?: () => number;
  timeoutMs?: number;
  maxConsecutiveFailures?: number;
  signal?: AbortSignal;
  runChild: (request: SupervisorChildRequest) => Promise<SupervisorChildResult>;
};

export async function runSupervisorWake(
  options: RunSupervisorWakeOptions,
): Promise<SupervisorWakeResult> {
  const now = options.now ?? Date.now;
  const state = await options.store.readState();
  if (!state) return { kind: "failed-closed", reason: "actor state does not exist" };
  if (!["running", "sleeping"].includes(state.status)) {
    return { kind: "not-due", status: state.status };
  }
  if (state.wakeAt && Date.parse(state.wakeAt) > now()) {
    return { kind: "not-due", status: state.status };
  }
  const lease = await ActorLease.acquire({ store: options.store, role: "supervisor" });
  if (!lease) return { kind: "owned" };
  let wakeId: string | undefined;
  try {
    await lease.assertOwned();
    const current = await options.store.readState();
    if (!current) return { kind: "failed-closed", reason: "actor state disappeared" };
    if (!["running", "sleeping"].includes(current.status)) {
      return { kind: "not-due", status: current.status };
    }
    if (current.wakeAt && Date.parse(current.wakeAt) > now()) {
      return { kind: "not-due", status: current.status };
    }
    if (current.activeWakeId) {
      const failedAt = new Date(now()).toISOString();
      const failures = current.consecutiveFailures + 1;
      const maxFailures = options.maxConsecutiveFailures ?? 3;
      const paused = failures >= maxFailures;
      const retryDelayMs = Math.min(300_000, 5_000 * 2 ** (failures - 1));
      await options.store.writeState({
        ...current,
        revision: current.revision + 1,
        status: paused ? "paused" : "sleeping",
        wakeAt: paused ? null : new Date(now() + retryDelayMs).toISOString(),
        activeWakeId: null,
        wakeStartedAt: null,
        consecutiveFailures: failures,
        updatedAt: failedAt,
      });
      await options.store.appendEvent({
        at: failedAt,
        type: "wake.interrupted_recovered",
        wakeId: current.activeWakeId,
        detail: { failures, maxFailures, retryDelayMs: paused ? null : retryDelayMs },
      });
      return {
        kind: "failed-closed",
        reason: paused
          ? "interrupted wake reached the consecutive failure limit"
          : "interrupted wake recovered with bounded backoff",
        wakeId: current.activeWakeId,
      };
    }
    const sequence = current.wakeSequence + 1;
    wakeId = `wake-${sequence}-${randomUUID()}`;
    const startedAt = new Date(now()).toISOString();
    await options.store.writeState({
      ...current,
      revision: current.revision + 1,
      status: "running",
      wakeAt: null,
      wakeSequence: sequence,
      activeWakeId: wakeId,
      wakeStartedAt: startedAt,
      updatedAt: startedAt,
    });
    await options.store.appendEvent({
      at: startedAt,
      type: "wake.dispatched",
      wakeId,
      detail: { source: "supervisor" },
    });

    let childFailure: string | undefined;
    let result: SupervisorChildResult;
    try {
      result = await options.runChild({
        wakeId,
        leaseToken: lease.owner.token,
        sessionFile: current.sessionFile,
        workspace: current.workspace,
        extensionPath: options.extensionPath,
        stateRoot: options.store.stateRoot,
        prompt: buildHeadlongWakePrompt(wakeId),
        timeoutMs: options.timeoutMs ?? 30 * 60_000,
        signal: options.signal,
      });
    } catch (error) {
      childFailure = error instanceof Error ? error.message : String(error);
      result = { settled: false, timedOut: false, stderr: childFailure };
    }
    const transitioned = await options.store.readState();
    if (
      result.settled &&
      !result.timedOut &&
      result.exitCode === 0 &&
      transitioned &&
      transitioned.activeWakeId === null &&
      transitioned.lastTransitionWakeId === wakeId
    ) {
      return { kind: "transitioned", status: transitioned.status, wakeId };
    }

    const latest = transitioned ?? current;
    const failedAt = new Date(now()).toISOString();
    await options.store.writeState({
      ...latest,
      revision: latest.revision + 1,
      status: ["stopped", "completed"].includes(latest.status) ? latest.status : "paused",
      wakeAt: null,
      activeWakeId: null,
      wakeStartedAt: null,
      consecutiveFailures: latest.consecutiveFailures + 1,
      updatedAt: failedAt,
    });
    const reason = childFailure
      ? "Pi child failed before the wake settled"
      : result.aborted
        ? "supervised wake aborted"
        : result.timedOut
          ? "supervised wake timed out"
          : result.settled
            ? "wake settled without explicit transition"
            : "Pi host exited before the wake settled";
    await options.store.appendEvent({
      at: failedAt,
      type: "wake.supervisor_failed_closed",
      wakeId,
      detail: { reason, exitCode: result.exitCode, stderr: result.stderr?.slice(-4_000) },
    });
    return { kind: "failed-closed", reason, wakeId };
  } finally {
    await lease.release();
  }
}

export type SupervisorLoopResult =
  | { kind: "terminal"; status: HeadlongActorStatus }
  | { kind: "missing" }
  | { kind: "aborted" }
  | { kind: "exhausted" };

export type RunSupervisorLoopOptions = RunSupervisorWakeOptions & {
  sleep?: (milliseconds: number) => Promise<void>;
  signal?: AbortSignal;
  pollMs?: number;
  maxIterations?: number;
};

export async function runSupervisorLoop(
  options: RunSupervisorLoopOptions,
): Promise<SupervisorLoopResult> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const pollMs = options.pollMs ?? 1_000;
  const maxIterations = options.maxIterations ?? Number.POSITIVE_INFINITY;
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    if (options.signal?.aborted) return { kind: "aborted" };
    const state = await options.store.readState();
    if (!state) return { kind: "missing" };
    if (!["running", "sleeping"].includes(state.status)) {
      return { kind: "terminal", status: state.status };
    }
    const dueIn = state.wakeAt ? Math.max(0, Date.parse(state.wakeAt) - now()) : 0;
    if (!state.activeWakeId && dueIn > 0) {
      await sleep(Math.min(dueIn, pollMs));
      continue;
    }
    const result = await runSupervisorWake(options);
    if (result.kind === "owned" || result.kind === "not-due") {
      await sleep(pollMs);
      continue;
    }
    const after = await options.store.readState();
    if (!after) return { kind: "missing" };
    if (!["running", "sleeping"].includes(after.status)) {
      return { kind: "terminal", status: after.status };
    }
    const nextDelay = after.wakeAt ? Math.max(0, Date.parse(after.wakeAt) - now()) : pollMs;
    await sleep(Math.max(1, Math.min(nextDelay, pollMs)));
  }
  return { kind: "exhausted" };
}

export type ManagedChild = Pick<
  ChildProcessWithoutNullStreams,
  "pid" | "kill" | "once" | "exitCode" | "signalCode"
>;

export function buildPiRpcArguments(
  request: SupervisorChildRequest,
  prefixArgs: string[] = [],
): string[] {
  const prolongExtensionPath = resolve(dirname(request.extensionPath), "..", "prolong.ts");
  return [
    ...prefixArgs,
    "--mode",
    "rpc",
    "--session",
    request.sessionFile,
    "--no-extensions",
    "--extension",
    request.extensionPath,
    "--extension",
    prolongExtensionPath,
    "--no-skills",
    "--no-prompt-templates",
  ];
}

export async function runPiRpcChild(
  request: SupervisorChildRequest,
  options: { command?: string; prefixArgs?: string[] } = {},
): Promise<SupervisorChildResult> {
  if (request.signal?.aborted) return { settled: false, timedOut: false, aborted: true };
  const child = spawn(
    options.command ?? process.execPath,
    buildPiRpcArguments(request, options.prefixArgs),
    {
      cwd: request.workspace,
      env: {
        ...process.env,
        PI_HEADLONG_STATE_ROOT: request.stateRoot,
        PI_HEADLONG_LEASE_TOKEN: request.leaseToken,
        PI_HEADLONG_SUPERVISOR_WAKE_ID: request.wakeId,
      },
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-16_000);
  });

  let protocolFailure: Error | undefined;
  let rpcBuffer = "";
  let childClosed = false;
  let exitGraceTimer: NodeJS.Timeout | undefined;
  const settledOrExit = new Promise<"settled" | "exit">((resolve, reject) => {
    const fail = (error: Error): void => {
      protocolFailure ??= error;
      reject(protocolFailure);
    };
    let promptAccepted = false;
    child.once("error", (error) => fail(error));
    child.stdin.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "EPIPE") return;
      fail(error);
    });
    child.once("exit", () => {
      exitGraceTimer = setTimeout(() => resolve("exit"), 250);
      exitGraceTimer.unref();
    });
    child.once("close", () => {
      childClosed = true;
      resolve("exit");
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      rpcBuffer += chunk;
      if (rpcBuffer.length > 1_000_000) {
        fail(new Error("Pi RPC emitted an oversized unterminated line"));
        return;
      }
      for (;;) {
        const newline = rpcBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = rpcBuffer.slice(0, newline);
        rpcBuffer = rpcBuffer.slice(newline + 1);
        if (!line) continue;
        let message: {
          id?: string;
          type?: string;
          command?: string;
          success?: boolean;
          messages?: Array<{ role?: string; stopReason?: string; isError?: boolean }>;
        };
        try {
          message = JSON.parse(line) as typeof message;
        } catch (error) {
          fail(new Error("Pi RPC emitted malformed JSON", { cause: error }));
          return;
        }
        if (message.id === "headlong-wake" && message.type === "response") {
          if (message.command !== "prompt") {
            fail(new Error("Pi RPC emitted a mismatched Headlong prompt response"));
            return;
          }
          if (!message.success) {
            fail(new Error("Pi RPC rejected the Headlong wake prompt"));
            return;
          }
          promptAccepted = true;
        }
        if (message.type === "extension_error") {
          fail(new Error("Pi RPC reported an extension error during the Headlong wake"));
          return;
        }
        if (message.type === "agent_end") {
          if (!Array.isArray(message.messages)) {
            fail(new Error("Pi RPC emitted a malformed agent_end frame"));
            return;
          }
          const terminal = [...message.messages]
            .reverse()
            .find((candidate) => candidate.role === "assistant");
          if (
            terminal &&
            (terminal.isError === true ||
              terminal.stopReason === "error" ||
              terminal.stopReason === "aborted")
          ) {
            fail(new Error(`Pi RPC agent ended with ${terminal.stopReason ?? "an error"}`));
            return;
          }
        }
        if (message.type === "agent_settled") {
          if (!promptAccepted) {
            fail(new Error("Pi RPC settled before accepting the Headlong wake prompt"));
            return;
          }
          resolve("settled");
          return;
        }
      }
    });
  });

  child.stdin.write(
    `${JSON.stringify({ id: "headlong-wake", type: "prompt", message: request.prompt })}\n`,
  );
  let timeout: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<"aborted">((resolve) => {
    if (!request.signal) return;
    abortListener = () => resolve("aborted");
    request.signal.addEventListener("abort", abortListener, { once: true });
  });
  let outcome: "settled" | "exit" | "timeout" | "aborted";
  try {
    outcome = await Promise.race([
      settledOrExit,
      aborted,
      new Promise<"timeout">((resolve) => {
        timeout = setTimeout(() => resolve("timeout"), request.timeoutMs);
      }),
    ]);
  } catch (error) {
    child.stdin.destroy();
    try {
      await terminateProcessGroup(child);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Pi RPC protocol failed and cleanup also failed",
      );
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (exitGraceTimer) clearTimeout(exitGraceTimer);
    if (abortListener) request.signal?.removeEventListener("abort", abortListener);
  }

  if (outcome === "aborted") {
    if (!child.stdin.destroyed) {
      child.stdin.write(`${JSON.stringify({ id: "headlong-abort", type: "abort" })}\n`);
    }
    await terminateProcessGroup(child);
    return { settled: false, timedOut: false, aborted: true, exitCode: child.exitCode, stderr };
  }
  if (outcome === "timeout") {
    if (!child.stdin.destroyed) {
      child.stdin.write(`${JSON.stringify({ id: "headlong-abort", type: "abort" })}\n`);
    }
    await terminateProcessGroup(child);
    return { settled: false, timedOut: true, exitCode: child.exitCode, stderr };
  }
  if (outcome === "exit") {
    if (!childClosed) {
      await terminateProcessGroup(child, { signalExitedGroup: true, graceMs: 250 });
    }
    return { settled: false, timedOut: false, exitCode: child.exitCode, stderr };
  }

  child.stdin.end();
  const closed = await waitForClose(child, 1_000);
  if (!closed) {
    await terminateProcessGroup(child, { signalExitedGroup: true, graceMs: 250 });
  }
  if (rpcBuffer.length > 0) throw new Error("Pi RPC ended with a truncated unterminated frame");
  if (protocolFailure) throw protocolFailure;
  return {
    settled: closed && child.exitCode === 0,
    timedOut: false,
    exitCode: child.exitCode,
    stderr,
  };
}

function waitForClose(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (
    (child.exitCode !== null || child.signalCode !== null) &&
    child.stdout.readableEnded &&
    child.stderr.readableEnded
  ) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function waitForExit(child: ManagedChild, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      throw error;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, deadline - Date.now())));
  }
}

async function runTaskkill(pid: number): Promise<void> {
  const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
  });
  const [code] = (await new Promise<[number | null]>((resolve, reject) => {
    killer.once("error", reject);
    killer.once("exit", (exitCode) => resolve([exitCode]));
  })) as [number | null];
  if (code !== 0 && code !== 128) throw new Error(`taskkill failed with exit code ${String(code)}`);
}

export async function terminateProcessGroup(
  child: ManagedChild,
  options: { graceMs?: number; signalExitedGroup?: boolean } = {},
): Promise<void> {
  const pid = child.pid;
  const childExited = child.exitCode !== null || child.signalCode !== null;
  if (!pid || (childExited && !options.signalExitedGroup)) return;
  if (process.platform === "win32") {
    if (childExited) return;
    await runTaskkill(pid);
    await waitForExit(child, options.graceMs ?? 2_000);
    return;
  }

  const signalGroup = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  if (childExited) {
    signalGroup("SIGTERM");
    if (await waitForProcessGroupExit(pid, options.graceMs ?? 2_000)) return;
    signalGroup("SIGKILL");
    if (!(await waitForProcessGroupExit(pid, options.graceMs ?? 2_000))) {
      throw new Error(`Process group ${pid} did not exit after SIGKILL`);
    }
    return;
  }
  signalGroup("SIGTERM");
  if (await waitForExit(child, options.graceMs ?? 2_000)) return;
  signalGroup("SIGKILL");
  if (!(await waitForExit(child, options.graceMs ?? 2_000))) {
    throw new Error(`Process group ${pid} did not exit after SIGKILL`);
  }
}
