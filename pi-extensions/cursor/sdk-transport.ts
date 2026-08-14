import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  Agent,
  Cursor as CursorNamespace,
  InteractionUpdate,
  SDKAgent,
  TokenUsage,
} from "@cursor/sdk";

import {
  applyCursorUsage,
  createOutput,
  estimateVisibleContextTokens,
  finishBufferedOutput,
  pushError,
  sumTurnUsage,
} from "./output.js";
import { buildSdkMessage, hasCursorHistory } from "./prompt.js";
import { createToolEntry } from "./tool-entry.js";
import type { CursorModelInfo, CursorStream } from "./types.js";

const STATE_DIR = join(homedir(), ".pi", "agent", "cursor-bridge");

type SdkModule = { Agent: typeof Agent; Cursor: typeof CursorNamespace };

export interface SdkTransport {
  load(): Promise<SdkModule | undefined>;
  discoverModels(apiKey: string): Promise<CursorModelInfo[]>;
  stream: CursorStream;
  reset(options: { cwd: string; sessionId?: string }): Promise<void>;
}

export function createSdkTransport(): SdkTransport {
  let sdkModule: SdkModule | undefined;
  let sdkAgent: SDKAgent | undefined;
  let activeSdkStateKey: string | undefined;
  let sdkResumeKeyChecked: string | undefined;
  let sdkResumeKeyToSkip: string | undefined;

  async function load(): Promise<SdkModule | undefined> {
    if (sdkModule) return sdkModule;
    try {
      sdkModule = (await import("@cursor/sdk")) as unknown as SdkModule;
    } catch {
      sdkModule = undefined;
    }
    return sdkModule;
  }

  function sdkStateKey(cwd: string, sessionId?: string): string | undefined {
    return sessionId ? `${cwd}\0${sessionId}` : undefined;
  }

  function sdkStatePath(key: string): string {
    const filename = `${createHash("sha256").update(key).digest("hex")}.json`;
    return join(STATE_DIR, filename);
  }

  async function readPersistedAgentId(key: string): Promise<string | undefined> {
    try {
      const state = JSON.parse(await readFile(sdkStatePath(key), "utf8")) as { agentId?: string };
      return state.agentId;
    } catch {
      return undefined;
    }
  }

  async function persistAgentId(key: string | undefined, agentId: string): Promise<void> {
    if (!key) return;
    await mkdir(STATE_DIR, { recursive: true });
    const path = sdkStatePath(key);
    const temporaryPath = `${path}.${process.pid}.tmp`;
    await writeFile(temporaryPath, JSON.stringify({ agentId }, null, 2));
    await rename(temporaryPath, path);
  }

  async function deletePersistedAgentId(key: string | undefined): Promise<void> {
    if (!key) return;
    await rm(sdkStatePath(key), { force: true });
  }

  async function disposeSdkAgent(): Promise<void> {
    const agent = sdkAgent;
    sdkAgent = undefined;
    activeSdkStateKey = undefined;
    if (agent) {
      try {
        await agent[Symbol.asyncDispose]();
      } catch {
        // Disposal remains best-effort to preserve the current transport behavior.
      }
    }
  }

  async function ensureSdkAgent(
    apiKey: string,
    modelId: string,
    resume: boolean,
    sessionId?: string,
  ): Promise<{ agent: SDKAgent; continued: boolean }> {
    const sdk = await load();
    if (!sdk) {
      throw new Error(
        "@cursor/sdk is not installed. Run `pnpm add @cursor/sdk` in the agent-customization repo",
      );
    }

    const cwd = process.cwd();
    const stateKey = sdkStateKey(cwd, sessionId);
    if (sdkAgent) {
      if (!stateKey || stateKey === activeSdkStateKey) return { agent: sdkAgent, continued: true };
      await disposeSdkAgent();
    }

    const shouldSkipResume = stateKey !== undefined && sdkResumeKeyToSkip === stateKey;
    if (shouldSkipResume) sdkResumeKeyToSkip = undefined;
    if (resume && stateKey && sdkResumeKeyChecked !== stateKey && !shouldSkipResume) {
      sdkResumeKeyChecked = stateKey;
      const persistedId = await readPersistedAgentId(stateKey);
      if (persistedId) {
        try {
          sdkAgent = await sdk.Agent.resume(persistedId, { apiKey });
          activeSdkStateKey = stateKey;
          return { agent: sdkAgent!, continued: true };
        } catch {
          // A stale agent falls through to creation and transcript replay.
        }
      }
    }

    sdkAgent = await sdk.Agent.create({
      apiKey,
      model: { id: modelId },
      local: { cwd },
    });
    activeSdkStateKey = stateKey;
    await persistAgentId(stateKey, sdkAgent!.agentId);
    return { agent: sdkAgent!, continued: false };
  }

  const stream: CursorStream = (model, context, options, onToolActivity) => {
    const eventStream = createAssistantMessageEventStream();

    (async () => {
      const output = createOutput(model);
      const apiKey =
        options?.apiKey && options.apiKey !== "cursor-agent-login"
          ? options.apiKey
          : process.env.CURSOR_API_KEY;
      if (!apiKey) {
        pushError(
          eventStream,
          output,
          new Error("CURSOR_API_KEY is not set; cannot use SDK transport"),
          false,
        );
        return;
      }

      try {
        if (options?.signal?.aborted) {
          throw Object.assign(new Error("Aborted"), { aborted: true });
        }

        const resume = hasCursorHistory(context);
        const { agent, continued } = await ensureSdkAgent(
          apiKey,
          model.id,
          resume,
          options?.sessionId,
        );
        const prompt = buildSdkMessage(context, !continued);
        if (options?.signal?.aborted) {
          if (!continued) {
            const stateKey = activeSdkStateKey;
            await disposeSdkAgent();
            await deletePersistedAgentId(stateKey);
          }
          throw Object.assign(new Error("Aborted"), { aborted: true });
        }

        let textIndex = -1;
        let textOpen = false;
        let thinkingIndex = -1;
        let thinkingOpen = false;
        const turnUsages: TokenUsage[] = [];

        const closeText = () => {
          textOpen = false;
        };
        const closeThinking = () => {
          thinkingOpen = false;
        };
        const openText = () => {
          if (textOpen) return;
          closeThinking();
          output.content.push({ type: "text", text: "" });
          textIndex = output.content.length - 1;
          textOpen = true;
        };
        const openThinking = () => {
          if (thinkingOpen) return;
          closeText();
          output.content.push({ type: "thinking", thinking: "" });
          thinkingIndex = output.content.length - 1;
          thinkingOpen = true;
        };

        const run = await agent.send(prompt, {
          model: { id: model.id },
          onDelta: ({ update }: { update: InteractionUpdate }) => {
            switch (update.type) {
              case "text-delta": {
                openText();
                const block = output.content[textIndex] as { type: "text"; text: string };
                block.text += update.text;
                break;
              }
              case "thinking-delta": {
                openThinking();
                const block = output.content[thinkingIndex] as {
                  type: "thinking";
                  thinking: string;
                };
                block.thinking += update.text;
                break;
              }
              case "thinking-completed":
                closeThinking();
                break;
              case "tool-call-started":
                closeText();
                closeThinking();
                break;
              case "tool-call-completed":
                onToolActivity(createToolEntry(update.toolCall));
                break;
              case "turn-ended":
                if (update.usage) {
                  const usage = {
                    ...update.usage,
                    totalTokens:
                      update.usage.inputTokens +
                      update.usage.outputTokens +
                      update.usage.cacheReadTokens +
                      update.usage.cacheWriteTokens,
                  };
                  turnUsages.push(usage);
                }
                break;
            }
          },
        });

        const onAbort = () => {
          if (run.supports("cancel")) void run.cancel();
        };
        if (options?.signal?.aborted) onAbort();
        else options?.signal?.addEventListener("abort", onAbort, { once: true });

        let result: Awaited<ReturnType<typeof run.wait>>;
        try {
          result = await run.wait();
        } finally {
          options?.signal?.removeEventListener("abort", onAbort);
        }

        if (result.status === "cancelled" || options?.signal?.aborted) {
          throw Object.assign(new Error("Aborted"), { aborted: true });
        }
        if (result.status === "error") {
          throw new Error(result.error?.message ?? "cursor agent run failed");
        }

        closeThinking();
        closeText();

        const currentUsage = sumTurnUsage(turnUsages);
        if (currentUsage) applyCursorUsage(output, currentUsage);
        else if (result.usage) applyCursorUsage(output, result.usage);
        if (currentUsage || result.usage) {
          output.usage.totalTokens = estimateVisibleContextTokens(context, output);
        }

        output.stopReason = "stop";
        output.errorMessage = undefined;
        finishBufferedOutput(eventStream, output);
      } catch (error) {
        const aborted =
          options?.signal?.aborted || (error as { aborted?: boolean })?.aborted === true;
        pushError(eventStream, output, error, aborted);
      }
    })();

    return eventStream;
  };

  return {
    load,
    discoverModels: async (apiKey) => {
      const sdk = await load();
      if (!sdk) return [];
      const models = await sdk.Cursor.models.list({ apiKey });
      return models.map((model) => ({
        id: model.id,
        name: (model as { displayName?: string }).displayName ?? model.id,
      }));
    },
    stream,
    reset: async ({ cwd, sessionId }) => {
      const stateKey = sdkStateKey(cwd, sessionId);
      await disposeSdkAgent();
      await deletePersistedAgentId(stateKey);
      sdkResumeKeyToSkip = stateKey;
    },
  };
}
