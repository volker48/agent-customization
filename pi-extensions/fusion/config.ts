import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseModelRef } from "./model-ref.js";
import type { FusionConfig, ReasoningEffort } from "./types.js";

const DEFAULT_MAX_TOOL_CALLS = 8;
const MAX_PANEL_MODELS = 8;
const REASONING_EFFORTS: readonly ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh"];

export function defaultConfigPath(): string {
  return process.env.PI_FUSION_CONFIG?.trim() || join(homedir(), ".pi", "agent", "fusion.json");
}

export async function loadFusionConfig(path = defaultConfigPath()): Promise<FusionConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read Fusion config at ${path}: ${message}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid Fusion config JSON at ${path}: ${message}`);
  }

  return validateFusionConfig(value);
}

export function validateFusionConfig(value: unknown): FusionConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Fusion config must be a JSON object");
  }

  const config = value as Partial<FusionConfig>;
  if (typeof config.judge !== "string") {
    throw new Error("Fusion config requires string field: judge");
  }
  parseModelRef(config.judge);

  if (!Array.isArray(config.models) || config.models.length === 0) {
    throw new Error("Fusion config requires non-empty array field: models");
  }
  if (config.models.length > MAX_PANEL_MODELS) {
    throw new Error(`Fusion config supports at most ${MAX_PANEL_MODELS} panel models`);
  }
  for (const model of config.models) {
    if (typeof model !== "string") {
      throw new Error("Fusion config models must be provider/model strings");
    }
    parseModelRef(model);
  }

  const maxToolCalls = config.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  if (!Number.isInteger(maxToolCalls) || maxToolCalls < 0 || maxToolCalls > 64) {
    throw new Error("Fusion config maxToolCalls must be an integer from 0 to 64");
  }

  validateOptionalFields(config);

  return { ...config, judge: config.judge, models: config.models, maxToolCalls };
}

function validateOptionalFields(config: Partial<FusionConfig>): void {
  if (config.maxCompletionTokens !== undefined) {
    const tokens = config.maxCompletionTokens;
    if (!Number.isInteger(tokens) || tokens < 1) {
      throw new Error("Fusion config maxCompletionTokens must be a positive integer");
    }
  }

  const effort = config.reasoning?.effort;
  if (effort !== undefined && !REASONING_EFFORTS.includes(effort)) {
    throw new Error(
      `Fusion config reasoning.effort must be one of: ${REASONING_EFFORTS.join(", ")}`,
    );
  }

  if (config.debugLogPath !== undefined && typeof config.debugLogPath !== "string") {
    throw new Error("Fusion config debugLogPath must be a string");
  }
}
