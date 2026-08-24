import { canonicalText, stableStringify } from "../core/cache.js";
import type { CandidateAction, CandidateRunStatus } from "./types.js";

const MAX_ACTIONS = 120;
const MAX_ACTION_INPUT_CHARS = 4_000;
const MAX_ACTION_OUTPUT_CHARS = 12_000;
const MAX_TASK_CHARS = 12_000;
const MAX_FINAL_MESSAGE_CHARS = 12_000;
const MAX_ERROR_CHARS = 4_000;
const MAX_PATCH_CHARS = 240_000;
const MAX_STATUS_CHARS = 20_000;

export interface CandidateEvidenceInput {
  task: string;
  candidateIndex: number;
  status: CandidateRunStatus;
  baseCommit: string;
  patch: string;
  patchHash: string;
  repositoryStatus: string;
  actions: readonly CandidateAction[];
  finalMessage: string;
  error: string;
  repoRoot: string;
  worktreePath: string;
}

export interface CandidateEvidenceResult {
  evidence: string;
  redactionCount: number;
}

export function buildCandidateEvidence(input: CandidateEvidenceInput): CandidateEvidenceResult {
  let redactionCount = 0;
  const clean = (value: string, maximum: number): string => {
    const withoutPaths = replaceIncidentalPaths(value, input.repoRoot, input.worktreePath);
    const redacted = redactEvidenceText(withoutPaths);
    redactionCount += redacted.redactionCount;
    return truncateWithMarker(canonicalText(redacted.value), maximum);
  };

  const patchWithoutPaths = replaceIncidentalPaths(input.patch, input.repoRoot, input.worktreePath);
  const redactedPatch = redactEvidenceText(patchWithoutPaths);
  redactionCount += redactedPatch.redactionCount;
  const canonicalPatch = canonicalText(redactedPatch.value);
  const patch = canonicalPatch.slice(0, MAX_PATCH_CHARS);

  const actions = input.actions.slice(0, MAX_ACTIONS).map((action, index) => ({
    sequence: index + 1,
    kind: action.kind,
    toolName: clean(action.toolName, 200),
    input: clean(action.input, MAX_ACTION_INPUT_CHARS),
    output: clean(action.output, MAX_ACTION_OUTPUT_CHARS),
    isError: action.isError,
  }));
  const repositoryStatus = clean(input.repositoryStatus, MAX_STATUS_CHARS);

  const packet = {
    schemaVersion: 1,
    task: clean(input.task, MAX_TASK_CHARS),
    candidate: {
      index: input.candidateIndex,
      status: input.status,
    },
    frozenBaseCommit: input.baseCommit,
    frozenPatch: {
      sha256: input.patchHash,
      text: patch,
      originalCharacters: canonicalPatch.length,
      truncated: canonicalPatch.length > MAX_PATCH_CHARS,
    },
    repositoryStatus,
    trajectory: {
      actions,
      originalActionCount: input.actions.length,
      omittedActionCount: Math.max(0, input.actions.length - actions.length),
      finalMessage: clean(input.finalMessage, MAX_FINAL_MESSAGE_CHARS),
    },
    failure: {
      message: clean(input.error, MAX_ERROR_CHARS),
    },
    redactions: redactionCount,
  };

  return { evidence: stableStringify(packet), redactionCount };
}

function truncateWithMarker(value: string, maximum: number): string {
  if (value.length <= maximum) return value;

  let retainedCharacters = maximum;
  let marker = "";
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const omittedCharacters = value.length - retainedCharacters;
    marker = `\n[TRUNCATED ${omittedCharacters} characters]`;
    retainedCharacters = Math.max(0, maximum - marker.length);
  }
  return `${value.slice(0, retainedCharacters)}${marker}`;
}

