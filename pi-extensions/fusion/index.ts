import {
  BorderedLoader,
  type ExtensionAPI,
  getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import {
  createFusionDebugLogger,
  progressLogDetails,
  resolveFusionDebugLogPath,
  resultLogDetails,
  type FusionDebugLogger,
} from "./debug-log.js";
import { type FusionArgs, parseFusionArgs, readBundleFile } from "./args.js";
import {
  capsulePrompt,
  extractSessionEvidence,
  generateCapsule,
  loadCapsule,
  previewCapsule,
  type Capsule,
  type CapsuleError,
  type CapsuleResult,
  type SessionEntryLike,
} from "../lib/context-capsule.js";
import { loadFusionConfig } from "./config.js";
import { runFusion } from "./orchestrator.js";
import { createProgressState, formatProgress, reduceProgress } from "./progress.js";
import {
  FUSION_MESSAGE_TYPE,
  type FusionPanelDetails,
  renderFusionPanelMarkdown,
  toFusionPanelMessage,
} from "./render.js";
import type { FusionResult } from "./types.js";

const LOADER_KEY = "fusion";

interface ResolveContext {
  hasUI?: boolean;
  cwd?: string;
  ui: {
    notify: (message: string, level?: string) => void;
    confirm?: (title: string, message: string) => Promise<boolean>;
  };
  waitForIdle?: () => Promise<void>;
  sessionManager?: {
    getBranch: () => unknown[];
    getSessionId: () => string;
    getSessionFile: () => string | undefined;
  };
}

export type FusionInputErrorCode =
  | "invalid-arguments"
  | "invalid-capsule"
  | "cancelled"
  | "confirmation-unavailable";

export class FusionInputError extends Error {
  readonly code: FusionInputErrorCode;
  readonly capsuleErrorCode?: CapsuleError["code"];

  constructor(
    code: FusionInputErrorCode,
    message: string,
    capsuleErrorCode?: CapsuleError["code"],
  ) {
    super(message);
    this.name = "FusionInputError";
    this.code = code;
    this.capsuleErrorCode = capsuleErrorCode;
  }
}

function capsuleFailure(error: CapsuleError): FusionInputError {
  return new FusionInputError(
    error.code === "cancelled" ? "cancelled" : "invalid-capsule",
    `${error.code}: ${error.message}`,
    error.code,
  );
}

async function prepareCapsule(
  reference: string,
  ctx: ResolveContext,
  signal: AbortSignal,
): Promise<Capsule> {
  if (signal.aborted) throw new FusionInputError("cancelled", "Fusion cancelled.");

  let result: CapsuleResult<Capsule>;
  if (reference === "current") {
    if (!ctx.waitForIdle || !ctx.sessionManager) {
      throw new FusionInputError(
        "invalid-capsule",
        "Current-session capsule input is unavailable in this context.",
      );
    }
    await ctx.waitForIdle();
    if (signal.aborted) throw new FusionInputError("cancelled", "Fusion cancelled.");
    result = await generateCapsule(
      extractSessionEvidence(
        ctx.sessionManager.getBranch() as SessionEntryLike[],
        ctx.cwd ?? process.cwd(),
      ),
      {
        sessionId: ctx.sessionManager.getSessionId(),
        sessionFile: ctx.sessionManager.getSessionFile(),
        cwd: ctx.cwd ?? process.cwd(),
        signal,
      },
    );
  } else {
    result = await loadCapsule(reference);
  }
  if (signal.aborted) throw new FusionInputError("cancelled", "Fusion cancelled.");
  if ("error" in result) throw capsuleFailure(result.error);
  return result.value;
}

export async function resolvePrompt(
  parsed: FusionArgs,
  ctx: ResolveContext,
  signal: AbortSignal,
): Promise<{ prompt: string; displayPrompt?: string; capsule?: Capsule }> {
  if (parsed.error) throw new FusionInputError("invalid-arguments", parsed.error.message);
  if (!parsed.capsuleReference) {
    if (!parsed.filePath) return { prompt: parsed.text };
    const bundle = await readBundleFile(parsed.filePath);
    ctx.ui.notify(
      `Fusion: loaded ${(bundle.length / 1024).toFixed(1)} KB bundle from file`,
      "info",
    );
    return { prompt: parsed.text ? `${parsed.text}\n\n${bundle}` : bundle };
  }

  const capsule = await prepareCapsule(parsed.capsuleReference, ctx, signal);
  const preview = previewCapsule(capsule);
  const taskPreview =
    parsed.text || "(none — use the capsule's recorded objective and next action)";
  ctx.ui.notify(
    [
      "Fusion Context Capsule preview (complete bounded input)",
      preview.humanText,
      `\n## Additional task text\n${taskPreview}`,
      `\nCanonical representation: ${preview.byteLength} UTF-8 bytes`,
    ].join("\n"),
    "info",
  );
  if (ctx.hasUI === false || !ctx.ui.confirm) {
    throw new FusionInputError(
      "confirmation-unavailable",
      "Fusion capsule input requires explicit interactive confirmation; no model calls were made.",
    );
  }
  const confirmed = await ctx.ui.confirm(
    "Run Fusion with this Context Capsule?",
    "The complete bounded capsule preview and additional task text above will be sent to Fusion models.",
  );
  if (!confirmed) throw new FusionInputError("cancelled", "Fusion cancelled.");
  if (signal.aborted) throw new FusionInputError("cancelled", "Fusion cancelled.");

  const context = capsulePrompt(capsule);
  return {
    prompt: parsed.text ? `${context}\n\nAdditional task text:\n${parsed.text}` : context,
    displayPrompt: parsed.text || "Context Capsule objective and next action",
    capsule,
  };
}

function hasSuccessfulPanelResponse(result: FusionResult): boolean {
  return result.responses.some((response) => response.status === "ok");
}

export default function fusionExtension(pi: ExtensionAPI) {
  pi.registerMessageRenderer<FusionPanelDetails>(FUSION_MESSAGE_TYPE, (message, { expanded }) => {
    const markdown = renderFusionPanelMarkdown(message.details, expanded);
    return new Markdown(markdown, 1, 0, getMarkdownTheme());
  });

  pi.registerCommand("fusion", {
    description: "Run a configured multi-model Fusion panel and judge",
    handler: async (args, ctx) => {
      const parsed = parseFusionArgs(args);
      if (parsed.error) {
        ctx.ui.notify(parsed.error.message, "error");
        return;
      }
      if (!parsed.filePath && !parsed.capsuleReference && !parsed.text) {
        ctx.ui.notify(
          "Usage: /fusion <prompt>  |  /fusion --file <path> [prompt] | /fusion --capsule <current|id-or-path> [task]",
          "error",
        );
        return;
      }

      const controller = new AbortController();
      let progressState = createProgressState();
      let debugLogger: FusionDebugLogger | undefined;
      const updateProgress = (message: string) => {
        ctx.ui.setStatus(LOADER_KEY, message.replace(/\n/g, " · "));
        ctx.ui.setWidget(LOADER_KEY, (tui, theme) => {
          const loader = new BorderedLoader(tui, theme, message, { cancellable: true });
          loader.onAbort = () => controller.abort();
          return loader;
        });
      };
      updateProgress("Fusion: loading config…");

      try {
        const resolvedInput = await resolvePrompt(parsed, ctx, controller.signal);
        const config = await loadFusionConfig();
        const prompt = resolvedInput.prompt;
        const debugLogPath = resolveFusionDebugLogPath(config);
        debugLogger = debugLogPath ? createFusionDebugLogger(debugLogPath) : undefined;
        if (debugLogger) {
          debugLogger.log("command-started", {
            promptChars: prompt.length,
            capsuleRevision: resolvedInput.capsule
              ? `${resolvedInput.capsule.capsuleId}@${resolvedInput.capsule.revision}`
              : undefined,
            judge: config.judge,
            models: config.models,
            maxToolCalls: config.maxToolCalls,
          });
          ctx.ui.notify(`Fusion debug log: ${debugLogger.path}`, "info");
        }
        progressState = createProgressState(config);
        updateProgress(formatProgress(progressState));
        const result = await runFusion({
          prompt,
          displayPrompt: resolvedInput.displayPrompt,
          capsule: resolvedInput.capsule
            ? {
                capsuleId: resolvedInput.capsule.capsuleId,
                revision: resolvedInput.capsule.revision,
              }
            : undefined,
          config,
          registry: ctx.modelRegistry,
          signal: controller.signal,
          onProgress: (event) => {
            debugLogger?.log("progress", progressLogDetails(event));
            progressState = reduceProgress(progressState, event);
            updateProgress(formatProgress(progressState));
          },
        });
        if (controller.signal.aborted) {
          throw new FusionInputError("cancelled", "Fusion cancelled.");
        }
        debugLogger?.log("result", resultLogDetails(result));
        await debugLogger?.flush();
        if (controller.signal.aborted) {
          throw new FusionInputError("cancelled", "Fusion cancelled.");
        }

        if (result.status === "error" && !hasSuccessfulPanelResponse(result)) {
          ctx.ui.notify(result.error ?? "Fusion failed", "error");
          return;
        }
        if (result.status === "error") {
          ctx.ui.notify(
            result.error ?? "Fusion judge failed; recovering from panel responses",
            "error",
          );
        }

        debugLogger?.log("synthesis-triggered", {
          activeModel: ctx.model?.id,
          recovery: result.status === "error",
        });
        await debugLogger?.flush();
        if (controller.signal.aborted) {
          throw new FusionInputError("cancelled", "Fusion cancelled.");
        }
        pi.sendMessage(toFusionPanelMessage(result), { triggerTurn: true });
      } catch (error) {
        if (
          controller.signal.aborted ||
          (error instanceof FusionInputError && error.code === "cancelled")
        ) {
          debugLogger?.log("cancelled");
          await debugLogger?.flush();
          ctx.ui.notify("Fusion cancelled", "info");
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        debugLogger?.log("failed", { error: message });
        await debugLogger?.flush();
        ctx.ui.notify(`Fusion failed: ${message}`, "error");
      } finally {
        ctx.ui.setStatus(LOADER_KEY, undefined);
        ctx.ui.setWidget(LOADER_KEY, undefined);
      }
    },
  });
}
