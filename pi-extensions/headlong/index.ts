import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ActorLease } from "./lease.js";
import { applyMeaningfulEvent, computeIdleDelayMs, nextIdleBackoff } from "./policy.js";
import { HeadlongStore, createInitialActorState, type HeadlongActorState } from "./store.js";

const CONTROL_TOOLS = [
  "headlong_checkpoint",
  "headlong_sleep",
  "headlong_complete",
  "headlong_blocked",
] as const;
const SAFE_UNATTENDED_TOOLS = new Set(["read", "grep", "find", "ls", "edit", "write"]);

export type HeadlongExtensionOptions = {
  stateRoot?: string;
  now?: () => number;
  setTimer?: (callback: () => Promise<void> | void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  setDeadlineTimer?: (callback: () => Promise<void> | void, delayMs: number) => unknown;
  clearDeadlineTimer?: (timer: unknown) => void;
  maxTurnsPerWake?: number;
  maxWakeMs?: number;
  leaseToken?: string;
  supervisorWakeId?: string;
  beforeWakeStateWrite?: () => Promise<void>;
  acquireLease?: typeof ActorLease.acquire;
};

type HeadlongRuntime = {
  generation: number;
  store?: HeadlongStore;
  lease?: ActorLease;
  timer?: unknown;
  deadlineTimer?: unknown;
  context?: ExtensionContext;
  sessionFile?: string;
  sessionId?: string;
  workspace?: string;
  activeWakeId?: string;
  pendingTransition?: HeadlongActorState;
  turnCount: number;
  previousTools?: string[];
};

function defaultStateRoot(): string {
  const base = process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
  return join(base, "pi-headlong");
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], details: {}, isError };
}

export function buildHeadlongWakePrompt(wakeId: string): string {
  return [
    `HEADLONG WAKE ${wakeId}. Continue the persistent workspace objective.`,
    "The Pi session tree/JSONL is the canonical conversation trajectory; do not create transcript memory.",
    "Use PRO-LONG programmatic history when enabled and earlier evidence matters.",
    "Before this wake settles, call exactly one explicit control transition:",
    "headlong_checkpoint, headlong_sleep, headlong_complete, or headlong_blocked.",
    "Do not send external messages, publish, release, merge, deploy, or perform destructive/public effects.",
  ].join(" ");
}

function nextRevision(state: HeadlongActorState, now: number): HeadlongActorState {
  return { ...state, revision: state.revision + 1, updatedAt: new Date(now).toISOString() };
}

