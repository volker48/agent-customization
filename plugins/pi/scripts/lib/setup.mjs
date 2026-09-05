import { spawnSync } from "node:child_process";

import { PiRpcClient } from "./pi-rpc-client.mjs";

export const DEFAULT_INTENDED_MODEL = "openai-codex/gpt-5.6-luna";
export const DEFAULT_THINKING_LEVEL = "xhigh";
const DEFAULT_PI_ARGS = [
  "--mode",
  "rpc",
  "--no-session",
  "--no-extensions",
  "--no-prompt-templates",
  "--no-skills",
  "--no-context-files",
];

export async function runSetup(options = {}) {
  const nodeCheck = checkExecutable(options.nodeCommand ?? "node", ["--version"]);
  const piCommand = options.piCommand ?? process.env.PI_CLI ?? "pi";
  const piArgs = options.piArgs ?? DEFAULT_PI_ARGS;
  const piCheck = checkExecutable(piCommand, options.piCheckArgs ?? ["--version"]);
  const intendedModel =
    options.intendedModel ?? process.env.PI_IMPLEMENT_MODEL ?? DEFAULT_INTENDED_MODEL;
  const client = new PiRpcClient({
    command: piCommand,
    args: piArgs,
    timeoutMs: options.timeoutMs,
  });

  let state;
  let models;
  let rpcError = null;
  if (nodeCheck.ok && piCheck.ok) {
    try {
      state = await client.request({ type: "get_state" });
      models = await client.request({ type: "get_available_models" });
    } catch (error) {
      rpcError = error instanceof Error ? error.message : String(error);
    }
  } else {
    rpcError = "Skipped because prerequisite checks failed";
  }
  const piTerminated = await client.terminate();

  return buildSetupResult({
    nodeCheck,
    piCheck,
    state,
    models,
    rpcError,
    intendedModel,
    piTerminated,
    stderr: client.stderr,
  });
}

function checkExecutable(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return {
    ok: result.status === 0,
    command,
    output: (result.stdout || result.stderr || "").trim(),
    error: result.error?.message,
  };
}

function buildSetupResult(input) {
  const model = input.state?.success ? input.state.data?.model : null;
  const availableModels = input.models?.success ? (input.models.data?.models ?? []) : [];
  const activeModel = model ? modelRef(model) : null;
  const intendedModelAvailable = availableModels.some(
    (candidate) => modelRef(candidate) === input.intendedModel,
  );
  const ok =
    input.nodeCheck.ok && input.piCheck.ok && !input.rpcError && input.state?.success === true;
  return {
    ok,
    activeModel,
    intendedModelAvailable,
    piTerminated: input.piTerminated,
    stderr: input.stderr,
    report: renderSetupReport({ ...input, activeModel, intendedModelAvailable, model, ok }),
  };
}

function renderSetupReport(data) {
  return [
    "# Pi setup check",
    statusLine("Node", data.nodeCheck.ok, data.nodeCheck.output || data.nodeCheck.error),
    statusLine("Pi CLI", data.piCheck.ok, data.piCheck.output || data.piCheck.error),
    statusLine("Pi RPC startup", !data.rpcError && data.state?.success === true, data.rpcError),
    `Active model: ${formatModel(data.activeModel, data.model)}`,
    `Intended implementation model: ${data.intendedModel}`,
    modelGuidance(data.intendedModel, data.intendedModelAvailable),
    statusLine("Pi RPC termination", data.piTerminated, undefined),
  ].join("\n");
}

function statusLine(label, ok, detail) {
  const suffix = detail ? ` (${detail})` : "";
  return `${label}: ${ok ? "ok" : "failed"}${suffix}`;
}

function formatModel(activeModel, model) {
  if (!activeModel) return "unavailable";
  return model?.name ? `${activeModel} (${model.name})` : activeModel;
}

function modelGuidance(intendedModel, available) {
  if (available) return `Intended implementation model available: ${intendedModel}`;
  return [
    `Intended implementation model unavailable: ${intendedModel}`,
    `Configure Pi with a provider/model that resolves to ${intendedModel}.`,
    "You can also run setup with PI_IMPLEMENT_MODEL=<provider/model> for a different target.",
  ].join("\n");
}

export function modelRef(model) {
  if (!model || typeof model.provider !== "string" || typeof model.id !== "string") return null;
  return `${model.provider}/${model.id}`;
}
