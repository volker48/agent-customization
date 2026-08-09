import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  MAX_NUM_RESULTS,
  MAX_TEXT_MAX_CHARACTERS,
  MIN_NUM_RESULTS,
  MIN_TEXT_MAX_CHARACTERS,
} from "../lib/exa-search-core.js";
import {
  FETCH_STRATEGIES,
  MAX_MAX_CHARS as MAX_WEBFETCH_CHARS,
  MIN_MAX_CHARS as MIN_WEBFETCH_CHARS,
} from "../lib/webfetch-core.js";
import { parseModelRef } from "./model-ref.js";
import type {
  FusionConfig,
  FusionReasoning,
  ReasoningEffort,
  WebFetchPolicy,
  WebSearchPolicy,
} from "./types.js";

const DEFAULT_MAX_TOOL_CALLS = 8;
export const DEFAULT_MAX_BINARY_QUESTIONS = 15;
const MAX_BINARY_QUESTIONS = 64;
const MAX_PANEL_MODELS = 8;
const REASONING_EFFORTS: readonly ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh"];

const CONFIG_KEYS = [
  "judge",
  "models",
  "maxToolCalls",
  "maxCompletionTokens",
  "reasoning",
  "webSearch",
  "webfetch",
  "debugLogPath",
  "maxBinaryQuestions",
] as const;

const REASONING_KEYS = ["effort"] as const;
const WEB_SEARCH_KEYS = ["numResults", "textMaxCharacters", "excludedDomains"] as const;
const WEBFETCH_KEYS = ["strategy", "maxChars", "blockedDomains"] as const;

interface FusionConfigJson {
  judge?: unknown;
  models?: unknown;
  maxToolCalls?: unknown;
  maxCompletionTokens?: unknown;
  reasoning?: unknown;
  webSearch?: unknown;
  webfetch?: unknown;
  debugLogPath?: unknown;
  maxBinaryQuestions?: unknown;
}

interface FusionReasoningJson {
  effort?: unknown;
}

interface WebSearchPolicyJson {
  numResults?: unknown;
  textMaxCharacters?: unknown;
  excludedDomains?: unknown;
}

interface WebFetchPolicyJson {
  strategy?: unknown;
  maxChars?: unknown;
  blockedDomains?: unknown;
}

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
  const object = readFusionConfigJson(value);

  const judge = readRequiredString(object.judge, "Fusion config requires string field: judge");
  parseModelRef(judge);
  const models = readModels(object.models);
  const maxToolCalls = readOptionalInteger({
    value: object.maxToolCalls,
    defaultValue: DEFAULT_MAX_TOOL_CALLS,
    min: 0,
    max: 64,
    label: "Fusion config maxToolCalls",
  });
  const maxBinaryQuestions = readOptionalInteger({
    value: object.maxBinaryQuestions,
    defaultValue: DEFAULT_MAX_BINARY_QUESTIONS,
    min: 1,
    max: MAX_BINARY_QUESTIONS,
    label: "Fusion config maxBinaryQuestions",
  });

  const config: FusionConfig = { judge, models, maxToolCalls, maxBinaryQuestions };
  const maxCompletionTokens = readMaxCompletionTokens(object.maxCompletionTokens);
  const reasoning = readReasoning(object.reasoning);
  const webSearch = readWebSearchPolicy(object.webSearch);
  const webfetch = readWebFetchPolicy(object.webfetch);
  const debugLogPath = readDebugLogPath(object.debugLogPath);

  if (maxCompletionTokens !== undefined) config.maxCompletionTokens = maxCompletionTokens;
  if (reasoning !== undefined) config.reasoning = reasoning;
  if (webSearch !== undefined) config.webSearch = webSearch;
  if (webfetch !== undefined) config.webfetch = webfetch;
  if (debugLogPath !== undefined) config.debugLogPath = debugLogPath;
  return config;
}

function readFusionConfigJson(value: unknown): FusionConfigJson {
  const object = readJsonObject(value, "Fusion config");
  rejectUnknownKeys(object, "Fusion config", CONFIG_KEYS);
  return object as FusionConfigJson;
}