export function registerHeadlongExtension(
  pi: ExtensionAPI,
  options: HeadlongExtensionOptions = {},
): void {
  const runtime: HeadlongRuntime = { generation: 0, turnCount: 0 };
  const now = options.now ?? Date.now;
  const setTimer =
    options.setTimer ??
    ((callback: () => Promise<void> | void, delayMs: number) => setTimeout(callback, delayMs));
  const clearTimer =
    options.clearTimer ?? ((timer: unknown) => clearTimeout(timer as NodeJS.Timeout));
  const setDeadlineTimer =
    options.setDeadlineTimer ??
    ((callback: () => Promise<void> | void, delayMs: number) => setTimeout(callback, delayMs));
  const clearDeadlineTimer =
    options.clearDeadlineTimer ?? ((timer: unknown) => clearTimeout(timer as NodeJS.Timeout));
  const stateRoot = options.stateRoot ?? process.env.PI_HEADLONG_STATE_ROOT ?? defaultStateRoot();
  const supervisorWakeId = options.supervisorWakeId ?? process.env.PI_HEADLONG_SUPERVISOR_WAKE_ID;
  const acquireLease = options.acquireLease ?? ActorLease.acquire;
  let wakeMutationTail: Promise<void> = Promise.resolve();

  const serializeWakeMutation = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = wakeMutationTail;
    let release!: () => void;
    wakeMutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };

  const restoreTools = () => {
    if (runtime.previousTools) {
      pi.setActiveTools(runtime.previousTools);
      runtime.previousTools = undefined;
    }
  };

  const restrictUnattendedTools = () => {
    runtime.previousTools ??= pi.getActiveTools();
    const available = new Set(pi.getAllTools().map((tool) => tool.name));
    const configured = (process.env.PI_HEADLONG_TOOLS ?? "read,grep,find,ls,edit,write")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => SAFE_UNATTENDED_TOOLS.has(name));
    pi.setActiveTools([...configured, ...CONTROL_TOOLS].filter((name) => available.has(name)));
  };

  const clearWakeTimer = () => {
    if (runtime.timer !== undefined) clearTimer(runtime.timer);
    runtime.timer = undefined;
  };

  const clearWakeDeadline = () => {
    if (runtime.deadlineTimer !== undefined) clearDeadlineTimer(runtime.deadlineTimer);
    runtime.deadlineTimer = undefined;
  };

  const failClosedActiveWake = async (
    wakeId: string,
    type: "wake.budget_exceeded" | "wake.missing_transition",
    detail: unknown,
    alreadySettled = false,
  ): Promise<void> => {
    const store = runtime.store;
    const lease = runtime.lease;
    const context = runtime.context;
    if (!store || !lease || !context || runtime.activeWakeId !== wakeId) return;
    await lease.assertOwned();
    const state = await store.readState();
    if (!state?.activeWakeId || state.activeWakeId !== wakeId || runtime.activeWakeId !== wakeId) {
      return;
    }
    if (!alreadySettled) context.abort();
    const next: HeadlongActorState = {
      ...nextRevision(state, now()),
      status: "paused",
      wakeAt: null,
      activeWakeId: null,
      wakeStartedAt: null,
      consecutiveFailures: state.consecutiveFailures + 1,
    };
    await store.writeState(next);
    await store.appendEvent({ at: next.updatedAt, type, wakeId, detail });
    runtime.activeWakeId = undefined;
    clearWakeTimer();
    clearWakeDeadline();
    if (alreadySettled) restoreTools();
    else runtime.pendingTransition = next;
  };

  const armWakeDeadline = (generation: number, wakeId: string): void => {
    clearWakeDeadline();
    const maxWakeMs = options.maxWakeMs ?? 30 * 60_000;
    runtime.deadlineTimer = setDeadlineTimer(async () => {
      try {
        await serializeWakeMutation(async () => {
          if (generation !== runtime.generation || runtime.activeWakeId !== wakeId) return;
          await failClosedActiveWake(wakeId, "wake.budget_exceeded", {
            source: "wall-clock-watchdog",
            maxWakeMs,
          });
        });
      } catch (error) {
        if (generation !== runtime.generation || runtime.activeWakeId !== wakeId) return;
        runtime.context?.abort();
        runtime.activeWakeId = undefined;
        clearWakeTimer();
        clearWakeDeadline();
        restoreTools();
        runtime.context?.ui.notify(
          `Headlong watchdog failed closed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    }, maxWakeMs);
  };

  const dispatchWake = async (generation: number): Promise<void> => {
    const store = runtime.store;
    const lease = runtime.lease;
    if (generation !== runtime.generation || !store || !lease) return;
    await lease.assertOwned();
    if (generation !== runtime.generation || runtime.store !== store || runtime.lease !== lease)
      return;
    const state = await store.readState();
    if (generation !== runtime.generation || runtime.store !== store || runtime.lease !== lease)
      return;
    if (!state || !["running", "sleeping"].includes(state.status) || state.activeWakeId) return;
    const wakeTime = state.wakeAt ? Date.parse(state.wakeAt) : now();
    if (wakeTime > now()) {
      scheduleWake(state, generation);
      return;
    }
    const wakeSequence = state.wakeSequence + 1;
    const wakeId = `wake-${wakeSequence}-${randomUUID()}`;
    const startedAt = new Date(now()).toISOString();
    await options.beforeWakeStateWrite?.();
    if (generation !== runtime.generation || runtime.store !== store || runtime.lease !== lease)
      return;
    await store.writeState({
      ...nextRevision(state, now()),
      status: "running",
      wakeAt: null,
      wakeSequence,
      activeWakeId: wakeId,
      wakeStartedAt: startedAt,
    });
    await store.appendEvent({
      at: startedAt,
      type: "wake.dispatched",
      wakeId,
      detail: { source: "live-extension" },
    });
    if (generation !== runtime.generation || runtime.store !== store || runtime.lease !== lease) {
      const published = await store.readState();
      if (published?.activeWakeId === wakeId) {
        const invalidatedAt = new Date(now()).toISOString();
        await store.writeState({
          ...nextRevision(published, now()),
          status: "paused",
          wakeAt: null,
          activeWakeId: null,
          wakeStartedAt: null,
          consecutiveFailures: published.consecutiveFailures + 1,
        });
        await store.appendEvent({
          at: invalidatedAt,
          type: "wake.dispatch_invalidated",
          wakeId,
          detail: { reason: "session lifecycle changed during dispatch" },
        });
      }
      return;
    }
    runtime.activeWakeId = wakeId;
    runtime.turnCount = 0;
    restrictUnattendedTools();
    armWakeDeadline(generation, wakeId);
    pi.sendUserMessage(buildHeadlongWakePrompt(wakeId), { deliverAs: "followUp" });
  };

  const scheduleWake = (state: HeadlongActorState, generation = runtime.generation): void => {
    clearWakeTimer();
    if (!["running", "sleeping"].includes(state.status) || state.activeWakeId) return;
    const delay = Math.max(0, (state.wakeAt ? Date.parse(state.wakeAt) : now()) - now());
    runtime.timer = setTimer(async () => {
      try {
        await serializeWakeMutation(() => dispatchWake(generation));
      } catch (error) {
        restoreTools();
        if (!runtime.store || generation !== runtime.generation) return;
        const current = await runtime.store.readState();
        if (!current) return;
        await runtime.store.writeState({
          ...nextRevision(current, now()),
          status: "paused",
          wakeAt: null,
          activeWakeId: null,
          wakeStartedAt: null,
          consecutiveFailures: current.consecutiveFailures + 1,
        });
        await runtime.store.appendEvent({
          at: new Date(now()).toISOString(),
          type: "wake.dispatch_failed",
          detail: { message: error instanceof Error ? error.message : String(error) },
        });
      }
    }, delay);
  };

  const requireRuntime = (context: ExtensionContext): HeadlongStore | undefined => {
    if (!runtime.store || !runtime.lease) {
      context.ui.notify(
        "Headlong is passive because another process owns this workspace actor.",
        "error",
      );
      return undefined;
    }
    return runtime.store;
  };

  const transition = async (
    kind: "checkpoint" | "sleep" | "complete" | "blocked",
    detail: { note?: string; reason?: string; summary?: string; delaySeconds?: number },
    context: ExtensionContext,
  ) => {
    const store = requireRuntime(context);
    if (!store || !runtime.lease) return textResult("Headlong actor is not owned.", true);
    await runtime.lease.assertOwned();
    const state = await store.readState();
    if (!state?.activeWakeId) return textResult("No active Headlong wake can transition.", true);
    const wakeId = state.activeWakeId;
    const backoffConfig = { baseMs: 5_000, factor: 2, capMs: 300_000, hold: 3 };
    let status: HeadlongActorState["status"];
    let wakeAt: string | null = null;
    let backoffLevel = state.backoffLevel;
    let ticksAtLevel = state.ticksAtLevel;
    let consecutiveFailures = state.consecutiveFailures;
    if (kind === "complete") status = "completed";
    else if (kind === "blocked") status = "blocked";
    else {
      status = "sleeping";
      if (kind === "checkpoint") {
        backoffLevel = 0;
        ticksAtLevel = 0;
        consecutiveFailures = 0;
        wakeAt = new Date(now()).toISOString();
      } else if (detail.delaySeconds !== undefined) {
        wakeAt = new Date(now() + detail.delaySeconds * 1_000).toISOString();
      } else {
        const next = nextIdleBackoff({ backoffLevel, ticksAtLevel }, backoffConfig);
        backoffLevel = next.backoffLevel;
        ticksAtLevel = next.ticksAtLevel;
        wakeAt = new Date(now() + computeIdleDelayMs(backoffLevel, backoffConfig)).toISOString();
      }
    }
    const next: HeadlongActorState = {
      ...nextRevision(state, now()),
      status,
      wakeAt,
      activeWakeId: null,
      wakeStartedAt: null,
      lastTransitionWakeId: wakeId,
      backoffLevel,
      ticksAtLevel,
      consecutiveFailures,
    };
    await store.writeState(next);
    await store.appendEvent({
      at: next.updatedAt,
      type: `wake.${kind}`,
      wakeId,
      detail,
    });
    runtime.activeWakeId = undefined;
    runtime.pendingTransition = next;
    pi.setActiveTools([]);
    clearWakeTimer();
    clearWakeDeadline();
    return textResult(
      status === "sleeping"
        ? `Headlong ${kind} recorded; next wake ${wakeAt}.`
        : `Headlong ${status}.`,
    );
  };

  pi.registerTool({
    name: "headlong_checkpoint",
    label: "Headlong checkpoint",
    description:
      "Record meaningful progress and schedule the persistent actor to continue. This is operational state, not transcript memory.",
    parameters: Type.Object({ note: Type.String({ minLength: 1, maxLength: 2_000 }) }),
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, context) {
      return serializeWakeMutation(() => transition("checkpoint", { note: params.note }, context));
    },
  });
  pi.registerTool({
    name: "headlong_sleep",
    label: "Headlong sleep",
    description: "End this wake explicitly and schedule the next wake after a bounded delay.",
    parameters: Type.Object({
      reason: Type.String({ minLength: 1, maxLength: 2_000 }),
      delaySeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 86_400 })),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, context) {
      return serializeWakeMutation(() =>
        transition("sleep", { reason: params.reason, delaySeconds: params.delaySeconds }, context),
      );
    },
  });
  pi.registerTool({
    name: "headlong_complete",
    label: "Headlong complete",
    description: "Mark the persistent actor complete and stop all future wakes.",
    parameters: Type.Object({ summary: Type.String({ minLength: 1, maxLength: 2_000 }) }),
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, context) {
      return serializeWakeMutation(() =>
        transition("complete", { summary: params.summary }, context),
      );
    },
  });
  pi.registerTool({
    name: "headlong_blocked",
    label: "Headlong blocked",
    description: "Mark the persistent actor blocked and stop wakes until a user resumes it.",
    parameters: Type.Object({ reason: Type.String({ minLength: 1, maxLength: 2_000 }) }),
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, context) {
      return serializeWakeMutation(() => transition("blocked", { reason: params.reason }, context));
    },
  });

  pi.registerCommand("headlong", {
    description: "Control the persistent Headlong actor: start, resume, pause, status, or stop",
    handler: async (argumentsText, context) =>
      serializeWakeMutation(async () => {
        const action = argumentsText.trim().toLowerCase();
        if (!["start", "resume", "pause", "status", "stop"].includes(action)) {
          context.ui.notify("Usage: /headlong start | resume | pause | status | stop", "error");
          return;
        }
        const store = requireRuntime(context);
        if (!store || !runtime.lease) return;
        await runtime.lease.assertOwned();
        const existing = await store.readState();
        if (action === "status") {
          context.ui.notify(
            existing
              ? `Headlong: ${existing.status}\nWake: ${existing.wakeAt ?? "none"}\nFailures: ${existing.consecutiveFailures}\nState: ${store.statePath}`
              : `Headlong: not started\nState: ${store.statePath}`,
            "info",
          );
          return;
        }
        if (
          existing &&
          (existing.status === "stopped" || existing.status === "completed") &&
          (action === "start" || action === "resume")
        ) {
          context.ui.notify(
            `Headlong ${existing.status} is terminal and cannot be restarted.`,
            "warning",
          );
          return;
        }
        if (!existing && action !== "start") {
          context.ui.notify("Headlong has not been started in this workspace.", "warning");
          return;
        }
        if (runtime.pendingTransition && (action === "start" || action === "resume")) {
          context.ui.notify("Headlong is waiting for the aborted turn to settle.", "warning");
          return;
        }
        const initial =
          existing ??
          createInitialActorState({
            workspace: runtime.workspace ?? context.cwd,
            sessionFile: runtime.sessionFile ?? "",
            sessionId: runtime.sessionId ?? "",
            now: now(),
          });
        const terminal = action === "pause" ? "paused" : action === "stop" ? "stopped" : "sleeping";
        const next = {
          ...nextRevision(initial, now()),
          status: terminal,
          wakeAt: terminal === "sleeping" ? new Date(now()).toISOString() : null,
          activeWakeId: null,
          wakeStartedAt: null,
          ...(terminal === "sleeping"
            ? { backoffLevel: 0, ticksAtLevel: 0, consecutiveFailures: 0 }
            : {}),
        } satisfies HeadlongActorState;
        const interruptsTurn =
          (action === "pause" || action === "stop") &&
          Boolean(existing?.activeWakeId || runtime.pendingTransition);
        if (interruptsTurn && existing?.activeWakeId) context.abort();
        await store.writeState(next);
        await store.appendEvent({
          at: next.updatedAt,
          type: `actor.${action}`,
          detail: { sessionId: next.sessionId },
        });
        runtime.activeWakeId = undefined;
        clearWakeDeadline();
        if (interruptsTurn) {
          runtime.pendingTransition = next;
          clearWakeTimer();
        } else {
          runtime.pendingTransition = undefined;
          restoreTools();
          if (terminal === "sleeping") scheduleWake(next);
          else clearWakeTimer();
        }
        context.ui.notify(`Headlong ${action === "start" ? "started" : action}.`, "info");
      }),
  });

  pi.on("input", async (event) => {
    if (
      event.source === "extension" ||
      event.text.trimStart().startsWith("/") ||
      !runtime.store ||
      !runtime.lease ||
      runtime.activeWakeId ||
      runtime.pendingTransition
    ) {
      return { action: "continue" };
    }
    return serializeWakeMutation(async () => {
      const generation = runtime.generation;
      const store = runtime.store;
      const lease = runtime.lease;
      if (!store || !lease) return { action: "continue" as const };
      await lease.assertOwned();
      if (generation !== runtime.generation || runtime.store !== store || runtime.lease !== lease) {
        return { action: "continue" as const };
      }
      const state = await store.readState();
      if (
        generation !== runtime.generation ||
        runtime.store !== store ||
        runtime.lease !== lease ||
        !state ||
        !["running", "sleeping"].includes(state.status) ||
        state.activeWakeId
      ) {
        return { action: "continue" as const };
      }
      const wakeSequence = state.wakeSequence + 1;
      const wakeId = `wake-${wakeSequence}-${randomUUID()}`;
      const startedAt = new Date(now()).toISOString();
      const reset = applyMeaningfulEvent(state);
      await options.beforeWakeStateWrite?.();
      if (generation !== runtime.generation || runtime.store !== store || runtime.lease !== lease) {
        return { action: "continue" as const };
      }
      clearWakeTimer();
      await store.writeState({
        ...nextRevision(reset, now()),
        status: "running",
        wakeAt: null,
        wakeSequence,
        activeWakeId: wakeId,
        wakeStartedAt: startedAt,
      });
      await store.appendEvent({
        at: startedAt,
        type: "wake.dispatched",
        wakeId,
        detail: { source: event.source, trigger: "meaningful-input" },
      });
      if (generation !== runtime.generation || runtime.store !== store || runtime.lease !== lease) {
        const published = await store.readState();
        if (published?.activeWakeId === wakeId) {
          const invalidatedAt = new Date(now()).toISOString();
          await store.writeState({
            ...nextRevision(published, now()),
            status: "paused",
            wakeAt: null,
            activeWakeId: null,
            wakeStartedAt: null,
            consecutiveFailures: published.consecutiveFailures + 1,
          });
          await store.appendEvent({
            at: invalidatedAt,
            type: "wake.dispatch_invalidated",
            wakeId,
            detail: { reason: "session lifecycle changed during input dispatch" },
          });
        }
        return { action: "continue" as const };
      }
      runtime.activeWakeId = wakeId;
      runtime.turnCount = 0;
      restrictUnattendedTools();
      armWakeDeadline(generation, wakeId);
      return { action: "continue" as const };
    });
  });

  pi.on("session_start", async (_event, context) => {
    const generation = runtime.generation + 1;
    runtime.generation = generation;
    clearWakeTimer();
    clearWakeDeadline();
    const workspace = context.cwd;
    const sessionId = context.sessionManager.getSessionId();
    const sessionFile = context.sessionManager.getSessionFile();
    if (!sessionFile) {
      context.ui.notify("Headlong requires a persisted Pi session file.", "error");
      return;
    }
    const store = new HeadlongStore({ stateRoot, workspace });
    const lease = await acquireLease({
      store,
      role: "live-extension",
      adoptToken: options.leaseToken ?? process.env.PI_HEADLONG_LEASE_TOKEN,
    });
    if (generation !== runtime.generation) {
      await lease?.release();
      return;
    }
    if (!lease) {
      context.ui.notify("Headlong actor is owned by another live process.", "warning");
      return;
    }
    runtime.workspace = workspace;
    runtime.context = context;
    runtime.sessionId = sessionId;
    runtime.sessionFile = sessionFile;
    runtime.store = store;
    runtime.lease = lease;
    const state = await store.readState();
    if (generation !== runtime.generation) {
      await lease.release();
      if (runtime.lease === lease) {
        runtime.lease = undefined;
        runtime.store = undefined;
        runtime.context = undefined;
      }
      return;
    }
    if (state && (state.sessionId !== sessionId || state.sessionFile !== resolve(sessionFile))) {
      context.ui.notify(
        "Headlong refused this different Pi session; resume the actor's canonical Pi session instead.",
        "error",
      );
      await lease.release();
      runtime.lease = undefined;
      return;
    }
    if (supervisorWakeId) {
      if (state?.activeWakeId !== supervisorWakeId) {
        context.ui.notify(
          "Headlong supervisor wake ID does not match durable actor state.",
          "error",
        );
        await lease.release();
        runtime.lease = undefined;
        return;
      }
      runtime.activeWakeId = supervisorWakeId;
      runtime.turnCount = 0;
      restrictUnattendedTools();
      armWakeDeadline(generation, supervisorWakeId);
      return;
    }
    if (state && ["running", "sleeping"].includes(state.status) && !state.activeWakeId) {
      scheduleWake(state, generation);
    }
  });

  pi.on("turn_start", async () =>
    serializeWakeMutation(async () => {
      if (!runtime.store || !runtime.lease || !runtime.activeWakeId) return;
      await runtime.lease.assertOwned();
      runtime.turnCount += 1;
      const state = await runtime.store.readState();
      if (!state?.activeWakeId || state.activeWakeId !== runtime.activeWakeId) return;
      const elapsed = state.wakeStartedAt ? now() - Date.parse(state.wakeStartedAt) : 0;
      const maxTurns = options.maxTurnsPerWake ?? 24;
      const maxWakeMs = options.maxWakeMs ?? 30 * 60_000;
      if (runtime.turnCount <= maxTurns && elapsed <= maxWakeMs) return;
      await failClosedActiveWake(state.activeWakeId, "wake.budget_exceeded", {
        turns: runtime.turnCount,
        elapsedMs: elapsed,
        maxTurns,
        maxWakeMs,
      });
    }),
  );

  pi.on("agent_settled", async () =>
    serializeWakeMutation(async () => {
      const pending = runtime.pendingTransition;
      if (pending) {
        runtime.pendingTransition = undefined;
        restoreTools();
        if (pending.status === "sleeping" && !supervisorWakeId) scheduleWake(pending);
        else clearWakeTimer();
        return;
      }
      const wakeId = runtime.activeWakeId;
      if (!wakeId) return;
      await failClosedActiveWake(
        wakeId,
        "wake.missing_transition",
        { action: "paused-fail-closed" },
        true,
      );
    }),
  );

  pi.on("session_shutdown", async () => {
    runtime.generation += 1;
    clearWakeTimer();
    clearWakeDeadline();
    await serializeWakeMutation(async () => {
      restoreTools();
      const lease = runtime.lease;
      await lease?.release();
      if (runtime.lease === lease) {
        runtime.lease = undefined;
        runtime.store = undefined;
        runtime.activeWakeId = undefined;
        runtime.pendingTransition = undefined;
        runtime.context = undefined;
      }
    });
  });
}

export default function headlongExtension(pi: ExtensionAPI): void {
  registerHeadlongExtension(pi);
}
