import { complete } from "@earendil-works/pi-ai/compat";
import type { Message, Model } from "@earendil-works/pi-ai";
import {
  BorderedLoader,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

export const DEFAULT_AUTONAME_MODEL = "anthropic/claude-haiku-4-5";
export const DEFAULT_AUTONAME_FALLBACK_MODEL = "openai-codex/gpt-5.5";
export const MAX_NAME_LENGTH = 60;
const MAX_TRANSCRIPT_LENGTH = 30_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 80;
const MODEL_ENV = "PI_AUTONAME_MODEL";
const FALLBACK_MODEL_ENV = "PI_AUTONAME_FALLBACK_MODEL";
const PROMPT_FILE_ENV = "PI_AUTONAME_PROMPT_FILE";

const DEFAULT_PROMPT = [
  "You name Pi coding-agent sessions for future retrieval.",
  "Return exactly one short title.",
  "",
  "Rules:",
  "- 3 to 8 words.",
  `- Maximum ${MAX_NAME_LENGTH} characters.`,
  "- Concrete and searchable.",
  "- Prefer the main task, bug, feature, or decision.",
  "- Include distinctive project, API, ticket, or file terms when helpful.",
  "- Never start with 'Session' or 'Pi session'; the UI already implies that.",
  "- Do not include quotes, markdown, 'session', or 'conversation'.",
  "- Avoid vague names like 'Code Review' or 'Debugging'.",
].join("\n");

type SessionMessage = {
  role?: string;
  content?: unknown;
  summary?: string;
};

type SessionEntry = {
  type: string;
  message?: SessionMessage;
  summary?: string;
};

type ModelRef = {
  provider: string;
  modelId: string;
  value: string;
};

type NamingAttempt = {
  name?: string;
  error?: string;
};

type NamingResult = {
  name?: string;
  errors: string[];
  cancelled?: boolean;
};

type ModelAuth = {
  apiKey: string;
  headers?: Record<string, string>;
};

type RuntimeModelRegistry = {
  getApiKey?: (model: Model<string>) => Promise<string | undefined>;
  getApiKeyAndHeaders?: (
    model: Model<string>,
  ) => Promise<
    { ok: true; apiKey?: string; headers?: Record<string, string> } | { ok: false; error: string }
  >;
};

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return value.trim() || undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getOption(pi: ExtensionAPI, flag: string, envName: string, fallback: string): string {
  return normalizeString(pi.getFlag(flag)) ?? normalizeString(process.env[envName]) ?? fallback;
}

function parseModelRef(value: string): ModelRef {
  const slashIndex = value.indexOf("/");
  if (slashIndex <= 0 || slashIndex === value.length - 1) {
    throw new Error(`Expected model in provider/model form, got: ${value}`);
  }

  return {
    provider: value.slice(0, slashIndex),
    modelId: value.slice(slashIndex + 1),
    value,
  };
}

function extractTextParts(content: unknown): string[] {
  if (typeof content === "string") {
    return [content];
  }
  if (!Array.isArray(content)) {
    return [];
  }

  return content.flatMap((part) => {
    if (!part || typeof part !== "object") {
      return [];
    }
    const block = part as { type?: string; text?: unknown };
    return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
  });
}

function extractToolCalls(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }

  return content.flatMap((part) => {
    if (!part || typeof part !== "object") {
      return [];
    }
    const block = part as { type?: string; name?: unknown; arguments?: unknown };
    if (block.type !== "toolCall" || typeof block.name !== "string") {
      return [];
    }
    return [`Tool call: ${block.name} ${formatToolArguments(block.arguments)}`.trim()];
  });
}

function formatToolArguments(args: unknown): string {
  if (!args || typeof args !== "object") {
    return "";
  }

  const json = JSON.stringify(args);
  return json.length > 500 ? `${json.slice(0, 500)}...` : json;
}

function roleLabel(role: string | undefined): string | undefined {
  if (role === "user") {
    return "User";
  }
  if (role === "assistant") {
    return "Assistant";
  }
  return undefined;
}

