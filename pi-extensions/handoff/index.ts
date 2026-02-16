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

import type { ExtensionAPI, SessionEntry } from "@mariozechner/pi-coding-agent";

import {
  buildHandoffContext,
  enforceSchema,
  generateDraftWithLoader,
  USAGE_TEXT,
} from "./helpers.js";

// Re-export public types and functions for external use
export type { HandoffContext } from "./types.js";
export {
  truncateText,
  extractFileCandidates,
  ensureAcceptanceChecklist,
  enforceSchema,
} from "./helpers.js";
export { generateDraftWithLoader } from "./helpers.js";

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
