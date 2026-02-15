/**
 * Handoff extension (V1)
 *
 * Command:
 *   /handoff <goal>
 *
 * Workflow:
 *   1) Generate a handoff draft from current session context.
 *   2) Open draft in editor for review/tweaks.
 *   3) Create a new session and prefill the edited draft.
 *   4) User manually submits in the new session.
 *
 * V1 limits:
 *   - No label/checkpoint slicing
 *   - No auto-submit
 *   - No handoff artifact file writes
 */

import {
  complete,
  type AssistantMessage,
  type Message,
  type TextContent,
  type ToolCall,
  type UserMessage,
} from "@mariozechner/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  KeybindingsManager,
  SessionEntry,
  SessionMessageEntry,
} from "@mariozechner/pi-coding-agent";
import { BorderedLoader, Theme } from "@mariozechner/pi-coding-agent";
import type { TUI } from "@mariozechner/pi-tui";

type ToolCallSummary = {
  name: string;
  summary: string;
};

export type HandoffContext = {
  goal: string;
  conversationText: string;
  relevantFiles: string[];
  toolCalls: ToolCallSummary[];
};

type DraftGenerationResult =
  | { status: "ok"; draft: string }
  | { status: "cancelled" }
  | { status: "error"; message: string };

const MAX_CONVERSATION_CHARS = 40_000;
const MAX_RELEVANT_FILES = 20;
const MAX_NOTABLE_COMMANDS = 20;

const REQUIRED_HEADINGS = [
  "Objective",
  "Context",
  "Decisions Made",
  "Relevant Files",
  "Implementation Plan",
  "Acceptance Criteria",
  "Open Questions / Risks",
] as const;

const SYSTEM_PROMPT = `You are a handoff prompt generator for coding work.

Generate a self-contained markdown handoff prompt for a NEW session/agent.
The handoff must be concrete, implementation-focused, and concise.

STRICT OUTPUT RULES:
1. Output markdown only.
2. Use these exact section headings (##):
   - Objective
   - Context
   - Decisions Made
   - Relevant Files
   - Implementation Plan
   - Acceptance Criteria
   - Open Questions / Risks
3. Do not add extra top-level sections.
4. Include specific file paths when available.
5. Acceptance Criteria must be checklist items (- [ ] ...).
6. Keep fluff out. The new agent should be able to start coding immediately.`;

const USAGE_TEXT = "Usage: /handoff <goal for the new session>";

export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  return [
    "[Conversation truncated for handoff generation; showing most recent context]",
    text.slice(-maxChars),
  ].join("\n\n");
}

function uniqueLimited<T>(items: T[], limit: number, keyFn: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];

  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= limit) break;
  }

  return result;
}

function isUserMessage(message: Message): message is UserMessage {
  return message.role === "user";
}

function isAssistantMessage(message: Message): message is AssistantMessage {
  return message.role === "assistant";
}

