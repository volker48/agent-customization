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
import { loadFusionConfig } from "./config.js";
import { runFusion } from "./orchestrator.js";
import type { FusionConfig, FusionProgressEvent } from "./types.js";
import {
  FUSION_MESSAGE_TYPE,
  type FusionResultDetails,
  renderFusionMarkdown,
  toFusionMessage,
} from "./render.js";

const LOADER_KEY = "fusion";

export default function fusionExtension(pi: ExtensionAPI) {
  pi.registerMessageRenderer<FusionResultDetails>(FUSION_MESSAGE_TYPE, (message, { expanded }) => {
    const content = contentToString(message.content);
    const markdown = renderFusionMarkdown(content, message.details, expanded);
    return new Markdown(markdown, 1, 0, getMarkdownTheme());
  });

  pi.registerCommand("fusion", {
    description: "Run a configured multi-model Fusion panel and judge",
    handler: async (args, ctx) => {
      const prompt = args.trim();
      if (!prompt) {
        ctx.ui.notify("Usage: /fusion <prompt>", "error");
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
        const config = await loadFusionConfig();
        const debugLogPath = resolveFusionDebugLogPath(config);
        debugLogger = debugLogPath ? createFusionDebugLogger(debugLogPath) : undefined;
        if (debugLogger) {
          debugLogger.log("command-started", {
            promptChars: prompt.length,
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
          config,
          registry: ctx.modelRegistry,
          signal: controller.signal,
          onProgress: (event) => {
            debugLogger?.log("progress", progressLogDetails(event));
            applyProgressEvent(progressState, event);
            updateProgress(formatProgress(progressState));
          },
        });
        debugLogger?.log("result", resultLogDetails(result));
        await debugLogger?.flush();

        if (result.status === "error") {
          ctx.ui.notify(result.error ?? "Fusion failed", "error");
          return;
        }

        pi.sendMessage(toFusionMessage(result));
      } catch (error) {
        if (controller.signal.aborted) {
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

interface ProgressState {
  phase: string;
  judge: string;
  judgeStatus: "pending" | "running" | "ok";
  panels: Map<string, "pending" | "running" | "ok" | "error">;
}

function createProgressState(config?: FusionConfig): ProgressState {
  return {
    phase: config ? "resolving models" : "loading config",
    judge: config?.judge ?? "pending",
    judgeStatus: "pending",
    panels: new Map(config?.models.map((model) => [model, "pending"])),
  };
}

function applyProgressEvent(state: ProgressState, event: FusionProgressEvent): void {
  if (event.phase === "resolving-models") {
    state.phase = "resolving models";
    state.judge = event.judge;
    state.panels = new Map(event.models.map((model) => [model, "pending"]));
    return;
  }
  if (event.phase === "panel-started") {
    state.phase = "running panel";
    state.panels.set(event.model, "running");
    return;
  }
  if (event.phase === "panel-finished") {
    state.panels.set(event.model, event.status);
    state.phase = allPanelsDone(state) ? "running judge" : "running panel";
    return;
  }
  if (event.phase === "judge-started") {
    state.phase = "running judge";
    state.judge = event.model;
    state.judgeStatus = "running";
    return;
  }
  if (event.phase === "judge-finished") {
    state.phase = "complete";
    state.judgeStatus = "ok";
  }
}

function formatProgress(state: ProgressState): string {
  const entries = [...state.panels.entries()];
  const done = entries.filter(([, status]) => status === "ok" || status === "error").length;
  const lines = [`Fusion: ${state.phase}`, `Panel: ${done}/${entries.length} complete`];
  for (const [model, status] of entries) {
    lines.push(`- ${statusIcon(status)} ${model}`);
  }
  lines.push(`Judge: ${statusIcon(state.judgeStatus)} ${state.judge}`);
  return lines.join("\n");
}

function statusIcon(status: "pending" | "running" | "ok" | "error"): string {
  if (status === "ok") return "✓";
  if (status === "error") return "✗";
  if (status === "running") return "…";
  return "•";
}

function allPanelsDone(state: ProgressState): boolean {
  return [...state.panels.values()].every((status) => status === "ok" || status === "error");
}

function contentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : ""))
      .join("");
  }
  return String(content ?? "");
}
