import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  capsulePrompt,
  capsuleRevisionLabel,
  extractSessionEvidence,
  generateCapsule,
  loadCapsule,
  previewCapsule,
  proposeCapsuleRefresh,
  renderCapsuleDrift,
  saveCapsule,
  type Capsule,
  type CapsuleResult,
  type CapsuleStore,
  type SessionEntryLike,
} from "./lib/context-capsule.js";

export type CapsuleCommandState = {
  lastPreview?: Capsule;
};

export type CapsuleCommandContext = {
  cwd: string;
  hasUI: boolean;
  waitForIdle: () => Promise<void>;
  sessionManager: {
    getBranch: () => unknown[];
    getSessionId: () => string;
    getSessionFile: () => string | undefined;
  };
  ui: {
    notify: (message: string, level?: "info" | "warning" | "error") => void;
    confirm: (title: string, message: string) => Promise<boolean>;
  };
  newSession: (options: {
    parentSession?: string;
    setup?: (sessionManager: {
      appendCustomMessageEntry: (
        customType: string,
        content: string,
        display: boolean,
        details?: unknown,
      ) => string;
    }) => void | Promise<void>;
    withSession?: (context: {
      sendUserMessage: (content: string) => Promise<void>;
      ui: { notify: (message: string, level?: "info" | "warning" | "error") => void };
    }) => void | Promise<void>;
  }) => Promise<{ cancelled: boolean }>;
};

export type CapsuleCommandDependencies = {
  load: (reference: string, store?: CapsuleStore) => Promise<CapsuleResult<Capsule>>;
  save: (capsule: Capsule, store?: CapsuleStore) => Promise<CapsuleResult<string>>;
};

const defaultDependencies: CapsuleCommandDependencies = {
  load: loadCapsule,
  save: saveCapsule,
};

function resultError(result: CapsuleResult<unknown>): string {
  return "error" in result ? `${result.error.code}: ${result.error.message}` : "";
}

function showPreview(context: CapsuleCommandContext, capsule: Capsule): void {
  const preview = previewCapsule(capsule);
  context.ui.notify(
    `${preview.humanText}\n\nCanonical representation: ${preview.byteLength} UTF-8 bytes`,
    "info",
  );
}

async function confirmSideEffect(
  context: CapsuleCommandContext,
  title: string,
  message: string,
): Promise<boolean> {
  if (!context.hasUI) {
    context.ui.notify(
      "Capsule operation requires explicit interactive confirmation; no filesystem or session changes were made.",
      "error",
    );
    return false;
  }
  return context.ui.confirm(title, message);
}

async function generateCurrentCapsule(
  context: CapsuleCommandContext,
): Promise<CapsuleResult<Capsule>> {
  await context.waitForIdle();
  return generateCapsule(
    extractSessionEvidence(context.sessionManager.getBranch() as SessionEntryLike[], context.cwd),
    {
      sessionId: context.sessionManager.getSessionId(),
      sessionFile: context.sessionManager.getSessionFile(),
      cwd: context.cwd,
    },
  );
}

async function resumeFromCapsule(context: CapsuleCommandContext, capsule: Capsule): Promise<void> {
  const parentSession = capsule.source.sessionFile;
  const prompt = capsulePrompt(capsule);
  const label = capsuleRevisionLabel(capsule);
  const result = await context.newSession({
    parentSession,
    setup: (sessionManager) => {
      sessionManager.appendCustomMessageEntry("context-capsule", prompt, true, {
        capsuleId: capsule.capsuleId,
        revision: capsule.revision,
        sourceSessionId: capsule.source.sessionId,
      });
    },
    withSession: async (replacementContext) => {
      replacementContext.ui.notify(
        `Related session created from Context Capsule ${label}.`,
        "info",
      );
      await replacementContext.sendUserMessage(
        `Continue from Context Capsule ${label}. Review and verify its recorded next action before choosing what to do.`,
      );
    },
  });

  // The original context remains valid only when replacement was cancelled.
  if (result.cancelled) {
    context.ui.notify("Capsule resume cancelled; the source session was unchanged.", "info");
  }
}

function parseCommand(rawArguments: string): { command: string; reference?: string } {
  const trimmed = rawArguments.trim();
  if (!trimmed) return { command: "preview" };
  const separator = trimmed.search(/\s/);
  if (separator < 0) return { command: trimmed };
  return {
    command: trimmed.slice(0, separator),
    reference: trimmed.slice(separator).trim() || undefined,
  };
}

