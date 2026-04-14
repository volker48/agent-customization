import { isToolCallEventType, type ExtensionAPI } from "@mariozechner/pi-coding-agent";

const BASH_TOOL = "bash";
const DEFAULT_RTK_BIN = "rtk";
const RTK_BIN_ENV = "PI_RTK_BIN";
const RTK_DEBUG_ENV = "PI_RTK_DEBUG";
const REWRITE_TIMEOUT_MS = 2_000;

const DEBUG_ENABLED = (() => {
  const raw = process.env[RTK_DEBUG_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
})();

function debugLog(message: string, extra?: unknown): void {
  if (!DEBUG_ENABLED) {
    return;
  }

  if (extra === undefined) {
    console.warn(`[rtk] ${message}`);
    return;
  }

  console.warn(`[rtk] ${message}`, extra);
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export default function rtkExtension(pi: ExtensionAPI) {
  pi.registerFlag("rtk-bin", {
    description: "Path to the rtk binary used to rewrite bash commands",
    type: "string",
  });

  const rewrites = new Map<
    string,
    {
      originalCommand: string;
      rewrittenCommand: string;
      rtkBin: string;
    }
  >();

  const getRtkBinary = () =>
    normalizeString(pi.getFlag("rtk-bin")) ??
    normalizeString(process.env[RTK_BIN_ENV]) ??
    DEFAULT_RTK_BIN;

  pi.on("session_start", async () => {
    rewrites.clear();
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType(BASH_TOOL, event)) {
      return;
    }

    const originalCommand = event.input.command.trim();
    if (!originalCommand) {
      return;
    }

    const rtkBin = getRtkBinary();
    const signal = (ctx as { signal?: AbortSignal }).signal;

    try {
      const result = await pi.exec(rtkBin, ["rewrite", originalCommand], {
        signal,
        timeout: REWRITE_TIMEOUT_MS,
      });

      if (result.code !== 0) {
        debugLog(`rewrite skipped (exit ${result.code})`, {
          command: originalCommand,
          stderr: result.stderr,
        });
        return;
      }

      const rewrittenCommand = result.stdout.trim();
      if (!rewrittenCommand || rewrittenCommand === originalCommand) {
        return;
      }

      event.input.command = rewrittenCommand;
      rewrites.set(event.toolCallId, {
        originalCommand,
        rewrittenCommand,
        rtkBin,
      });
      debugLog(`${originalCommand} -> ${rewrittenCommand}`);
    } catch (error) {
      debugLog(`rewrite failed for command: ${originalCommand}`, error);
    }
  });

  pi.on("tool_result", async (event) => {
    if (event.toolName !== BASH_TOOL) {
      return;
    }

    const rewrite = rewrites.get(event.toolCallId);
    if (!rewrite) {
      return;
    }

    rewrites.delete(event.toolCallId);

    const existingDetails =
      event.details && typeof event.details === "object" && !Array.isArray(event.details)
        ? (event.details as Record<string, unknown>)
        : {};

    return {
      details: {
        ...existingDetails,
        rtkRewrite: {
          originalCommand: rewrite.originalCommand,
          rewrittenCommand: rewrite.rewrittenCommand,
          rtkBin: rewrite.rtkBin,
        },
      },
    };
  });
}
