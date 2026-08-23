import {
  BorderedLoader,
  getAgentDir,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import { parseLavRunArgs, LAV_RUN_USAGE } from "../run/args.js";
import { resolveLavCachePath } from "../run/cache-path.js";
import { GitLavRepositoryFactory } from "../run/git.js";
import { CleanupFailedError, formatLavProgress, runLav } from "../run/orchestrator.js";
import type { CandidateSelector, LavProgressEvent, LavRunConfig } from "../run/types.js";
import { PiAgentSessionCandidateRunner } from "./candidate-runner.js";
import {
  PiVerifierModelClient,
  requirePiModelRegistry,
  resolveVerifierModel,
} from "./model-client.js";
import { selectWithNativeVerifier } from "./native-selection.js";

const LOADER_KEY = "lav-run";
const DEFAULT_MODEL_ENV = "PI_LAV_VERIFIER_MODEL";
const DEFAULT_CACHE_ENV = "PI_LAV_CACHE_PATH";

export async function handleLavRunCommand(
  rawArgs: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const parsed = parseLavRunArgs(rawArgs, {
    verifierModelRef: process.env[DEFAULT_MODEL_ENV],
    cachePath: process.env[DEFAULT_CACHE_ENV],
  });
  if (parsed.help) {
    ctx.ui.notify(LAV_RUN_USAGE, "info");
    return;
  }
  if (parsed.error || !parsed.config) {
    ctx.ui.notify(`${parsed.error ?? "Invalid /lav-run arguments"}\n\n${LAV_RUN_USAGE}`, "error");
    return;
  }
  if (!ctx.model) {
    ctx.ui.notify("LAV candidate generation requires an active Pi model.", "error");
    return;
  }

  let cachePath: string | undefined;
  try {
    cachePath = resolveLavCachePath(parsed.config.cachePath, getAgentDir());
  } catch (error) {
    ctx.ui.notify(`Invalid verifier cache path: ${errorMessage(error)}`, "error");
    return;
  }
  const config: LavRunConfig = {
    ...parsed.config,
    cachePath,
  };
  const controller = new AbortController();
  const commandSignal = ctx.signal;
  const onCommandAbort = () => controller.abort(commandSignal?.reason);
  if (commandSignal?.aborted) {
    onCommandAbort();
  } else {
    commandSignal?.addEventListener("abort", onCommandAbort, { once: true });
  }
  let progressMessage = "LAV: preparing isolated worktrees";
  const updateProgress = (event?: LavProgressEvent) => {
    if (event) progressMessage = formatLavProgress(event);
    ctx.ui.setStatus(LOADER_KEY, progressMessage.replace(/\n/g, " · "));
    ctx.ui.setWidget(LOADER_KEY, (tui, theme) => {
      const loader = new BorderedLoader(tui, theme, progressMessage, {
        cancellable: true,
      });
      loader.onAbort = () => controller.abort();
      return loader;
    });
  };

  try {
    updateProgress();
    const verifier = createVerifierDependencies(config, ctx);
    const result = await runLav(
      ctx.cwd,
      config,
      {
        repositoryFactory: new GitLavRepositoryFactory(),
        candidateRunner: new PiAgentSessionCandidateRunner({
          model: ctx.model,
          thinkingLevel: ctx.thinkingLevel,
        }),
        selector: verifier.selector,
        preflight: verifier.preflight,
        onProgress: updateProgress,
      },
      controller.signal,
    );

    const failures = result.candidates.filter((candidate) => candidate.status !== "completed");
    const application = config.applyWinner
      ? result.applicationError
        ? `The frozen winning patch was not applied: ${result.applicationError}`
        : result.applied
          ? "The frozen winning patch was applied unstaged."
          : "The selected candidate produced no repository patch."
      : "The winning patch was not applied because --no-apply was used.";
    const recovery =
      !result.applied && result.winnerPatchPath ? `Recovery patch: ${result.winnerPatchPath}` : "";
    const cleanup = result.cleanupError ? `Cleanup also failed: ${result.cleanupError}` : "";
    ctx.ui.notify(
      [
        `LAV selected candidate ${result.selectedCandidateIndex + 1}.`,
        application,
        recovery,
        cleanup,
        failures.length
          ? `${failures.length} candidate(s) failed or were cancelled and were ` +
            "excluded from verification."
          : "",
        result.verifierRunHash ? `Verifier run: ${result.verifierRunHash}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      failures.length || result.applicationError || result.cleanupError ? "warning" : "info",
    );
  } catch (error) {
    if (
      !(error instanceof CleanupFailedError) &&
      (controller.signal.aborted || isAbortError(error))
    ) {
      ctx.ui.notify("LAV run cancelled; candidate sessions and worktrees were cleaned up.", "info");
      return;
    }
    ctx.ui.notify(`LAV run failed: ${errorMessage(error)}`, "error");
  } finally {
    commandSignal?.removeEventListener("abort", onCommandAbort);
    ctx.ui.setStatus(LOADER_KEY, undefined);
    ctx.ui.setWidget(LOADER_KEY, undefined);
  }
}

function createVerifierDependencies(
  config: LavRunConfig,
  ctx: ExtensionCommandContext,
): {
  selector: CandidateSelector;
  preflight?: (signal: AbortSignal) => Promise<void>;
} {
  if (config.candidateCount === 1) {
    return {
      selector: {
        select: async () => {
          throw new Error("The verifier must not run for a single candidate");
        },
      },
    };
  }

  const registry = requirePiModelRegistry(ctx.modelRegistry);
  const model = resolveVerifierModel(registry, config.verifierModelRef);
  const client = new PiVerifierModelClient(registry, { model });

  return {
    preflight: async (signal) => client.assertCapabilities(signal),
    selector: {
      select: async (input) =>
        selectWithNativeVerifier({
          problem: input.problem,
          candidates: input.candidates,
          criteria: input.criteria,
          repetitions: input.repetitions,
          pivots: input.pivots,
          seed: input.seed,
          client,
          cachePath: input.cachePath,
          cachePathGuard: input.cachePathGuard,
          maxConcurrency: input.maxConcurrency,
          signal: input.signal,
          preflight: false,
        }),
    },
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  if (error instanceof CleanupFailedError) {
    return `${plainErrorMessage(error.primaryError)} Cleanup also failed: ${error.cleanupError}`;
  }
  return plainErrorMessage(error);
}

function plainErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
