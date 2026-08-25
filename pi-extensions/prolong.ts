import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProlongMemory,
  type BranchEntry,
  type ProlongBranchSource,
  type ProlongSyncResult,
} from "./lib/prolong-memory.js";

export const PROLONG_STATE_ENTRY = "prolong-state";
const PROLONG_ENV = "PI_PROLONG";

export type ProlongMemoryPort = {
  readonly directoryPath: string;
  readonly logPath: string;
  assertSupported?(): Promise<void>;
  sync(
    entries: readonly BranchEntry[],
    options?: { forceRebuild?: boolean },
  ): Promise<ProlongSyncResult>;
  syncBranch?(
    source: ProlongBranchSource,
    options?: { forceRebuild?: boolean },
  ): Promise<ProlongSyncResult>;
  cleanup(): Promise<void>;
  cleanupStale?(): Promise<void>;
};

export type ProlongExtensionDependencies = {
  createMemory: (sessionId: string) => ProlongMemoryPort;
  defaultEnabled: () => boolean;
};

type ProlongRuntime = {
  enabled: boolean;
  memory?: ProlongMemoryPort;
  lastSync?: ProlongSyncResult;
  current: boolean;
  warned: boolean;
  cleanupPending: boolean;
  cleanupWarned: boolean;
};

const PROLONG_PROMPT_PREFIX = "PRO-LONG programmatic memory:";

function fallbackRuntimeDirectory(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return join(tmpdir(), `pi-prolong-${uid}`);
}

function configuredRuntimeDirectory(): string {
  return process.env.XDG_RUNTIME_DIR?.trim() || fallbackRuntimeDirectory();
}

function envEnabled(): boolean {
  return process.env[PROLONG_ENV]?.trim() === "1";
}

export function readProlongEnabled(entries: readonly unknown[]): boolean | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || typeof entry !== "object") continue;
    if (!("type" in entry) || entry.type !== "custom") continue;
    if (!("customType" in entry) || entry.customType !== PROLONG_STATE_ENTRY) continue;
    if (!("data" in entry) || !entry.data || typeof entry.data !== "object") continue;
    if (!("enabled" in entry.data) || typeof entry.data.enabled !== "boolean") continue;
    return entry.data.enabled;
  }
  return undefined;
}