function extractTextFromMessage(message: Message): string {
  if (isUserMessage(message)) {
    if (typeof message.content === "string") return message.content;
    return message.content
      .filter((block): block is TextContent => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
  }

  if (isAssistantMessage(message)) {
    return message.content
      .filter((block): block is TextContent => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
  }

  return "";
}

function summarizeToolCall(toolCall: ToolCall): ToolCallSummary {
  const { name, arguments: args } = toolCall;
  const normalizedName = name.toLowerCase();

  switch (normalizedName) {
    case "bash": {
      const command = args.command as string | undefined;
      return { name: "Bash", summary: command ? `\`${command}\`` : "(no command)" };
    }
    case "read": {
      const path = args.path as string | undefined;
      return { name: "Read", summary: path ?? "(no path)" };
    }
    case "write": {
      const path = args.path as string | undefined;
      return { name: "Write", summary: path ?? "(no path)" };
    }
    case "edit": {
      const path = args.path as string | undefined;
      return { name: "Edit", summary: path ?? "(no path)" };
    }
    case "webfetch": {
      const url = args.url as string | undefined;
      return { name: "WebFetch", summary: url ?? "(no url)" };
    }
    default: {
      const keyArgs = Object.entries(args)
        .slice(0, 2)
        .map(([k, v]) => `${k}: ${String(v).slice(0, 40)}`)
        .join(", ");
      return { name, summary: keyArgs || "(no args)" };
    }
  }
}

function extractToolCalls(message: Message): ToolCallSummary[] {
  if (!isAssistantMessage(message)) return [];

  return message.content
    .filter((block): block is ToolCall => block.type === "toolCall")
    .map(summarizeToolCall);
}

export function extractFileCandidates(text: string): string[] {
  if (!text) return [];

  const files: string[] = [];
  const patterns = [
    /(?:^|[\s"'`(])(@?(?:\.{1,2}\/|\/)?(?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]{1,10})(?=$|[\s"'`),:;])/g,
    /(?:^|[\s"'`(])(@?(?:\.{1,2}\/|\/)?(?:[\w.-]+\/)*(?:README|Dockerfile|Makefile|package\.json|tsconfig\.json|AGENTS\.md|SKILL\.md))(?=$|[\s"'`),:;])/gi,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const raw = match[1] ?? "";
      const normalized = raw.startsWith("@") ? raw.slice(1) : raw;
      if (!normalized) continue;
      if (/\.[0-9]+$/.test(normalized)) continue;
      files.push(normalized);
    }
  }

  return files;
}

function isSessionMessageEntry(entry: SessionEntry): entry is SessionMessageEntry {
  return entry.type === "message";
}

function serializeMessageForHandoff(message: Message): string | null {
  // Skip tool result messages entirely - they contain noisy output
  if (message.role === "toolResult") return null;

  const role = message.role === "user" ? "User" : "Assistant";
  const text = extractTextFromMessage(message);

  // For assistant messages, also note tool calls (but not their results)
  if (isAssistantMessage(message)) {
    const toolCalls = extractToolCalls(message);
    const toolCallText = toolCalls.map((tc) => `  [${tc.name}] ${tc.summary}`).join("\n");

    if (text && toolCallText) {
      return `${role}:\n${text}\n${toolCallText}`;
    }
    if (toolCallText) {
      return `${role}:\n${toolCallText}`;
    }
    if (text) {
      return `${role}:\n${text}`;
    }
    return null;
  }

  if (!text) return null;
  return `${role}:\n${text}`;
}

function buildConversationText(entries: SessionEntry[]): string {
  const messages = entries
    .filter(isSessionMessageEntry)
    .map((entry) => entry.message as Message)
    .filter((message) => message.role === "user" || message.role === "assistant");

  const serialized = messages
    .map(serializeMessageForHandoff)
    .filter((text): text is string => text !== null)
    .join("\n\n---\n\n");

  return truncateText(serialized, MAX_CONVERSATION_CHARS);
}

function buildHandoffContext(entries: SessionEntry[], goal: string): HandoffContext {
  const conversationText = buildConversationText(entries);
  const allText: string[] = [];
  const allToolCalls: ToolCallSummary[] = [];

  for (const entry of entries) {
    if (!isSessionMessageEntry(entry)) continue;
    const message = entry.message as Message;
    allText.push(extractTextFromMessage(message));
    allToolCalls.push(...extractToolCalls(message));
  }

  // Extract files from both text content and tool call paths
  const textFileCandidates = extractFileCandidates(allText.join("\n"));
  const fileToolNames = new Set(["read", "write", "edit"]);
  const toolCallPaths = allToolCalls
    .filter((tc) => fileToolNames.has(tc.name.toLowerCase()))
    .map((tc) => tc.summary);

  const relevantFiles = uniqueLimited(
    [...toolCallPaths, ...textFileCandidates],
    MAX_RELEVANT_FILES,
    (f) => f.trim(),
  );
  const toolCalls = uniqueLimited(
    allToolCalls,
    MAX_NOTABLE_COMMANDS,
    (tc) => `${tc.name}:${tc.summary}`,
  );

  return {
    goal,
    conversationText,
    relevantFiles,
    toolCalls,
  };
}

function buildGenerationPayload(context: HandoffContext): string {
  const filesSection =
    context.relevantFiles.length > 0
      ? context.relevantFiles.map((file) => `- ${file}`).join("\n")
      : "(No explicit file paths detected)";

  const toolCallsSection =
    context.toolCalls.length > 0
      ? context.toolCalls.map((tc) => `- [${tc.name}] ${tc.summary}`).join("\n")
      : "(No tool calls detected)";

  return [
    `Goal:\n${context.goal}`,
    `Detected relevant files:\n${filesSection}`,
    `Tool calls made:\n${toolCallsSection}`,
    `Conversation history:\n${context.conversationText}`,
  ].join("\n\n");
}

function getSection(
  markdown: string,
  heading: (typeof REQUIRED_HEADINGS)[number],
): string | undefined {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^##\\s+${escapedHeading}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, "im");
  const match = markdown.match(regex);
  if (!match) return undefined;
  const sectionBody = match[1]?.trim();
  return sectionBody || undefined;
}

export function ensureAcceptanceChecklist(text: string): string {
  if (/^-\s*\[\s?[xX ]\]\s+/m.test(text)) return text;

  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `- [ ] ${line.replace(/^-\s*/, "")}`);

  if (lines.length > 0) return lines.join("\n");
  return "- [ ] Implementation satisfies the Objective\n- [ ] Verification or test steps are included";
}

export function enforceSchema(draft: string, context: HandoffContext): string {
  const normalized = draft.trim();
  const extracted: Record<string, string | undefined> = {};

  for (const heading of REQUIRED_HEADINGS) {
    extracted[heading] = getSection(normalized, heading);
  }

  const objective = extracted["Objective"] ?? context.goal;

  const contextSection =
    extracted["Context"] ?? "(Model did not generate context - review conversation manually)";

  const decisions =
    extracted["Decisions Made"] ?? "(No decisions extracted - review conversation for constraints)";

  const relevantFiles =
    extracted["Relevant Files"] ??
    (context.relevantFiles.length > 0
      ? context.relevantFiles.map((file) => `- ${file}`).join("\n")
      : "(No file paths detected in conversation)");

  const implementationPlan =
    extracted["Implementation Plan"] ?? "(Model did not generate a plan - define steps manually)";

  const acceptanceCriteria = ensureAcceptanceChecklist(extracted["Acceptance Criteria"] ?? "");

  const risks =
    extracted["Open Questions / Risks"] ?? "(No risks identified - consider edge cases)";

  return [
    "## Objective",
    objective,
    "",
    "## Context",
    contextSection,
    "",
    "## Decisions Made",
    decisions,
    "",
    "## Relevant Files",
    relevantFiles,
    "",
    "## Implementation Plan",
    implementationPlan,
    "",
    "## Acceptance Criteria",
    acceptanceCriteria,
    "",
    "## Open Questions / Risks",
    risks,
  ].join("\n");
}

export async function generateDraftWithLoader(
  context: HandoffContext,
  ctx: ExtensionCommandContext,
): Promise<DraftGenerationResult> {
  if (!ctx.model) {
    return { status: "error", message: "No model selected" };
  }

  const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
  const payload = buildGenerationPayload(context);
  const model = ctx.model;

  const result = (await ctx.ui.custom(
    (
      tui: TUI,
      theme: Theme,
      _kb: KeybindingsManager,
      done: (value: DraftGenerationResult) => void,
    ) => {
      const loader = new BorderedLoader(tui, theme, "Generating handoff draft...");
      let completed = false;
      const completeOnce = (value: DraftGenerationResult) => {
        if (completed) return;
        completed = true;
        done(value);
      };

      loader.onAbort = () => completeOnce({ status: "cancelled" });

      const generate = async (): Promise<DraftGenerationResult> => {
        const userMessage: UserMessage = {
          role: "user",
          content: [{ type: "text", text: payload }],
          timestamp: Date.now(),
        };

        const options = apiKey ? { apiKey, signal: loader.signal } : { signal: loader.signal };
        const response = await complete(
          model,
          { systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
          options,
        );

        if (response.stopReason === "aborted") {
          return { status: "cancelled" };
        }

        const draft = response.content
          .filter((block): block is TextContent => block.type === "text")
          .map((block) => block.text)
          .join("\n")
          .trim();

        if (!draft) {
          return { status: "error", message: "Model returned an empty handoff draft" };
        }

        return { status: "ok", draft };
      };

      generate()
        .then(completeOnce)
        .catch((error: unknown) => {
          console.error("handoff generation failed", error);
          const message = error instanceof Error ? error.message : String(error);
          completeOnce({ status: "error", message });
        });

      return loader;
    },
  )) as DraftGenerationResult | null;

  return result ?? { status: "cancelled" };
}

export default function handoffExtension(pi: ExtensionAPI) {
  pi.registerCommand("handoff", {
    description: "Generate a reviewed handoff prompt and start a new session",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();

      if (!ctx.hasUI) {
        ctx.ui.notify("handoff requires interactive mode", "error");
        return;
      }

      const goal = args.trim();
      if (!goal) {
        ctx.ui.notify(USAGE_TEXT, "error");
        return;
      }

      if (!ctx.model) {
        ctx.ui.notify("No model selected", "error");
        return;
      }

      const branch = ctx.sessionManager.getBranch();
      const hasMessages = branch.some((entry: SessionEntry) => entry.type === "message");
      if (!hasMessages) {
        ctx.ui.notify("No conversation found to hand off", "warning");
        return;
      }

      const handoffContext = buildHandoffContext(branch, goal);
      if (!handoffContext.conversationText.trim()) {
        ctx.ui.notify("No usable conversation context found", "warning");
        return;
      }

      const generationResult = await generateDraftWithLoader(handoffContext, ctx);
      if (generationResult.status === "cancelled") {
        ctx.ui.notify("Cancelled", "info");
        return;
      }
      if (generationResult.status === "error") {
        ctx.ui.notify(`Handoff generation failed: ${generationResult.message}`, "error");
        return;
      }

      const schemaDraft = enforceSchema(generationResult.draft, handoffContext);
      const editedPrompt = await ctx.ui.editor("Edit handoff prompt", schemaDraft);
      if (editedPrompt === undefined) {
        ctx.ui.notify("Cancelled", "info");
        return;
      }

      const currentSessionFile = ctx.sessionManager.getSessionFile();
      const newSessionResult = await ctx.newSession({
        parentSession: currentSessionFile,
      });

      if (newSessionResult.cancelled) {
        ctx.ui.notify("New session creation cancelled", "info");
        return;
      }

      ctx.ui.setEditorText(editedPrompt);
      ctx.ui.notify("Handoff ready. Submit when ready.", "info");
    },
  });
}