function formatMessageEntry(entry: SessionEntry): string | undefined {
  const label = roleLabel(entry.message?.role);
  if (!label) {
    return undefined;
  }

  const lines = extractTextParts(entry.message?.content).map((text) => `${label}: ${text.trim()}`);
  if (entry.message?.role === "assistant") {
    lines.push(...extractToolCalls(entry.message.content));
  }

  const filtered = lines.filter((line) => line.trim());
  return filtered.length > 0 ? filtered.join("\n") : undefined;
}

function formatSummaryEntry(entry: SessionEntry): string | undefined {
  const summary = normalizeString(entry.summary ?? entry.message?.summary);
  if (!summary) {
    return undefined;
  }

  if (entry.type === "compaction") {
    return `Compaction summary: ${summary}`;
  }
  if (entry.type === "branch_summary") {
    return `Branch summary: ${summary}`;
  }
  return undefined;
}

function compactTranscript(sections: string[], maxLength: number): string {
  const transcript = sections.join("\n\n");
  if (transcript.length <= maxLength) {
    return transcript;
  }

  const headLength = Math.floor(maxLength * 0.35);
  const tailLength = maxLength - headLength - 80;
  return [
    transcript.slice(0, headLength),
    "\n\n[...middle of transcript omitted for length...]\n\n",
    transcript.slice(-tailLength),
  ].join("");
}

export function buildAutonameTranscript(entries: SessionEntry[], cwd: string): string {
  const sections = [`Project: ${basename(cwd)}`, `Working directory: ${cwd}`];

  for (const entry of entries) {
    const formatted =
      entry.type === "message" ? formatMessageEntry(entry) : formatSummaryEntry(entry);
    if (formatted) {
      sections.push(formatted);
    }
  }

  return compactTranscript(sections, MAX_TRANSCRIPT_LENGTH);
}