function defaultDependencies(pi: ExtensionAPI): ProlongExtensionDependencies {
  return {
    createMemory: (sessionId) =>
      new ProlongMemory({ runtimeDirectory: configuredRuntimeDirectory(), sessionId }),
    defaultEnabled: () => pi.getFlag("prolong") === true || envEnabled(),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function buildProlongPrompt(logPath: string): string {
  return [
    PROLONG_PROMPT_PREFIX,
    `A complete active-branch session log is available read-only at ${JSON.stringify(logPath)}.`,
    "When earlier evidence may matter, inspect this JSONL programmatically with grep, Python, Node, or another read-only tool instead of assuming it remains in active context.",
    "Each line is one Pi SessionEntry JSON object. Do not edit or overwrite the log.",
  ].join(" ");
}

async function synchronize(
  runtime: ProlongRuntime,
  context: ExtensionContext,
  forceRebuild = false,
): Promise<boolean> {
  if (!runtime.enabled || !runtime.memory) return false;
  try {
    const options = { forceRebuild };
    runtime.lastSync = runtime.memory.syncBranch
      ? await runtime.memory.syncBranch(context.sessionManager, options)
      : await runtime.memory.sync(context.sessionManager.getBranch(), options);
    runtime.current = true;
    runtime.warned = false;
    runtime.cleanupPending = false;
    runtime.cleanupWarned = false;
    return true;
  } catch (error) {
    runtime.current = false;
    if (!runtime.warned) {
      context.ui.notify(
        `PRO-LONG could not refresh its session log; coding continues without claiming it is current: ${errorMessage(error)}`,
        "warning",
      );
      runtime.warned = true;
    }
    return false;
  }
}

async function cleanupProjection(
  runtime: ProlongRuntime,
  context: ExtensionContext,
  failureMessage: string,
  level: "warning" | "error" = "warning",
): Promise<boolean> {
  try {
    await runtime.memory?.cleanup();
    runtime.cleanupPending = false;
    runtime.cleanupWarned = false;
    return true;
  } catch (error) {
    runtime.current = false;
    runtime.lastSync = undefined;
    runtime.cleanupPending = true;
    if (!runtime.cleanupWarned) {
      context.ui.notify(`${failureMessage}: ${errorMessage(error)}`, level);
      runtime.cleanupWarned = true;
    }
    return false;
  }
}

async function retryPendingCleanup(
  runtime: ProlongRuntime,
  context: ExtensionContext,
): Promise<void> {
  if (!runtime.enabled && runtime.cleanupPending) {
    await cleanupProjection(
      runtime,
      context,
      "PRO-LONG projection removal is still pending and will be retried",
    );
  }
}

export function formatProlongStatus(runtime: {
  enabled: boolean;
  current: boolean;
  cleanupPending?: boolean;
  logPath?: string;
  lastSync?: ProlongSyncResult;
}): string {
  if (!runtime.enabled) {
    if (runtime.cleanupPending) {
      return [
        "PRO-LONG: off",
        "Projection: cleanup pending",
        `Path: ${runtime.logPath ?? "unavailable"}`,
      ].join("\n");
    }
    return "PRO-LONG: off\nProjection: removed";
  }
  const sync = runtime.lastSync;
  return [
    "PRO-LONG: on",
    `Path: ${runtime.logPath ?? "unavailable"}`,
    `State: ${runtime.current ? "current" : "stale"}`,
    `Entries: ${sync?.entryCount ?? 0}`,
    `Bytes: ${sync?.byteSize ?? 0}`,
    `Last sync: ${sync ? `${sync.mode} (${sync.elapsedMs.toFixed(2)} ms)` : "unavailable"}`,
    ...(runtime.cleanupPending ? ["Cleanup: pending"] : []),
  ].join("\n");
}

async function enableProlong(
  pi: ExtensionAPI,
  runtime: ProlongRuntime,
  context: ExtensionContext,
): Promise<void> {
  if (!runtime.memory) {
    context.ui.notify("PRO-LONG cannot be enabled before session memory is initialized.", "error");
    return;
  }
  try {
    await runtime.memory.assertSupported?.();
  } catch (error) {
    context.ui.notify(`PRO-LONG was not enabled: ${errorMessage(error)}`, "error");
    return;
  }

  pi.appendEntry(PROLONG_STATE_ENTRY, { enabled: true });
  runtime.enabled = true;
  const synchronized = await synchronize(runtime, context);
  context.ui.notify(
    synchronized
      ? `PRO-LONG enabled: ${runtime.memory.logPath}`
      : "PRO-LONG enabled, but its projection is unavailable until a refresh succeeds.",
    synchronized ? "info" : "warning",
  );
}

async function disableProlong(
  pi: ExtensionAPI,
  runtime: ProlongRuntime,
  context: ExtensionContext,
): Promise<void> {
  const wasEnabled = runtime.enabled;
  const cleaned = await cleanupProjection(
    runtime,
    context,
    wasEnabled
      ? "PRO-LONG cleanup failed and is still enabled"
      : "PRO-LONG remains off, but projection removal is pending",
    "error",
  );
  if (!cleaned) return;

  pi.appendEntry(PROLONG_STATE_ENTRY, { enabled: false });
  runtime.enabled = false;
  runtime.current = false;
  runtime.lastSync = undefined;
  context.ui.notify("PRO-LONG disabled; the derived session log was removed.", "info");
}

async function showProlongStatus(
  runtime: ProlongRuntime,
  context: ExtensionContext,
): Promise<void> {
  if (runtime.enabled) await synchronize(runtime, context);
  else await retryPendingCleanup(runtime, context);
  context.ui.notify(
    formatProlongStatus({
      enabled: runtime.enabled,
      current: runtime.current,
      cleanupPending: runtime.cleanupPending,
      logPath: runtime.memory?.logPath,
      lastSync: runtime.lastSync,
    }),
    "info",
  );
}

async function refreshProlong(runtime: ProlongRuntime, context: ExtensionContext): Promise<void> {
  if (!runtime.enabled) {
    context.ui.notify("PRO-LONG is off. Enable it first with /prolong on.", "warning");
    return;
  }
  const synchronized = await synchronize(runtime, context, true);
  context.ui.notify(
    synchronized && runtime.memory
      ? `PRO-LONG refreshed: ${runtime.memory.logPath}`
      : "PRO-LONG refresh failed; the projection is not current.",
    synchronized ? "info" : "warning",
  );
}

async function handleProlongCommand(
  pi: ExtensionAPI,
  runtime: ProlongRuntime,
  argumentsText: string,
  context: ExtensionContext,
): Promise<void> {
  const command = argumentsText.trim().toLowerCase();
  if (command === "on") return enableProlong(pi, runtime, context);
  if (command === "off") return disableProlong(pi, runtime, context);
  if (command === "status") return showProlongStatus(runtime, context);
  if (command === "refresh") return refreshProlong(runtime, context);
  context.ui.notify("Usage: /prolong on | off | status | refresh", "error");
}

function resetRuntimeForSession(runtime: ProlongRuntime): void {
  runtime.lastSync = undefined;
  runtime.current = false;
  runtime.warned = false;
  runtime.cleanupPending = false;
  runtime.cleanupWarned = false;
}

async function startSession(
  runtime: ProlongRuntime,
  dependencies: ProlongExtensionDependencies,
  context: ExtensionContext,
): Promise<void> {
  const previousMemory = runtime.memory;
  runtime.memory = undefined;
  try {
    await previousMemory?.cleanup();
  } catch (error) {
    context.ui.notify(
      `PRO-LONG could not remove the previous session projection; continuing with new session memory: ${errorMessage(error)}`,
      "warning",
    );
  }

  runtime.memory = dependencies.createMemory(context.sessionManager.getSessionId());
  runtime.enabled =
    readProlongEnabled(context.sessionManager.getBranch()) ?? dependencies.defaultEnabled();
  resetRuntimeForSession(runtime);
  if (runtime.enabled) {
    await synchronize(runtime, context);
  } else if (runtime.memory.cleanupStale) {
    try {
      await runtime.memory.cleanupStale();
    } catch (error) {
      runtime.cleanupPending = true;
      runtime.cleanupWarned = true;
      context.ui.notify(
        `PRO-LONG found a stale disabled-session projection that could not be removed: ${errorMessage(error)}`,
        "warning",
      );
    }
  }
}

async function reconcileSessionTree(
  runtime: ProlongRuntime,
  dependencies: ProlongExtensionDependencies,
  context: ExtensionContext,
): Promise<void> {
  const nextEnabled =
    readProlongEnabled(context.sessionManager.getBranch()) ?? dependencies.defaultEnabled();
  if (!nextEnabled) {
    runtime.enabled = false;
    runtime.current = false;
    runtime.lastSync = undefined;
    await cleanupProjection(
      runtime,
      context,
      "PRO-LONG is disabled for this branch, but projection cleanup failed; removal will be retried",
    );
    return;
  }
  runtime.enabled = true;
  await synchronize(runtime, context);
}

function registerProlongControls(pi: ExtensionAPI, runtime: ProlongRuntime): void {
  pi.registerFlag("prolong", {
    description: "Expose the active Pi session branch as private read-only JSONL",
    type: "boolean",
  });
  pi.registerCommand("prolong", {
    description: "Control PRO-LONG programmatic session memory",
    handler: async (argumentsText, context) => {
      await handleProlongCommand(pi, runtime, argumentsText, context);
    },
  });
}

function registerProlongAgentHandlers(pi: ExtensionAPI, runtime: ProlongRuntime): void {
  pi.on("before_agent_start", async (_event, context) => {
    if (!runtime.enabled) {
      await retryPendingCleanup(runtime, context);
      return undefined;
    }
    await synchronize(runtime, context);
    return undefined;
  });

  pi.on("context", async (event, context) => {
    if (!runtime.enabled) {
      await retryPendingCleanup(runtime, context);
      return undefined;
    }
    if (!(await synchronize(runtime, context)) || !runtime.memory) return undefined;
    return {
      messages: [
        ...event.messages,
        {
          role: "custom",
          customType: "prolong-context-hint",
          content: buildProlongPrompt(runtime.memory.logPath),
          display: false,
          timestamp: Date.now(),
        },
      ],
    };
  });
}

function registerProlongSessionHandlers(
  pi: ExtensionAPI,
  runtime: ProlongRuntime,
  dependencies: ProlongExtensionDependencies,
): void {
  pi.on("session_start", async (_event, context) => {
    await startSession(runtime, dependencies, context);
  });
  pi.on("session_tree", async (_event, context) => {
    await reconcileSessionTree(runtime, dependencies, context);
  });
  pi.on("session_shutdown", async (_event, context) => {
    await cleanupProjection(
      runtime,
      context,
      "PRO-LONG could not remove its projection during session shutdown",
    );
    runtime.current = false;
    runtime.lastSync = undefined;
  });
}

export function registerProlongExtension(
  pi: ExtensionAPI,
  dependencies: ProlongExtensionDependencies = defaultDependencies(pi),
): void {
  const runtime: ProlongRuntime = {
    enabled: false,
    current: false,
    warned: false,
    cleanupPending: false,
    cleanupWarned: false,
  };
  registerProlongControls(pi, runtime);
  registerProlongAgentHandlers(pi, runtime);
  registerProlongSessionHandlers(pi, runtime, dependencies);
}

export default function prolongExtension(pi: ExtensionAPI): void {
  registerProlongExtension(pi);
}
