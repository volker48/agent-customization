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

import { complete, type Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI, SessionEntry } from "@mariozechner/pi-coding-agent";
import { BorderedLoader, convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";

type ToolCallBlock = {
  type?: string;
  name?: string;
  arguments?: Record<string, unknown>;
};

type TextBlock = {
  type?: string;
  text?: string;
};

type HandoffContext = {
  goal: string;
  conversationText: string;
  relevantFiles: string[];
  notableCommands: string[];
};

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

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[Conversation truncated for handoff generation]`;
}

function uniqueLimited(items: string[], limit: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
    if (result.length >= limit) break;
  }

  return result;
}

function getMessageBlocks(message: any): unknown[] {
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  return content;
}

function extractTextFromMessage(message: any): string {
  const content = message?.content;

  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const textBlock = block as TextBlock;
    if (textBlock.type === "text" && typeof textBlock.text === "string") {
      parts.push(textBlock.text);
    }
  }

  return parts.join("\n").trim();
}

function extractToolCallCommands(message: any): string[] {
  const commands: string[] = [];

  for (const block of getMessageBlocks(message)) {
    if (!block || typeof block !== "object") continue;
    const toolCall = block as ToolCallBlock;
    if (toolCall.type !== "toolCall" || toolCall.name !== "bash") continue;
    const command = toolCall.arguments?.command;
    if (typeof command === "string" && command.trim()) {
      commands.push(command.trim());
    }
  }

  return commands;
}

function extractFileCandidates(text: string): string[] {
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
      if (normalized) files.push(normalized);
    }
  }

  return files;
}

function buildConversationText(entries: SessionEntry[]): string {
  const messages = entries
    .filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
    .map((entry) => (entry as any).message)
    .filter((message) => message?.role === "user" || message?.role === "assistant");

  const llmMessages = convertToLlm(messages as any);
  const serialized = serializeConversation(llmMessages);

  return truncateText(serialized, MAX_CONVERSATION_CHARS);
}

function buildHandoffContext(entries: SessionEntry[], goal: string): HandoffContext {
  const conversationText = buildConversationText(entries);
  const allText: string[] = [];
  const allCommands: string[] = [];

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = (entry as any).message;
    allText.push(extractTextFromMessage(message));
    allCommands.push(...extractToolCallCommands(message));
  }

  const relevantFiles = uniqueLimited(
    extractFileCandidates(allText.join("\n")),
    MAX_RELEVANT_FILES,
  );
  const notableCommands = uniqueLimited(allCommands, MAX_NOTABLE_COMMANDS);

  return {
    goal,
    conversationText,
    relevantFiles,
    notableCommands,
  };
}

function buildGenerationPayload(context: HandoffContext): string {
  const filesSection =
    context.relevantFiles.length > 0
      ? context.relevantFiles.map((file) => `- ${file}`).join("\n")
      : "- (No explicit file paths detected)";

  const commandsSection =
    context.notableCommands.length > 0
      ? context.notableCommands.map((command) => `- ${command}`).join("\n")
      : "- (No notable bash commands detected)";

  return [
    `Goal:\n${context.goal}`,
    `Detected relevant files:\n${filesSection}`,
    `Detected notable commands:\n${commandsSection}`,
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

function ensureAcceptanceChecklist(text: string): string {
  if (/^-\s*\[\s?[xX ]\]\s+/m.test(text)) return text;

  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `- [ ] ${line.replace(/^-\s*/, "")}`);

  if (lines.length > 0) return lines.join("\n");
  return "- [ ] Implementation satisfies the Objective\n- [ ] Verification or test steps are included";
}

function enforceSchema(draft: string, context: HandoffContext): string {
  const normalized = draft.trim();
  const extracted: Record<string, string | undefined> = {};

  for (const heading of REQUIRED_HEADINGS) {
    extracted[heading] = getSection(normalized, heading);
  }

  const objective = extracted["Objective"] ?? context.goal;
  const summaryFallback = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 8)
    .join("\n");

  const contextSection =
    extracted["Context"] ??
    (summaryFallback || "- Continue from the prior implementation discussion.");
  const decisions =
    extracted["Decisions Made"] ??
    "- Preserve previously discussed constraints and architecture choices.";
  const relevantFiles =
    extracted["Relevant Files"] ??
    (context.relevantFiles.length > 0
      ? context.relevantFiles.map((file) => `- ${file}`).join("\n")
      : "- (No explicit file paths were identified in the prior session.)");
  const implementationPlan =
    extracted["Implementation Plan"] ??
    [
      "1. Reconfirm current code state in relevant files.",
      "2. Implement the Objective with minimal, focused changes.",
      "3. Validate behavior and summarize what changed.",
    ].join("\n");
  const acceptanceCriteria = ensureAcceptanceChecklist(extracted["Acceptance Criteria"] ?? "");
  const risks =
    extracted["Open Questions / Risks"] ??
    "- Confirm any ambiguous requirements before implementation.";

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

async function generateDraftWithLoader(context: HandoffContext, ctx: any): Promise<string | null> {
  if (!ctx.model) return null;

  const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
  if (!apiKey) {
    ctx.ui.notify("No API key available for current model", "error");
    return null;
  }

  const payload = buildGenerationPayload(context);

  const result = (await ctx.ui.custom(
    (tui: any, theme: any, _kb: any, done: (value: string | null) => void) => {
      const loader = new BorderedLoader(tui, theme, "Generating handoff draft...");
      loader.onAbort = () => done(null);

      const generate = async () => {
        const userMessage: Message = {
          role: "user",
          content: [{ type: "text", text: payload }],
          timestamp: Date.now(),
        };

        const response = await complete(
          ctx.model,
          { systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
          { apiKey, signal: loader.signal },
        );

        if (response.stopReason === "aborted") return null;

        return response.content
          .filter((block): block is { type: "text"; text: string } => block.type === "text")
          .map((block) => block.text)
          .join("\n")
          .trim();
      };

      generate()
        .then(done)
        .catch((error) => {
          console.error("handoff generation failed", error);
          done(null);
        });

      return loader;
    },
  )) as string | null;

  return result;
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

      const draft = await generateDraftWithLoader(handoffContext, ctx);
      if (!draft) {
        ctx.ui.notify("Cancelled", "info");
        return;
      }

      const schemaDraft = enforceSchema(draft, handoffContext);
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