function removePrefixMarkup(value: string): string {
  return value.replace(/^[-*#\d.)\s]+/, "").trim();
}

function stripWrapping(value: string): string {
  return value
    .replace(/^["'`“”‘’]+/, "")
    .replace(/["'`“”‘’]+$/, "")
    .trim();
}

function truncateAtWord(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  const truncated = value
    .slice(0, maxLength)
    .replace(/\s+\S*$/, "")
    .trim();
  return truncated.length >= 12 ? truncated : value.slice(0, maxLength).trim();
}

export function sanitizeSessionName(rawName: string): string | undefined {
  const firstLine = rawName
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);

  if (!firstLine) {
    return undefined;
  }

  const cleaned = stripWrapping(removePrefixMarkup(firstLine))
    .replace(/^title:\s*/i, "")
    .replace(/^(?:pi\s+)?session\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();

  return truncateAtWord(stripWrapping(cleaned), MAX_NAME_LENGTH) || undefined;
}

async function readPrompt(pi: ExtensionAPI): Promise<string> {
  const promptFile =
    normalizeString(pi.getFlag("autoname-prompt-file")) ??
    normalizeString(process.env[PROMPT_FILE_ENV]);
  if (!promptFile) {
    return DEFAULT_PROMPT;
  }

  return readFile(promptFile, "utf8");
}

function buildNamingRequest(systemPrompt: string, transcript: string): Message[] {
  return [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: [systemPrompt, "", "<session_history>", transcript, "</session_history>"].join(
            "\n",
          ),
        },
      ],
      timestamp: Date.now(),
    },
  ];
}

function extractAssistantText(message: {
  content: Array<{ type: string; text?: string }>;
}): string {
  return message.content
    .filter((content): content is { type: "text"; text: string } => content.type === "text")
    .map((content) => content.text)
    .join("\n");
}

async function resolveModelAuth(
  registry: RuntimeModelRegistry,
  model: Model<string>,
  modelRef: ModelRef,
): Promise<ModelAuth | { error: string }> {
  if (typeof registry.getApiKeyAndHeaders === "function") {
    const auth = await registry.getApiKeyAndHeaders(model);
    if (auth.ok === false) {
      return { error: auth.error };
    }
    return auth.apiKey ? { apiKey: auth.apiKey, headers: auth.headers } : noApiKey(modelRef);
  }

  if (typeof registry.getApiKey === "function") {
    const apiKey = await registry.getApiKey(model);
    return apiKey ? { apiKey } : noApiKey(modelRef);
  }

  return { error: "Model registry cannot resolve API keys" };
}

function noApiKey(modelRef: ModelRef): { error: string } {
  return { error: `No API key for ${modelRef.value}` };
}

function isAuthError(auth: ModelAuth | { error: string }): auth is { error: string } {
  return "error" in auth;
}

async function tryNameWithModel(
  modelRef: ModelRef,
  prompt: string,
  transcript: string,
  ctx: ExtensionCommandContext,
  signal?: AbortSignal,
): Promise<NamingAttempt> {
  const model = ctx.modelRegistry.find(modelRef.provider, modelRef.modelId) as
    | Model<string>
    | undefined;
  if (!model) {
    return { error: `Model not found: ${modelRef.value}` };
  }

  const auth = await resolveModelAuth(ctx.modelRegistry as RuntimeModelRegistry, model, modelRef);
  if (isAuthError(auth)) {
    return { error: auth.error };
  }

  const response = await complete(
    model,
    { messages: buildNamingRequest(prompt, transcript) },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      maxTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      reasoningEffort: "minimal",
      signal,
    },
  );
  const name = sanitizeSessionName(extractAssistantText(response));
  return name ? { name } : { error: `Empty name from ${modelRef.value}` };
}

async function generateName(
  prompt: string,
  transcript: string,
  modelRefs: ModelRef[],
  ctx: ExtensionCommandContext,
  signal?: AbortSignal,
): Promise<NamingResult> {
  const errors: string[] = [];
  for (const modelRef of modelRefs) {
    try {
      const attempt = await tryNameWithModel(modelRef, prompt, transcript, ctx, signal);
      if (attempt.name) {
        return { name: attempt.name, errors };
      }
      errors.push(attempt.error ?? `Unknown naming failure for ${modelRef.value}`);
    } catch (error) {
      errors.push(`${modelRef.value}: ${errorMessage(error)}`);
    }
  }
  return { errors };
}

function generateNameWithLoader(
  prompt: string,
  transcript: string,
  modelRefs: ModelRef[],
  ctx: ExtensionCommandContext,
): Promise<NamingResult> {
  if (!ctx.hasUI) {
    return generateName(prompt, transcript, modelRefs, ctx);
  }

  return ctx.ui.custom<NamingResult>((tui, theme, _kb, done) => {
    const loader = new BorderedLoader(tui, theme, "Naming session...");
    loader.onAbort = () => done({ errors: [], cancelled: true });

    generateName(prompt, transcript, modelRefs, ctx, loader.signal)
      .then(done)
      .catch((error) => done({ errors: [errorMessage(error)] }));

    return loader;
  });
}

export default function autonameExtension(pi: ExtensionAPI) {
  pi.registerFlag("autoname-model", {
    description: "Primary model for /autoname, in provider/model form",
    type: "string",
  });
  pi.registerFlag("autoname-fallback-model", {
    description: "Fallback model for /autoname, in provider/model form",
    type: "string",
  });
  pi.registerFlag("autoname-prompt-file", {
    description: "Path to a custom /autoname prompt file",
    type: "string",
  });

  pi.registerCommand("autoname", {
    description: "Name the current session with a small model",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();

      let primary: ModelRef;
      let fallback: ModelRef;
      let prompt: string;
      try {
        primary = parseModelRef(getOption(pi, "autoname-model", MODEL_ENV, DEFAULT_AUTONAME_MODEL));
        fallback = parseModelRef(
          getOption(
            pi,
            "autoname-fallback-model",
            FALLBACK_MODEL_ENV,
            DEFAULT_AUTONAME_FALLBACK_MODEL,
          ),
        );
        prompt = await readPrompt(pi);
      } catch (error) {
        ctx.ui.notify(`Autoname failed: ${errorMessage(error)}`, "error");
        return;
      }

      const transcript = buildAutonameTranscript(
        ctx.sessionManager.getBranch() as SessionEntry[],
        ctx.cwd,
      );
      const { name, errors, cancelled } = await generateNameWithLoader(
        prompt,
        transcript,
        [primary, fallback],
        ctx,
      );

      if (cancelled) {
        ctx.ui.notify("Autoname cancelled", "info");
        return;
      }

      if (!name) {
        ctx.ui.notify(`Autoname failed: ${errors.join("; ")}`, "error");
        return;
      }

      pi.setSessionName(name);
      ctx.ui.notify(`Session named: ${name}`, "info");
    },
  });
}
