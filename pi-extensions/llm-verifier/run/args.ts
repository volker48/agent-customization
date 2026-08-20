import { DEFAULT_CODING_CRITERIA } from "../core/prompt.js";
import type { Criterion } from "../core/types.js";
import type { LavRunConfig } from "./types.js";

const DEFAULT_CANDIDATE_COUNT = 3;
const DEFAULT_REPETITIONS = 2;
const DEFAULT_PIVOTS = 2;
const DEFAULT_SEED = 0;
const DEFAULT_CANDIDATE_CONCURRENCY = 2;
const DEFAULT_VERIFIER_CONCURRENCY = 4;

export interface LavRunArgumentDefaults {
  verifierModelRef?: string;
  cachePath?: string;
}

export interface LavRunArgumentResult {
  config?: LavRunConfig;
  error?: string;
  help: boolean;
}

export const LAV_RUN_USAGE =
  "Usage: /lav-run [options] -- <task>\n" +
  "Options:\n" +
  "  --candidates <1-8>\n" +
  "  --verifier <provider/model>\n" +
  "  --criteria <all|comma-separated built-in criterion ids>\n" +
  "  --repetitions <1-8>\n" +
  "  --pivots <0-16>\n" +
  "  --seed <safe integer>\n" +
  "  --candidate-concurrency <1-8>\n" +
  "  --verifier-concurrency <1-32>\n" +
  "  --cache <path> | --no-cache (relative paths use Pi state)\n" +
  "  --apply | --no-apply\n" +
  "\n" +
  "V1 requires the primary Git worktree to be clean. The selected patch is applied unstaged.";

export function parseLavRunArgs(
  raw: string,
  defaults: LavRunArgumentDefaults = {},
): LavRunArgumentResult {
  let tokens: string[];
  try {
    tokens = tokenize(raw);
  } catch (error) {
    return { error: errorMessage(error), help: false };
  }

  let candidateCount = DEFAULT_CANDIDATE_COUNT;
  let verifierModelRef = defaults.verifierModelRef?.trim() ?? "";
  let criteria: readonly Criterion[] = DEFAULT_CODING_CRITERIA;
  let repetitions = DEFAULT_REPETITIONS;
  let pivots = DEFAULT_PIVOTS;
  let seed = DEFAULT_SEED;
  let candidateConcurrency = DEFAULT_CANDIDATE_CONCURRENCY;
  let verifierConcurrency = DEFAULT_VERIFIER_CONCURRENCY;
  let cachePath = defaults.cachePath?.trim() || undefined;
  let applyWinner = true;
  const taskTokens: string[] = [];
  let taskOnly = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (taskOnly) {
      taskTokens.push(token);
      continue;
    }
    if (token === "--") {
      taskOnly = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      return { help: true };
    }
    if (!token.startsWith("--")) {
      taskTokens.push(token);
      continue;
    }

    const parsed = splitFlag(token);
    const readValue = (): string => {
      if (parsed.value !== undefined) return parsed.value;
      const value = tokens[index + 1];
      if (value === undefined || value === "--" || value.startsWith("--")) {
        throw new Error(`${parsed.name} requires a value`);
      }
      index += 1;
      return value;
    };

    try {
      switch (parsed.name) {
        case "--candidates":
          candidateCount = boundedInteger(readValue(), 1, 8, "--candidates");
          break;
        case "--verifier":
          verifierModelRef = readValue().trim();
          break;
        case "--criteria":
          criteria = selectCriteria(readValue());
          break;
        case "--repetitions":
          repetitions = boundedInteger(readValue(), 1, 8, "--repetitions");
          break;
        case "--pivots":
          pivots = boundedInteger(readValue(), 0, 16, "--pivots");
          break;
        case "--seed":
          seed = safeInteger(readValue(), "--seed");
          break;
        case "--candidate-concurrency":
          candidateConcurrency = boundedInteger(readValue(), 1, 8, "--candidate-concurrency");
          break;
        case "--verifier-concurrency":
          verifierConcurrency = boundedInteger(readValue(), 1, 32, "--verifier-concurrency");
          break;
        case "--cache":
          cachePath = readValue().trim();
          if (!cachePath) throw new Error("--cache requires a non-empty path");
          break;
        case "--no-cache":
          rejectInlineValue(parsed);
          cachePath = undefined;
          break;
        case "--apply":
          rejectInlineValue(parsed);
          applyWinner = true;
          break;
        case "--no-apply":
          rejectInlineValue(parsed);
          applyWinner = false;
          break;
        default:
          throw new Error(`Unknown /lav-run option: ${parsed.name}`);
      }
    } catch (error) {
      return { error: errorMessage(error), help: false };
    }
  }

  const task = taskTokens.join(" ").trim();
  if (!task) {
    return {
      error: "A task is required. Put -- before task text that begins with a flag.",
      help: false,
    };
  }
  if (candidateCount > 1 && !verifierModelRef) {
    return {
      error:
        "A verifier model is required for multiple candidates. Pass --verifier " +
        "provider/model or set PI_LAV_VERIFIER_MODEL.",
      help: false,
    };
  }
  const verifierSlash = verifierModelRef.indexOf("/");
  if (verifierModelRef && (verifierSlash <= 0 || verifierSlash === verifierModelRef.length - 1)) {
    return {
      error: `Expected verifier model as provider/model, got ${verifierModelRef}`,
      help: false,
    };
  }

  return {
    help: false,
    config: {
      task,
      candidateCount,
      verifierModelRef,
      criteria,
      repetitions,
      pivots,
      seed,
      candidateConcurrency: Math.min(candidateConcurrency, candidateCount),
      verifierConcurrency,
      cachePath,
      applyWinner,
    },
  };
}

function selectCriteria(value: string): readonly Criterion[] {
  const normalized = value.trim();
  if (!normalized || normalized === "all") return DEFAULT_CODING_CRITERIA;
  const byId = new Map(DEFAULT_CODING_CRITERIA.map((criterion) => [criterion.id, criterion]));
  const selected = normalized
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (selected.length === 0) throw new Error("--criteria must select at least one criterion");
  const unique = new Set<string>();
  return selected.map((id) => {
    if (unique.has(id)) throw new Error(`Duplicate criterion id: ${id}`);
    unique.add(id);
    const criterion = byId.get(id);
    if (!criterion) {
      throw new Error(
        `Unknown criterion id ${id}. Built-ins: ${DEFAULT_CODING_CRITERIA.map(
          (item) => item.id,
        ).join(", ")}`,
      );
    }
    return criterion;
  });
}

function splitFlag(token: string): { name: string; value?: string } {
  const equals = token.indexOf("=");
  return equals < 0
    ? { name: token }
    : { name: token.slice(0, equals), value: token.slice(equals + 1) };
}

function rejectInlineValue(flag: { name: string; value?: string }): void {
  if (flag.value !== undefined) throw new Error(`${flag.name} does not accept a value`);
}

function boundedInteger(value: string, minimum: number, maximum: number, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function safeInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} must be a safe integer`);
  return parsed;
}

function tokenize(raw: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let started = false;

  const flush = () => {
    if (!started) return;
    tokens.push(current);
    current = "";
    started = false;
  };

  for (const character of raw) {
    if (escaped) {
      current += character;
      escaped = false;
      started = true;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      flush();
      continue;
    }
    current += character;
    started = true;
  }
  if (escaped) throw new Error("Trailing escape in /lav-run arguments");
  if (quote) throw new Error("Unterminated quote in /lav-run arguments");
  flush();
  return tokens;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