export async function handleCapsuleCommand(
  rawArguments: string,
  context: CapsuleCommandContext,
  state: CapsuleCommandState,
  dependencies: CapsuleCommandDependencies = defaultDependencies,
): Promise<void> {
  const { command, reference } = parseCommand(rawArguments);

  if (command === "preview" || command === "save") {
    const generated = await generateCurrentCapsule(context);
    if (!generated.ok) {
      context.ui.notify(`Capsule generation failed: ${resultError(generated)}`, "error");
      return;
    }
    state.lastPreview = generated.value;
    showPreview(context, generated.value);

    if (command === "save") {
      const confirmed = await confirmSideEffect(
        context,
        "Save this Context Capsule?",
        "The complete capsule shown above will be written to Pi-owned user state.",
      );
      if (!confirmed) {
        context.ui.notify("Capsule save cancelled; no file was written.", "info");
        return;
      }
      const saved = await dependencies.save(generated.value);
      context.ui.notify(
        saved.ok ? `Capsule saved: ${saved.value}` : `Capsule save failed: ${resultError(saved)}`,
        saved.ok ? "info" : "error",
      );
    }
    return;
  }

  if (command === "refresh") {
    if (!reference) {
      context.ui.notify("Usage: /capsule refresh <capsule-id-or-path>", "error");
      return;
    }
    const loaded = await dependencies.load(reference);
    if (!loaded.ok) {
      context.ui.notify(`Capsule load failed: ${resultError(loaded)}`, "error");
      return;
    }
    await context.waitForIdle();
    const proposed = await proposeCapsuleRefresh(
      loaded.value,
      extractSessionEvidence(context.sessionManager.getBranch() as SessionEntryLike[], context.cwd),
      {
        sessionId: context.sessionManager.getSessionId(),
        sessionFile: context.sessionManager.getSessionFile(),
        cwd: context.cwd,
      },
    );
    if (!proposed.ok) {
      context.ui.notify(`Capsule refresh failed: ${resultError(proposed)}`, "error");
      return;
    }

    const successorPreview = previewCapsule(proposed.value.successor);
    context.ui.notify(
      `${renderCapsuleDrift(proposed.value)}\n\n# Proposed successor\n\n${successorPreview.humanText}\n\nCanonical representation: ${successorPreview.byteLength} UTF-8 bytes`,
      "info",
    );
    if (proposed.value.drift.noOp) return;

    const confirmed = await confirmSideEffect(
      context,
      "Save this refreshed Context Capsule revision?",
      "The complete successor shown above will be saved as a new immutable capsule. Its predecessor will remain unchanged.",
    );
    if (!confirmed) {
      context.ui.notify(
        "Capsule refresh cancelled; the predecessor and active session were unchanged.",
        "info",
      );
      return;
    }
    const saved = await dependencies.save(proposed.value.successor);
    if (!saved.ok) {
      context.ui.notify(
        `Capsule refresh save failed: ${resultError(saved)}; the predecessor and active session were unchanged.`,
        "error",
      );
      return;
    }
    state.lastPreview = proposed.value.successor;
    context.ui.notify(`Refreshed capsule saved: ${saved.value}`, "info");
    return;
  }

  if (command === "load") {
    if (!reference) {
      context.ui.notify("Usage: /capsule load <capsule-id-or-path>", "error");
      return;
    }
    const loaded = await dependencies.load(reference);
    if (!loaded.ok) {
      context.ui.notify(`Capsule load failed: ${resultError(loaded)}`, "error");
      return;
    }
    state.lastPreview = loaded.value;
    showPreview(context, loaded.value);
    return;
  }

  if (command === "resume") {
    let capsule = state.lastPreview;
    if (reference) {
      const loaded = await dependencies.load(reference);
      if (!loaded.ok) {
        context.ui.notify(`Capsule load failed: ${resultError(loaded)}`, "error");
        return;
      }
      capsule = loaded.value;
    }
    if (!capsule) {
      context.ui.notify(
        "Usage: /capsule resume <capsule-id-or-path>, or preview a capsule first.",
        "error",
      );
      return;
    }

    showPreview(context, capsule);
    const confirmed = await confirmSideEffect(
      context,
      "Create a related Pi session?",
      "The source session will remain unchanged. The new session receives only this untrusted capsule and its next action.",
    );
    if (!confirmed) {
      context.ui.notify("Capsule resume cancelled; the source session was unchanged.", "info");
      return;
    }
    await resumeFromCapsule(context, capsule);
    return;
  }

  context.ui.notify(
    "Usage: /capsule preview | save | refresh <capsule-id-or-path> | load <capsule-id-or-path> | resume [capsule-id-or-path]",
    "error",
  );
}

export default function contextCapsuleExtension(pi: ExtensionAPI): void {
  const state: CapsuleCommandState = {};
  pi.registerCommand("capsule", {
    description: "Generate, preview, save, refresh, load, or resume a Context Capsule",
    handler: async (argumentsText, context) => {
      try {
        await handleCapsuleCommand(
          argumentsText,
          context as unknown as CapsuleCommandContext,
          state,
        );
      } catch (error) {
        context.ui.notify(
          `Capsule operation failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });
}