function readJsonObject(value: unknown, label: string): object {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

function rejectUnknownKeys(object: object, label: string, allowedKeys: readonly string[]): void {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(object).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} has unknown field: ${unknown[0]}`);
  }
}

function readRequiredString(value: unknown, message: string): string {
  if (typeof value !== "string") throw new Error(message);
  return value;
}

function readModels(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Fusion config requires non-empty array field: models");
  }
  if (value.length > MAX_PANEL_MODELS) {
    throw new Error(`Fusion config supports at most ${MAX_PANEL_MODELS} panel models`);
  }

  const models = value.map(readModelRef);
  if (new Set(models).size !== models.length) {
    throw new Error("Fusion config models must not contain duplicates");
  }
  return models;
}

function readModelRef(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Fusion config models must be provider/model strings");
  }
  parseModelRef(value);
  return value;
}

function readMaxCompletionTokens(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error("Fusion config maxCompletionTokens must be a positive integer");
  }
  return value;
}

function readReasoning(value: unknown): FusionReasoning | undefined {
  if (value === undefined) return undefined;
  const object = readJsonObject(value, "Fusion config reasoning") as FusionReasoningJson;
  rejectUnknownKeys(object, "Fusion config reasoning", REASONING_KEYS);

  const effort = object.effort;
  if (effort === undefined) return {};
  if (typeof effort !== "string" || !REASONING_EFFORTS.includes(effort as ReasoningEffort)) {
    throw new Error(
      `Fusion config reasoning.effort must be one of: ${REASONING_EFFORTS.join(", ")}`,
    );
  }
  return { effort: effort as ReasoningEffort };
}

function readWebSearchPolicy(value: unknown): WebSearchPolicy | undefined {
  if (value === undefined) return undefined;
  const object = readJsonObject(value, "Fusion config webSearch") as WebSearchPolicyJson;
  rejectUnknownKeys(object, "Fusion config webSearch", WEB_SEARCH_KEYS);

  return {
    numResults: readOptionalInteger({
      value: object.numResults,
      min: MIN_NUM_RESULTS,
      max: MAX_NUM_RESULTS,
      label: "Fusion config webSearch.numResults",
    }),
    textMaxCharacters: readOptionalInteger({
      value: object.textMaxCharacters,
      min: MIN_TEXT_MAX_CHARACTERS,
      max: MAX_TEXT_MAX_CHARACTERS,
      label: "Fusion config webSearch.textMaxCharacters",
    }),
    excludedDomains: readOptionalStringArray(
      object.excludedDomains,
      "Fusion config webSearch.excludedDomains",
    ),
  };
}

function readWebFetchPolicy(value: unknown): WebFetchPolicy | undefined {
  if (value === undefined) return undefined;
  const object = readJsonObject(value, "Fusion config webfetch") as WebFetchPolicyJson;
  rejectUnknownKeys(object, "Fusion config webfetch", WEBFETCH_KEYS);

  return {
    strategy: readWebFetchStrategy(object.strategy),
    maxChars: readOptionalInteger({
      value: object.maxChars,
      min: MIN_WEBFETCH_CHARS,
      max: MAX_WEBFETCH_CHARS,
      label: "Fusion config webfetch.maxChars",
    }),
    blockedDomains: readOptionalStringArray(
      object.blockedDomains,
      "Fusion config webfetch.blockedDomains",
    ),
  };
}

function readWebFetchStrategy(value: unknown): WebFetchPolicy["strategy"] | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !FETCH_STRATEGIES.includes(value as WebFetchPolicy["strategy"])
  ) {
    throw new Error(
      `Fusion config webfetch.strategy must be one of: ${FETCH_STRATEGIES.join(", ")}`,
    );
  }
  return value as WebFetchPolicy["strategy"];
}

function readDebugLogPath(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error("Fusion config debugLogPath must be a string");
  }
  return value;
}

function readOptionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return value;
}

function readOptionalInteger(args: {
  value: unknown;
  defaultValue?: number;
  min: number;
  max: number;
  label: string;
}): number | undefined {
  if (args.value === undefined) return args.defaultValue;
  if (
    typeof args.value !== "number" ||
    !Number.isInteger(args.value) ||
    args.value < args.min ||
    args.value > args.max
  ) {
    throw new Error(`${args.label} must be an integer from ${args.min} to ${args.max}`);
  }
  return args.value;
}
