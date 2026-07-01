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
  ui: { notify: (message: string, level?: string) => void };
}

async function resolvePrompt(parsed: FusionArgs, ctx: ResolveContext): Promise<string> {
  if (!parsed.filePath) {
    return parsed.text;
  }

  const bundle = await readBundleFile(parsed.filePath);
  ctx.ui.notify(`Fusion: loaded ${(bundle.length / 1024).toFixed(1)} KB bundle from file`, "info");
  return parsed.text ? `${parsed.text}\n\n${bundle}` : bundle;
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
      if (!parsed.filePath && !parsed.text) {
        ctx.ui.notify("Usage: /fusion <prompt>  |  /fusion --file <path> [prompt]", "error");
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
        const prompt = await resolvePrompt(parsed, ctx);
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
            progressState = reduceProgress(progressState, event);
            updateProgress(formatProgress(progressState));
          },
        });
        debugLogger?.log("result", resultLogDetails(result));
        await debugLogger?.flush();

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
        pi.sendMessage(toFusionPanelMessage(result), { triggerTurn: true });
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
