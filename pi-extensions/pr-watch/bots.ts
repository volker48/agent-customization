import type { Finding } from "./core.js";

export type Distilled = {
  severity: string | null;
  title: string;
  detail: string;
};

export type BotAdapter = {
  login: string;
  shortName: string;
  checkNames: string[];
  distill(body: string): Distilled;
  actionableCount?(reviewBody: string): number | null;
  reviewBodyFindings?(reviewBody: string): Finding[];
};

export const DEFAULT_BOTS = ["coderabbitai", "chatgpt-codex-connector", "cursor"];

const CODE_RABBIT: BotAdapter = {
  login: "coderabbitai",
  shortName: "coderabbit",
  checkNames: ["coderabbitai", "coderabbit"],
  distill: distillCodeRabbit,
  actionableCount: parseCodeRabbitActionableCount,
  reviewBodyFindings: (body) => parseNitpicks(body, "coderabbit"),
};

const CODEX: BotAdapter = {
  login: "chatgpt-codex-connector",
  shortName: "codex",
  checkNames: ["chatgpt-codex-connector", "codex"],
  distill: distillCodex,
};

const BUGBOT: BotAdapter = {
  login: "cursor",
  shortName: "bugbot",
  checkNames: ["cursor", "bugbot"],
  distill: distillBugbot,
  actionableCount: parseBugbotActionableCount,
};

const ADAPTERS = new Map(
  [CODE_RABBIT, CODEX, BUGBOT].map((adapter) => [adapter.login, adapter] as const),
);

export function normalizeBotLogin(login: string): string {
  return login.replace(/\[bot\]$/i, "");
}

export function botShortName(login: string): string {
  return adapterForLogin(login)?.shortName ?? normalizeBotLogin(login);
}

export function adapterForLogin(login: string, configuredBots = DEFAULT_BOTS): BotAdapter | null {
  const normalized = normalizeBotLogin(login);
  const configured = new Set(configuredBots.map(normalizeBotLogin));
  if (!configured.has(normalized)) return null;
  return ADAPTERS.get(normalized) ?? genericAdapter(normalized);
}

export function adaptersForBots(bots: string[]): BotAdapter[] {
  const configured = bots.length > 0 ? bots : DEFAULT_BOTS;
  return configured.map((login) => ADAPTERS.get(normalizeBotLogin(login)) ?? genericAdapter(login));
}

export function distillComment(login: string, body: string): Distilled {
  return adapterForLogin(login)?.distill(body) ?? genericDistill(body);
}

function genericAdapter(login: string): BotAdapter {
  const normalized = normalizeBotLogin(login);
  return {
    login: normalized,
    shortName: normalized,
    checkNames: [normalized],
    distill: genericDistill,
  };
}

function genericDistill(body: string): Distilled {
  return { severity: null, title: firstProseLine(body), detail: stripNoise(body) };
}

function parseCodeRabbitActionableCount(body: string): number | null {
  const match = /\*\*Actionable comments posted: (\d+)\*\*/.exec(body);
  return match ? Number(match[1]) : null;
}

function parseBugbotActionableCount(body: string): number | null {
  const match = /Cursor Bugbot has reviewed[\s\S]*?found\s+(\d+)\s+potential issues/i.exec(body);
  return match ? Number(match[1]) : null;
}

// Not \b: the words sit inside markdown italics (`_🟠 Major_`) and `_` is a word character.
const CODE_RABBIT_SEVERITY_WORDS = /(?<![a-z])(critical|major|minor|trivial)(?![a-z])/i;

export function distillCodeRabbit(body: string): Distilled {
  const headerMatch = /^[ \t]*_[^_\n]+_(?: \| _[^_\n]+_)+/m.exec(body);
  let severity: string | null = null;
  if (headerMatch) {
    for (const segment of headerMatch[0].split("|")) {
      const word = CODE_RABBIT_SEVERITY_WORDS.exec(segment);
      if (word) severity = word[1].toLowerCase();
    }
  }
  const title = /^\*\*(.+?)\*\*$/m.exec(body)?.[1] ?? firstProseLine(body);
  const prompt = extractAgentPrompt(body);
  const detail = prompt ?? stripNoise(stripAfterFirstDetails(body));
  return { severity, title, detail };
}

