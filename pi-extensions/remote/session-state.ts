import {
  getSupportedThinkingLevels,
  type Api,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { TranscriptEntry } from "./transcript-projection.js";

export type RemoteModel = { provider: string; id: string; name: string };

export type SessionState = {
  model: RemoteModel | null;
  thinkingLevel: ModelThinkingLevel;
  /** Levels the current model accepts; empty when no model is selected. */
  thinkingLevels: ModelThinkingLevel[];
  /** Models a remote `/model` accepts, mirroring Pi's model cycling set. */
  models: RemoteModel[];
};

export type SessionStateEntry = TranscriptEntry & { sessionState: SessionState };

export type RemoteCommand = { name: "model" | "thinking"; argument: string };

type ModelContext = Pick<ExtensionContext, "model" | "modelRegistry" | "scopedModels">;
type ModelApi = Pick<ExtensionAPI, "getThinkingLevel" | "setModel" | "setThinkingLevel">;

const REMOTE_COMMAND = /^\/(model|thinking)(?:\s+([\s\S]*))?$/;

export function currentSessionState(
  ctx: ModelContext,
  model: Model<Api> | undefined,
  thinkingLevel: ModelThinkingLevel,
): SessionState {
  return {
    model: model ? remoteModel(model) : null,
    thinkingLevel,
    thinkingLevels: model ? getSupportedThinkingLevels(model) : [],
    models: switchableModels(ctx).map(remoteModel),
  };
}

/**
 * Session state rides on an `event` frame shaped like a transcript entry: the daemon
 * forwards only `event` frames, and older clients skip it as an empty system entry.
 */
export function projectSessionState(state: SessionState): SessionStateEntry {
  return {
    role: "system",
    text: "",
    toolName: null,
    status: "session_state",
    truncatedOutput: false,
    sessionState: state,
  };
}

/** A live-only system line; it is not written to the Pi session, so backfill omits it. */
export function projectNotice(text: string): TranscriptEntry {
  return { role: "system", text, toolName: null, status: "notice", truncatedOutput: false };
}

/**
 * Recognizes the Pi built-ins a remote client can run. Pi's TUI handles `/model` itself,
 * so it never reaches extension command dispatch; `/thinking` stands in for the TUI's
 * thinking-level keybinding.
 */
export function parseRemoteCommand(text: string): RemoteCommand | null {
  const match = REMOTE_COMMAND.exec(text.trim());
  if (!match) return null;
  return { name: match[1] === "model" ? "model" : "thinking", argument: (match[2] ?? "").trim() };
}

/** Applies a remote command and returns a notice for the client, or null when the state push says enough. */
export async function runRemoteCommand(
  pi: ModelApi,
  ctx: ModelContext,
  command: RemoteCommand,
): Promise<string | null> {
  return command.name === "model"
    ? runModelCommand(pi, ctx, command.argument)
    : runThinkingCommand(pi, ctx, command.argument);
}

async function runModelCommand(
  pi: ModelApi,
  ctx: ModelContext,
  reference: string,
): Promise<string | null> {
  if (reference.length === 0) {
    return `Model: ${describeModel(ctx.model)}, thinking ${pi.getThinkingLevel()}. Send /model <provider/id> to switch.`;
  }
  const model = findModel(reference, switchableModels(ctx));
  if (!model) {
    return `No available model matches "${reference}".`;
  }
  try {
    return (await pi.setModel(model)) ? null : `No API key for ${describeModel(model)}.`;
  } catch (error) {
    return `Couldn't switch to ${describeModel(model)}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function runThinkingCommand(pi: ModelApi, ctx: ModelContext, level: string): string | null {
  const levels = ctx.model ? getSupportedThinkingLevels(ctx.model) : [];
  const supported = `Supported: ${levels.join(", ") || "none"}.`;
  if (level.length === 0) {
    return `Thinking: ${pi.getThinkingLevel()}. ${supported}`;
  }
  const match = levels.find((candidate) => candidate === level.toLowerCase());
  if (!match) {
    return `${describeModel(ctx.model)} doesn't support thinking level "${level}". ${supported}`;
  }
  pi.setThinkingLevel(match);
  return null;
}

function switchableModels(ctx: ModelContext): Model<Api>[] {
  return ctx.scopedModels.length > 0
    ? ctx.scopedModels.map((scoped) => scoped.model)
    : ctx.modelRegistry.getAvailable();
}

/** Pi's exact `/model <reference>` match: `provider/id`, else a unique bare id, ignoring case. */
function findModel(reference: string, models: readonly Model<Api>[]): Model<Api> | undefined {
  const wanted = reference.toLowerCase();
  const canonical = models.filter(
    (model) => `${model.provider}/${model.id}`.toLowerCase() === wanted,
  );
  if (canonical.length > 0) {
    return canonical.length === 1 ? canonical[0] : undefined;
  }
  const byId = models.filter((model) => model.id.toLowerCase() === wanted);
  return byId.length === 1 ? byId[0] : undefined;
}

function remoteModel(model: Model<Api>): RemoteModel {
  return { provider: model.provider, id: model.id, name: model.name };
}

function describeModel(model: Model<Api> | undefined): string {
  return model ? `${model.provider}/${model.id}` : "no model";
}
