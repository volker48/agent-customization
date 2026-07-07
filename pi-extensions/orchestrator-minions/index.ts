import {
  CONFIG_DIR_NAME,
  getAgentDir,
  getMarkdownTheme,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import {
  COMMAND_USAGE,
  ORCHESTRATOR_MINIONS_MESSAGE_TYPE,
  buildInstallTargets,
  parseOrchestratorMinionsArgs,
  renderInstallMarkdown,
  toInstallMessage,
  writeInstallTargets,
  type InstallDetails,
  type ParsedOrchestratorMinionsArgs,
} from "./assets.js";

const STATUS_KEY = "orchestrator-minions";

interface ModelLike {
  provider?: string;
  id?: string;
}

function currentModelRef(model: ModelLike | undefined): string | undefined {
  if (!model?.provider || !model.id) return undefined;
  return `${model.provider}/${model.id}`;
}

function resolveModelRef(
  parsed: ParsedOrchestratorMinionsArgs,
  ctx: ExtensionCommandContext,
): string | undefined {
  return parsed.modelRef ?? currentModelRef(ctx.model as ModelLike | undefined);
}

function notifyUsage(ctx: ExtensionCommandContext, message: string): void {
  ctx.ui.notify(`${message}\n${COMMAND_USAGE}`, "error");
}

async function installAssets(
  pi: ExtensionAPI,
  parsed: ParsedOrchestratorMinionsArgs,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const modelRef = resolveModelRef(parsed, ctx);
  if (!modelRef) {
    notifyUsage(ctx, "No current model is available. Pass --model provider/model.");
    return;
  }

  ctx.ui.setStatus(STATUS_KEY, "writing orchestrator-minions assets…");
  try {
    const targets = buildInstallTargets({
      agentDir: getAgentDir(),
      configDirName: CONFIG_DIR_NAME,
      cwd: ctx.cwd,
      scope: parsed.scope,
      profileName: parsed.profileName,
      chainName: parsed.chainName,
      modelRef,
    });
    const results = await writeInstallTargets(targets, parsed.overwrite);
    const details: InstallDetails = {
      scope: parsed.scope,
      profileName: parsed.profileName,
      chainName: parsed.chainName,
      modelRef,
      results,
    };

    const skipped = results.filter((result) => result.status === "skipped");
    if (skipped.length > 0) {
      ctx.ui.notify(
        "Some files already exist; re-run with --overwrite to replace them.",
        "warning",
      );
    }
    pi.sendMessage(toInstallMessage(details));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`orchestrator-minions failed: ${message}`, "error");
  } finally {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  }
}

async function handleCommand(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const parsed = parseOrchestratorMinionsArgs(args);
  if (!parsed.ok || !parsed.value) {
    notifyUsage(ctx, parsed.error ?? "Invalid arguments.");
    return;
  }
  if (parsed.value.action === "help") {
    ctx.ui.notify(COMMAND_USAGE, "info");
    return;
  }
  await installAssets(pi, parsed.value, ctx);
}

export default function orchestratorMinionsExtension(pi: ExtensionAPI) {
  pi.registerMessageRenderer<InstallDetails>(ORCHESTRATOR_MINIONS_MESSAGE_TYPE, (message) => {
    if (!message.details) return undefined;
    return new Markdown(renderInstallMarkdown(message.details), 1, 0, getMarkdownTheme());
  });

  pi.registerCommand("orchestrator-minions", {
    description: "Install orchestrator-minion subagent assets",
    handler: (args, ctx) => handleCommand(pi, args, ctx),
  });
}

export { currentModelRef, handleCommand };