export function distillCodex(body: string): Distilled {
  const severity = /!\[P(\d) Badge\]/.exec(body)?.[1];
  const titleLine = /^\*\*(.+?)\*\*$/m.exec(body)?.[1] ?? "";
  const title = titleLine
    .replace(/<sub>|<\/sub>/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .trim();
  const detail = stripNoise(body)
    .split("\n")
    .filter((line) => !line.startsWith("**") && !line.startsWith("Useful? React with"))
    .join("\n")
    .trim();
  return {
    severity: severity ? `P${severity}` : null,
    title: title || firstProseLine(body),
    detail,
  };
}

export function distillBugbot(body: string): Distilled {
  const title = /^###\s+(.+)$/m.exec(body)?.[1].trim() ?? firstProseLine(body);
  const severity = /^\*\*(High|Medium|Low) Severity\*\*$/im.exec(body)?.[1].toLowerCase() ?? null;
  const description = extractBugbotDescription(body);
  const detail = description ? stripNoise(description) : stripBugbotFallback(body);
  return { severity, title, detail };
}

function extractAgentPrompt(body: string): string | null {
  const marker = body.indexOf("Prompt for AI Agents</summary>");
  if (marker === -1) return null;
  const fence = /```[^\n]*\n([\s\S]*?)```/.exec(body.slice(marker));
  return fence ? fence[1].trim() : null;
}

function extractBugbotDescription(body: string): string | null {
  const match = /<!-- DESCRIPTION START -->([\s\S]*?)<!-- DESCRIPTION END -->/.exec(body);
  return match ? match[1].trim() : null;
}

/** CodeRabbit prose precedes the first `<details>` block (suggestions, prompts, metadata). */
function stripAfterFirstDetails(body: string): string {
  const index = body.indexOf("<details>");
  return index === -1 ? body : body.slice(0, index);
}

function stripBugbotFallback(body: string): string {
  return stripNoise(body)
    .replace(/<div>\s*<a href="https:\/\/cursor\.com\/open\?[\s\S]*?<\/div>/g, "")
    .replace(/<sup>Reviewed by \[Cursor Bugbot\][\s\S]*?<\/sup>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function stripNoise(body: string): string {
  let text = body;
  let previous: string;
  do {
    previous = text;
    text = text.replace(/<details\b(?:(?!<details\b)[\s\S])*?<\/details>/g, "");
  } while (text !== previous);
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?(?:sub|blockquote|summary|br)\s*\/?>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function firstProseLine(body: string): string {
  for (const line of stripNoise(body).split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed.replace(/^\*\*|\*\*$/g, "");
  }
  return "(no title)";
}

/**
 * Parse review-body nitpicks: entries shaped `` `42-54`: _category_ | _severity_ ... `` nested in
 * per-file `<details>` blocks inside the `🧹 Nitpick comments` section.
 */
export function parseNitpicks(reviewBody: string, bot: string): Finding[] {
  const section = /<summary>🧹 Nitpick comments[\s\S]*/.exec(reviewBody);
  if (!section) return [];
  const findings: Finding[] = [];
  const filePattern = /<summary>([^<(]+?) \(\d+\)<\/summary>/g;
  const fileMatches = [...section[0].matchAll(filePattern)];
  for (const [index, fileMatch] of fileMatches.entries()) {
    const start = (fileMatch.index ?? 0) + fileMatch[0].length;
    const end = fileMatches[index + 1]?.index ?? section[0].length;
    const block = section[0].slice(start, end);
    findings.push(...parseNitpickEntries(block, fileMatch[1].trim(), bot));
  }
  return findings;
}

function parseNitpickEntries(block: string, path: string, bot: string): Finding[] {
  const entryPattern = /`(\d+(?:-\d+)?)`:/g;
  const entries = [...block.matchAll(entryPattern)];
  return entries.map((entry, index) => {
    const start = (entry.index ?? 0) + entry[0].length;
    const end = entries[index + 1]?.index ?? block.length;
    const body = block.slice(start, end);
    const distilled = distillCodeRabbit(body);
    return {
      path,
      line: entry[1],
      bot,
      severity: distilled.severity,
      title: distilled.title,
      detail: distilled.detail,
      resolved: false,
      outdated: false,
    };
  });
}
