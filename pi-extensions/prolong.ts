import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProlongMemory, type BranchEntry, type ProlongSyncResult } from "./lib/prolong-memory.js";

export const PROLONG_STATE_ENTRY = "prolong-state";
const PROLONG_ENV = "PI_PROLONG";

export type ProlongMemoryPort = {
  readonly directoryPath: string;
  readonly logPath: string;
  sync(
    entries: readonly BranchEntry[],
    options?: { forceRebuild?: boolean },
  ): Promise<ProlongSyncResult>;
  cleanup(): Promise<void>;
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
    runtime.lastSync = await runtime.memory.sync(context.sessionManager.getBranch(), {
      forceRebuild,
    });
    runtime.current = true;
    runtime.warned = false;
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

export function formatProlongStatus(runtime: {
  enabled: boolean;
  current: boolean;
  logPath?: string;
  lastSync?: ProlongSyncResult;
}): string {
  if (!runtime.enabled) return "PRO-LONG: off\nProjection: removed";
  const sync = runtime.lastSync;
  return [
    "PRO-LONG: on",
    `Path: ${runtime.logPath ?? "unavailable"}`,
    `State: ${runtime.current ? "current" : "stale"}`,
    `Entries: ${sync?.entryCount ?? 0}`,
    `Bytes: ${sync?.byteSize ?? 0}`,
    `Last sync: ${sync ? `${sync.mode} (${sync.elapsedMs.toFixed(2)} ms)` : "unavailable"}`,
  ].join("\n");
}

async function handleProlongCommand(
  pi: ExtensionAPI,
  runtime: ProlongRuntime,
  argumentsText: string,
  context: ExtensionContext,
): Promise<void> {
  const command = argumentsText.trim().toLowerCase();
  if (command === "on") {
    pi.appendEntry(PROLONG_STATE_ENTRY, { enabled: true });
    runtime.enabled = true;
    const synchronized = await synchronize(runtime, context);
    context.ui.notify(
      synchronized && runtime.memory
        ? `PRO-LONG enabled: ${runtime.memory.logPath}`
        : "PRO-LONG enabled, but its projection is unavailable until a refresh succeeds.",
      synchronized ? "info" : "warning",
    );
    return;
  }
  if (command === "off") {
    try {
      await runtime.memory?.cleanup();
    } catch (error) {
      context.ui.notify(
        `PRO-LONG cleanup failed and is still enabled: ${errorMessage(error)}`,
        "error",
      );
      return;
    }
    pi.appendEntry(PROLONG_STATE_ENTRY, { enabled: false });
    runtime.enabled = false;
    runtime.current = false;
    runtime.lastSync = undefined;
    context.ui.notify("PRO-LONG disabled; the derived session log was removed.", "info");
    return;
  }
  if (command === "status") {
    if (runtime.enabled) await synchronize(runtime, context);
    context.ui.notify(
      formatProlongStatus({
        enabled: runtime.enabled,
        current: runtime.current,
        logPath: runtime.memory?.logPath,
        lastSync: runtime.lastSync,
      }),
      "info",
    );
    return;
  }
  if (command === "refresh") {
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
    return;
  }
  context.ui.notify("Usage: /prolong on | off | status | refresh", "error");
}

export function registerProlongExtension(
  pi: ExtensionAPI,
  dependencies: ProlongExtensionDependencies = defaultDependencies(pi),
): void {
  const runtime: ProlongRuntime = { enabled: false, current: false, warned: false };

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

  pi.on("session_start", async (_event, context) => {
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
    runtime.lastSync = undefined;
    runtime.current = false;
    runtime.warned = false;
    if (runtime.enabled) await synchronize(runtime, context);
  });

  pi.on("before_agent_start", async (_event, context) => {
    if (!runtime.enabled) return undefined;
    await synchronize(runtime, context);
    return undefined;
  });

  pi.on("context", async (event, context) => {
    if (!runtime.enabled) return undefined;
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

  pi.on("session_tree", async (_event, context) => {
    const nextEnabled =
      readProlongEnabled(context.sessionManager.getBranch()) ?? dependencies.defaultEnabled();
    if (!nextEnabled) {
      runtime.enabled = false;
      runtime.current = false;
      runtime.lastSync = undefined;
      await runtime.memory?.cleanup();
      return;
    }
    runtime.enabled = true;
    await synchronize(runtime, context);
  });

  pi.on("session_shutdown", async () => {
    await runtime.memory?.cleanup();
    runtime.current = false;
    runtime.lastSync = undefined;
  });
}

export default function prolongExtension(pi: ExtensionAPI): void {
  registerProlongExtension(pi);
}
