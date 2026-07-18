import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  capsulePinsPrompt,
  capsulePrompt,
  capsuleRevisionLabel,
  extractSessionEvidence,
  generateCapsule,
  loadCapsule,
  pinCapsuleFacts,
  readCapsulePinState,
  removeCapsulePins,
  renderCapsulePins,
  selectCapsuleFacts,
  previewCapsule,
  proposeCapsuleRefresh,
  renderCapsuleDrift,
  saveCapsule,
  stripPinnedCompactionSummary,
  CONTEXT_CAPSULE_PINS_ENTRY,
  CONTEXT_CAPSULE_PINS_MESSAGE,
  type Capsule,
  type CapsuleFact,
  type CapsulePinState,
  type CapsuleResult,
  type CapsuleStore,
  type SessionEntryLike,
} from "./lib/context-capsule.js";

type PendingCapsuleSelection = {
  facts: CapsuleFact[];
  sessionId: string;
  leafId: string | null;
  capsuleId: string;
  revision: number;
};

export type CapsuleCommandState = {
  lastPreview?: Capsule;
  pendingFacts?: PendingCapsuleSelection;
};

export type CapsuleCommandContext = {
  cwd: string;
  hasUI: boolean;
  waitForIdle: () => Promise<void>;
  sessionManager: {
    getBranch: () => unknown[];
    getLeafId: () => string | null;
    getSessionId: () => string;
    getSessionFile: () => string | undefined;
    appendCustomEntry?: (customType: string, data?: unknown) => string;
    appendCustomMessageEntry?: (
      customType: string,
      content: string,
      display: boolean,
      details?: unknown,
    ) => string;
  };
  ui: {
    notify: (message: string, level?: "info" | "warning" | "error") => void;
    confirm: (title: string, message: string) => Promise<boolean>;
    onTerminalInput?: (
      handler: (data: string) => { consume?: boolean; data?: string } | undefined,
    ) => () => void;
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

function currentPinState(context: CapsuleCommandContext): CapsulePinState {
  return readCapsulePinState(context.sessionManager.getBranch() as SessionEntryLike[]);
}

function pinError(result: CapsuleResult<unknown>): string {
  return "error" in result ? `${result.error.code}: ${result.error.message}` : "";
}

function isCancelled(result: CapsuleResult<unknown>): boolean {
  return "error" in result && result.error.code === "cancelled";
}

function showPins(context: CapsuleCommandContext, state = currentPinState(context)): void {
  context.ui.notify(renderCapsulePins(state), "info");
}

function setLastPreview(state: CapsuleCommandState, capsule: Capsule): void {
  state.lastPreview = capsule;
  state.pendingFacts = undefined;
}

function pendingSelectionIsCurrent(
  pending: PendingCapsuleSelection,
  context: CapsuleCommandContext,
  capsule: Capsule | undefined,
): boolean {
  return (
    pending.sessionId === context.sessionManager.getSessionId() &&
    pending.leafId === context.sessionManager.getLeafId() &&
    capsule !== undefined &&
    pending.capsuleId === capsule.capsuleId &&
    pending.revision === capsule.revision
  );
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

function cancelledCapsuleResult<T>(): CapsuleResult<T> {
  return {
    ok: false,
    error: {
      code: "cancelled",
      message: "Capsule generation was cancelled before side effects.",
    },
  };
}

async function runCancellableCapsuleOperation<T>(
  context: CapsuleCommandContext,
  operation: (signal: AbortSignal) => Promise<CapsuleResult<T>>,
): Promise<CapsuleResult<T>> {
  const controller = new AbortController();
  const unsubscribe = context.ui.onTerminalInput?.((data) => {
    if (data !== "\u001b") return undefined;
    controller.abort();
    return { consume: true };
  });
  const cancelled = new Promise<false>((resolve) => {
    controller.signal.addEventListener("abort", () => resolve(false), { once: true });
  });

  try {
    const idle = await Promise.race([context.waitForIdle().then(() => true as const), cancelled]);
    if (!idle || controller.signal.aborted) return cancelledCapsuleResult();
    const result = await operation(controller.signal);
    return controller.signal.aborted ? cancelledCapsuleResult() : result;
  } finally {
    unsubscribe?.();
  }
}

async function generateCurrentCapsule(
  context: CapsuleCommandContext,
): Promise<CapsuleResult<Capsule>> {
  return runCancellableCapsuleOperation(context, (signal) =>
    generateCapsule(
      extractSessionEvidence(context.sessionManager.getBranch() as SessionEntryLike[], context.cwd),
      {
        sessionId: context.sessionManager.getSessionId(),
        sessionFile: context.sessionManager.getSessionFile(),
        cwd: context.cwd,
        signal,
      },
    ),
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
      try {
        await replacementContext.sendUserMessage(
          `Continue from Context Capsule ${label}. Review and verify its recorded next action before choosing what to do.`,
        );
      } catch (error) {
        replacementContext.ui.notify(
          `Unable to continue in replacement session: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  // The original context remains valid only when replacement was cancelled.
  if (result.cancelled) {
    context.ui.notify("Capsule resume cancelled; the source session was unchanged.", "info");
  }
}

function parseIndices(raw: string): number[] | "all" | undefined {
  if (raw.trim().toLowerCase() === "all") return "all";
  const values = raw.split(",").map((value) => Number(value.trim()));
  if (!values.length || values.some((value) => !Number.isInteger(value) || value < 1))
    return undefined;
  return [...new Set(values)];
}

async function handlePinsCommand(
  argumentText: string,
  context: CapsuleCommandContext,
  state: CapsuleCommandState,
  dependencies: CapsuleCommandDependencies,
): Promise<void> {
  const separator = argumentText.search(/\s/);
  const subcommand = (
    separator < 0 ? argumentText : argumentText.slice(0, separator)
  ).toLowerCase();
  const argument = separator < 0 ? "" : argumentText.slice(separator).trim();

  if (subcommand === "inspect" || !subcommand) {
    showPins(context);
    return;
  }
  if (subcommand === "select") {
    let capsule = state.lastPreview;
    if (argument) {
      const loaded = await dependencies.load(argument);
      if (!loaded.ok) {
        context.ui.notify(`Capsule load failed: ${resultError(loaded)}`, "error");
        return;
      }
      capsule = loaded.value;
      setLastPreview(state, capsule);
    }
    if (!capsule) {
      context.ui.notify(
        "Usage: /capsule pins select [capsule-id-or-path] (preview or load a capsule first).",
        "error",
      );
      return;
    }
    const pendingFacts = selectCapsuleFacts(capsule);
    state.pendingFacts = {
      facts: pendingFacts,
      sessionId: context.sessionManager.getSessionId(),
      leafId: context.sessionManager.getLeafId(),
      capsuleId: capsule.capsuleId,
      revision: capsule.revision,
    };
    const existing = currentPinState(context);
    const text = pendingFacts
      .map(
        (fact, index) =>
          `${index + 1}. [${fact.category}] ${fact.statement}${existing.pins.some((pin) => pin.category === fact.category && pin.statement === fact.statement) ? " (already pinned)" : ""}`,
      )
      .join("\n");
    context.ui.notify(text || "No selectable facts found.", "info");
    return;
  }
  if (subcommand === "confirm") {
    const indices = parseIndices(argument);
    if (!indices || indices === "all") {
      context.ui.notify("Usage: /capsule pins confirm <comma-separated fact numbers>", "error");
      return;
    }
    const pending = state.pendingFacts;
    const currentCapsule = state.lastPreview;
    if (!pending) {
      context.ui.notify("Select capsule facts first: /capsule pins select [ref]", "error");
      return;
    }
    if (!pendingSelectionIsCurrent(pending, context, currentCapsule)) {
      state.pendingFacts = undefined;
      context.ui.notify("Capsule fact selection is stale; select facts again.", "error");
      return;
    }
    const selected = indices.map((index) => pending.facts[index - 1]);
    if (selected.some((fact) => !fact)) {
      context.ui.notify("One or more selected fact numbers are out of range.", "error");
      return;
    }
    const proposed = pinCapsuleFacts(currentPinState(context), selected as CapsuleFact[]);
    if (!proposed.ok) {
      context.ui.notify(`Pin confirmation failed: ${pinError(proposed)}`, "error");
      return;
    }
    const confirmed = await confirmSideEffect(
      context,
      "Confirm Context Capsule facts?",
      `Persist ${selected.length} selected fact(s) for future compaction. Unselected and unconfirmed facts will not be pinned.`,
    );
    if (!confirmed) {
      context.ui.notify("Pin confirmation cancelled; no facts were persisted.", "info");
      return;
    }
    if (!pendingSelectionIsCurrent(pending, context, state.lastPreview)) {
      state.pendingFacts = undefined;
      context.ui.notify("Capsule fact selection is stale; select facts again.", "error");
      return;
    }
    if (!context.sessionManager.appendCustomEntry) {
      context.ui.notify("Pin persistence is unavailable in this Pi session.", "error");
      return;
    }
    context.sessionManager.appendCustomEntry(CONTEXT_CAPSULE_PINS_ENTRY, proposed.value);
    state.pendingFacts = undefined;
    context.ui.notify(`Confirmed ${selected.length} Context Capsule fact(s).`, "info");
    return;
  }
  if (subcommand === "remove") {
    const indices = parseIndices(argument);
    if (!indices) {
      context.ui.notify("Usage: /capsule pins remove <comma-separated pin numbers|all>", "error");
      return;
    }
    const selectedSessionId = context.sessionManager.getSessionId();
    const selectedLeafId = context.sessionManager.getLeafId();
    const current = currentPinState(context);
    if (indices !== "all" && indices.some((index) => index > current.pins.length)) {
      context.ui.notify("One or more selected pin numbers are out of range.", "error");
      return;
    }
    const next = removeCapsulePins(current, indices);
    const confirmed = await confirmSideEffect(
      context,
      "Remove Context Capsule facts?",
      `Remove ${indices === "all" ? "all" : indices.length} confirmed fact(s) from future compactions.`,
    );
    if (!confirmed) {
      context.ui.notify("Pin removal cancelled; no facts were changed.", "info");
      return;
    }
    if (
      selectedSessionId !== context.sessionManager.getSessionId() ||
      selectedLeafId !== context.sessionManager.getLeafId()
    ) {
      context.ui.notify(
        "Pin removal cancelled because the active branch changed; inspect pins again.",
        "error",
      );
      return;
    }
    if (!context.sessionManager.appendCustomEntry) {
      context.ui.notify("Pin persistence is unavailable in this Pi session.", "error");
      return;
    }
    context.sessionManager.appendCustomEntry(CONTEXT_CAPSULE_PINS_ENTRY, next);
    context.ui.notify("Confirmed Context Capsule facts updated.", "info");
    return;
  }
  context.ui.notify(
    "Usage: /capsule pins select [ref] | confirm <numbers> | inspect | remove <numbers|all>",
    "error",
  );
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

  if (command === "pins") {
    await handlePinsCommand(reference ?? "", context, state, dependencies);
    return;
  }

  if (command === "preview" || command === "save") {
    const generated = await generateCurrentCapsule(context);
    if (!generated.ok) {
      context.ui.notify(
        isCancelled(generated)
          ? "Capsule generation cancelled; no preview, state, filesystem, or session changes were made."
          : `Capsule generation failed: ${resultError(generated)}`,
        isCancelled(generated) ? "info" : "error",
      );
      return;
    }
    setLastPreview(state, generated.value);
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
    const proposed = await runCancellableCapsuleOperation(context, (signal) =>
      proposeCapsuleRefresh(
        loaded.value,
        extractSessionEvidence(
          context.sessionManager.getBranch() as SessionEntryLike[],
          context.cwd,
        ),
        {
          sessionId: context.sessionManager.getSessionId(),
          sessionFile: context.sessionManager.getSessionFile(),
          cwd: context.cwd,
          signal,
        },
      ),
    );
    if (!proposed.ok) {
      context.ui.notify(
        isCancelled(proposed)
          ? "Capsule refresh cancelled; no preview, state, filesystem, or session changes were made."
          : `Capsule refresh failed: ${resultError(proposed)}`,
        isCancelled(proposed) ? "info" : "error",
      );
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
    setLastPreview(state, loaded.value);
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
      setLastPreview(state, capsule);
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
    "Usage: /capsule preview | save | refresh <capsule-id-or-path> | load <capsule-id-or-path> | resume [capsule-id-or-path] | pins select [ref] | pins confirm <numbers> | pins inspect | pins remove <numbers|all>",
    "error",
  );
}

function isPinnedProjectionMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const candidate = message as { role?: unknown; customType?: unknown };
  return candidate.role === "custom" && candidate.customType === CONTEXT_CAPSULE_PINS_MESSAGE;
}

function projectPinnedContext(
  messages: readonly unknown[],
  pins: CapsulePinState,
): unknown[] | undefined {
  let changed = false;
  const projected = messages.flatMap((message) => {
    if (isPinnedProjectionMessage(message)) {
      changed = true;
      return [];
    }
    if (!message || typeof message !== "object") return [message];
    const candidate = message as { role?: unknown; summary?: unknown };
    if (candidate.role !== "compactionSummary" || typeof candidate.summary !== "string") {
      return [message];
    }
    const summary = stripPinnedCompactionSummary(candidate.summary);
    if (summary === candidate.summary) return [message];
    changed = true;
    return [{ ...candidate, summary }];
  });

  if (pins.pins.length) {
    changed = true;
    projected.push({
      role: "custom",
      customType: CONTEXT_CAPSULE_PINS_MESSAGE,
      content: capsulePinsPrompt(pins),
      display: false,
      timestamp: Date.now(),
    });
  }
  return changed ? projected : undefined;
}

export default function contextCapsuleExtension(pi: ExtensionAPI): void {
  const state: CapsuleCommandState = {};
  pi.on("context", (event, context) => {
    const pins = readCapsulePinState(context.sessionManager.getBranch() as SessionEntryLike[]);
    const messages = projectPinnedContext(event.messages, pins);
    return messages ? { messages: messages as typeof event.messages } : undefined;
  });
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