export function redactEvidenceText(value: string): {
  value: string;
  redactionCount: number;
} {
  let redactionCount = 0;
  let output = value;

  const replace = (pattern: RegExp, replacement: string | ((match: string) => string)) => {
    output = output.replace(pattern, (match) => {
      redactionCount += 1;
      return typeof replacement === "string" ? replacement : replacement(match);
    });
  };

  replace(
    /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi,
    "[REDACTED PRIVATE KEY]",
  );
  replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*$/gi, "[REDACTED PRIVATE KEY]");
  replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED JWT]");
  replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]");
  replace(/\bAuthorization\s*:\s*[^\r\n]+/gi, "Authorization: [REDACTED]");
  replace(/([a-z][a-z\d+.-]*:\/\/)([^\s/@]+)@/gi, (match) => {
    const separator = match.indexOf("://");
    return `${match.slice(0, separator + 3)}[REDACTED]@`;
  });
  replace(/\bgh[opusr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED SECRET]");
  replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED SECRET]");
  replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED SECRET]");
  replace(/\bgl(?:pat|dt|rt|cbt|ptt|ft)-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED SECRET]");

  const secretKeyName =
    "(?:api[_-]?key|access[_-]?(?:key|token)|refresh[_-]?token|token|password|" +
    "passwd|secret|credential|client[_-]?secret)";
  const secretAssignment = new RegExp(
    String.raw`((?:\b|[_-])(${secretKeyName})\b\s*(?:=|:)\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)`,
    "gi",
  );
  output = output.replace(
    secretAssignment,
    (match, prefix: string, keyName: string, rawValue: string) => {
      if (!isLikelySecretAssignment(keyName, rawValue)) return match;
      redactionCount += 1;
      return `${prefix}[REDACTED]`;
    },
  );

  return { value: output, redactionCount };
}

function isLikelySecretAssignment(keyName: string, rawValue: string): boolean {
  const value = unquote(rawValue).trim();
  if (!value || looksLikeCodeReference(value) || looksLikePlaceholder(value)) return false;

  const characterClasses = [
    /[a-z]/.test(value),
    /[A-Z]/.test(value),
    /\d/.test(value),
    /[^A-Za-z\d]/.test(value),
  ].filter(Boolean).length;
  const normalizedKey = keyName.replace(/[-_]/g, "").toLowerCase();
  if ((normalizedKey === "password" || normalizedKey === "passwd") && value.length >= 8) {
    return characterClasses >= 2 || /\s/.test(value);
  }
  return value.length >= 12 && characterClasses >= 2 && shannonEntropy(value) >= 3;
}

function unquote(value: string): string {
  const first = value[0];
  const last = value.at(-1);
  return (first === '"' && last === '"') || (first === "'" && last === "'")
    ? value.slice(1, -1)
    : value;
}

function looksLikeCodeReference(value: string): boolean {
  if (/^(?:\$\{[^}]+\}|\$[A-Za-z_][A-Za-z\d_]*|%[A-Za-z_][A-Za-z\d_]*%)$/.test(value)) {
    return true;
  }
  if (/^[A-Za-z_$][\w$]*$/.test(value)) return !/\d/.test(value);
  if (/^(?:await\s+)?[A-Za-z_$][\w$]*\([^\r\n)]*\)$/.test(value)) return true;
  return /^(?:await\s+)?[A-Za-z_$][\w$]*(?:(?:\?|!)?\.[A-Za-z_$][\w$]*|\??\[[^\]\r\n]+\])+(?:\([^\r\n)]*\))?$/.test(
    value,
  );
}

function looksLikePlaceholder(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    /^(?:true|false|null|undefined|nil|none|example|sample|placeholder|dummy|test|testing|changeme|change-me|replace-me|redacted|not-a-secret|secret|token|password)$/.test(
      normalized,
    ) ||
    /^(?:your|my)[-_ ]?(?:api[-_ ]?key|token|password|secret)$/.test(normalized) ||
    /^<[^>]+>$/.test(value) ||
    /^\[[^\]]+\]$/.test(value) ||
    /^[-*xX]+$/.test(value)
  );
}

function shannonEntropy(value: string): number {
  const frequencies = new Map<string, number>();
  for (const character of value) {
    frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of frequencies.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function replaceIncidentalPaths(value: string, repoRoot: string, worktreePath: string): string {
  let output = value;
  const replacements: Array<[string, string]> = [
    [worktreePath, "<WORKTREE>"],
    [worktreePath.replaceAll("\\", "/"), "<WORKTREE>"],
    [repoRoot, "<REPOSITORY>"],
    [repoRoot.replaceAll("\\", "/"), "<REPOSITORY>"],
  ];
  for (const [path, replacement] of replacements) {
    if (path) output = output.split(path).join(replacement);
  }
  return output;
}
