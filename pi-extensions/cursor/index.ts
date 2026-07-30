/**
 * Cursor bridge: use the models available in your Cursor subscription as a pi provider.
 *
 * Architecture: "agent-as-model". Cursor exposes no raw model-inference
 * API, so each pi model call drives a Cursor agent run and streams its events back
 * as pi assistant events. The Cursor agent does file/shell work with its own
 * harness; pi renders the transcript.
 *
 * Transports (billing is identical — both draw from your plan's usage pools):
 *   1. SDK (primary)  - @cursor/sdk with CURSOR_API_KEY. Adds thinking deltas and
 *                       per-run token usage. Persists the Cursor agent ID to disk,
 *                       so conversations resume across pi restarts.
 *   2. CLI (fallback) - spawns `cursor-agent` in print mode, authenticated by your
 *                       existing browser login (`cursor-agent login`). Used when
 *                       CURSOR_API_KEY is unset or the SDK is not installed.
 *
 * Commands:
 *   /cursor-status  - which transport is active + auth check
 *   /cursor-reset   - drop the Cursor conversation for this session (start fresh)
 *
 * Env:
 *   CURSOR_API_KEY        - user API key (Dashboard -> API Keys). Enables SDK transport.
 *   PI_CURSOR_TRANSPORT   - "sdk" or "cli" to force a transport
 *   CURSOR_AGENT_BIN      - CLI binary name/path override (default: cursor-agent)
 *   PI_CURSOR_NO_FORCE=1  - CLI only: do not pass --force
 */

import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { Agent, Cursor as CursorNamespace, InteractionUpdate, SDKAgent } from "@cursor/sdk";

const execFileAsync = promisify(execFile);

const CLI = process.env.CURSOR_AGENT_BIN ?? "cursor-agent";
const PROVIDER = "cursor";
const STATE_DIR = join(homedir(), ".pi", "agent", "cursor-bridge");

type SdkModule = { Agent: typeof Agent; Cursor: typeof CursorNamespace };

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface CursorModelInfo {
  id: string;
  name: string;
}

const FALLBACK_MODELS: CursorModelInfo[] = [
  { id: "auto", name: "Cursor Auto" },
  { id: "composer-2.5", name: "Composer 2.5" },
  { id: "composer-2", name: "Composer 2" },
];

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as Array<{ type?: string; text?: string }>) {
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block?.type === "image") parts.push("[image omitted: cursor bridge is text-only]");
  }
  return parts.join("\n");
}

function buildPrompt(context: Context, isFirstTurn: boolean): string {
  const messages = context.messages ?? [];
  const lastUserIndex =
    messages
      .map((m, i) => ({ m, i }))
      .filter(({ m }) => m.role === "user")
      .pop()?.i ?? -1;
  const lastUserText =
    lastUserIndex >= 0
      ? extractText((messages[lastUserIndex] as { content?: unknown }).content)
      : "";

  if (!isFirstTurn) return lastUserText;

  const prompt: string[] = [];
  if (context.systemPrompt) {
    prompt.push("System instructions from Pi:", context.systemPrompt, "");
  }

  if (lastUserIndex > 0) {
    // First cursor turn in a pi session that already has history (e.g. model switch
    // mid-session or transcript replay after restart): ship the transcript.
    prompt.push("This conversation continues from another agent. Transcript so far:", "");
    for (const msg of messages.slice(0, lastUserIndex)) {
      const text = extractText((msg as { content?: unknown }).content);
      if (!text) continue;
      const label =
        msg.role === "user" ? "User" : msg.role === "assistant" ? "Assistant" : "Tool result";
      prompt.push(
        `${label}: ${text.length > 4000 ? text.slice(0, 4000) + "\n...[truncated]" : text}`,
      );
    }
    prompt.push("");
  }

  if (prompt.length === 0) return lastUserText;
  prompt.push(`User: ${lastUserText}`);
  return prompt.join("\n");
}

function summarizeToolCall(toolCall: unknown): string {
  if (!toolCall || typeof toolCall !== "object") return "tool";
  const call = toolCall as Record<string, unknown>;
  // SDK shape: { type: "read" | "shell" | ..., args: {...} } (mcp nests args.args)
  if (typeof call.type === "string" && call.args && typeof call.args === "object") {
    const args = call.args as Record<string, unknown>;
    const inner = (args.args ?? {}) as Record<string, unknown>;
    const target =
      args.path ??
      args.command ??
      args.pattern ??
      args.query ??
      args.globPattern ??
      args.toolName ??
      inner.path ??
      inner.command ??
      "";
    return target ? `${call.type}: ${String(target)}` : call.type;
  }
  // CLI stream-json shape: { readToolCall: { args: {...} } }
  const [kind, payload] = Object.entries(call)[0] ?? ["tool", {}];
  const args = ((payload as { args?: Record<string, unknown> })?.args ?? {}) as Record<
    string,
    unknown
  >;
  const name = kind.replace(/ToolCall$/, "");
  const target = args.path ?? args.command ?? args.pattern ?? args.query ?? "";
  return target ? `${name}: ${String(target)}` : name;
}

function hasCursorHistory(context: Context): boolean {
  return (context.messages ?? []).some(
    (message) =>
      message.role === "assistant" && (message as AssistantMessage).provider === PROVIDER,
  );
}

function createOutput(model: Model<never>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function pushError(
  stream: AssistantMessageEventStream,
  output: AssistantMessage,
  error: unknown,
  aborted: boolean,
) {
  output.stopReason = aborted ? "aborted" : "error";
  output.errorMessage = error instanceof Error ? error.message : String(error);
  stream.push({ type: "error", reason: output.stopReason, error: output });
  stream.end();
}

// ---------------------------------------------------------------------------
// SDK transport (primary)
// ---------------------------------------------------------------------------

let sdkModule: SdkModule | undefined;
let sdkAgent: SDKAgent | undefined;
let activeSdkStateKey: string | undefined;
let sdkResumeKeyChecked: string | undefined;
let sdkResumeKeyToSkip: string | undefined;

async function loadSdk(): Promise<SdkModule | undefined> {
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
      // disposal is best-effort
    }
  }
}

interface EnsuredSdkAgent {
  agent: SDKAgent;
  continued: boolean;
}

async function ensureSdkAgent(
  apiKey: string,
  modelId: string,
  resume: boolean,
  sessionId?: string,
): Promise<EnsuredSdkAgent> {
  const sdk = await loadSdk();
  if (!sdk)
    throw new Error(
      "@cursor/sdk is not installed. Run `pnpm add @cursor/sdk` in the agent-customization repo",
    );

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
        // stale or gone; fall through to a fresh agent and replay the transcript
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

function streamSdk(
  model: Model<never>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const output = createOutput(model);
    const apiKey =
      options?.apiKey && options.apiKey !== "cursor-agent-login"
        ? options.apiKey
        : process.env.CURSOR_API_KEY;
    if (!apiKey) {
      pushError(
        stream,
        output,
        new Error("CURSOR_API_KEY is not set; cannot use SDK transport"),
        false,
      );
      return;
    }

    try {
      stream.push({ type: "start", partial: output });
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
      const prompt = buildPrompt(context, !continued);
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

      const openText = () => {
        if (textOpen) return;
        output.content.push({ type: "text", text: "" });
        textIndex = output.content.length - 1;
        stream.push({ type: "text_start", contentIndex: textIndex, partial: output });
        textOpen = true;
      };
      const openThinking = () => {
        if (thinkingOpen) return;
        output.content.push({ type: "thinking", thinking: "" });
        thinkingIndex = output.content.length - 1;
        stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
        thinkingOpen = true;
      };
      const closeThinking = () => {
        if (!thinkingOpen) return;
        const block = output.content[thinkingIndex] as { type: "thinking"; thinking: string };
        stream.push({
          type: "thinking_end",
          contentIndex: thinkingIndex,
          content: block.thinking,
          partial: output,
        });
        thinkingOpen = false;
      };

      const run = await agent.send(prompt, {
        model: { id: model.id },
        onDelta: ({ update }: { update: InteractionUpdate }) => {
          switch (update.type) {
            case "text-delta": {
              closeThinking();
              openText();
              const block = output.content[textIndex] as { type: "text"; text: string };
              block.text += update.text;
              stream.push({
                type: "text_delta",
                contentIndex: textIndex,
                delta: update.text,
                partial: output,
              });
              break;
            }
            case "thinking-delta": {
              openThinking();
              const block = output.content[thinkingIndex] as { type: "thinking"; thinking: string };
              block.thinking += update.text;
              stream.push({
                type: "thinking_delta",
                contentIndex: thinkingIndex,
                delta: update.text,
                partial: output,
              });
              break;
            }
            case "thinking-completed":
              closeThinking();
              break;
            case "tool-call-started": {
              closeThinking();
              openText();
              const marker = `\n\n> tool ${summarizeToolCall(update.toolCall)}\n\n`;
              const block = output.content[textIndex] as { type: "text"; text: string };
              block.text += marker;
              stream.push({
                type: "text_delta",
                contentIndex: textIndex,
                delta: marker,
                partial: output,
              });
              break;
            }
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
      if (textOpen) {
        const block = output.content[textIndex] as { type: "text"; text: string };
        stream.push({
          type: "text_end",
          contentIndex: textIndex,
          content: block.text,
          partial: output,
        });
      }

      if (result.usage) {
        output.usage.input = result.usage.inputTokens;
        output.usage.output = result.usage.outputTokens;
        output.usage.cacheRead = result.usage.cacheReadTokens;
        output.usage.cacheWrite = result.usage.cacheWriteTokens;
        output.usage.totalTokens = result.usage.totalTokens;
      }

      output.stopReason = "stop";
      output.errorMessage = undefined;
      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      const aborted =
        options?.signal?.aborted || (error as { aborted?: boolean })?.aborted === true;
      pushError(stream, output, error, aborted);
    }
  })();

  return stream;
}

async function discoverSdkModels(apiKey: string): Promise<CursorModelInfo[]> {
  const sdk = await loadSdk();
  if (!sdk) return [];
  const models = await sdk.Cursor.models.list({ apiKey });
  return models.map((m) => ({
    id: m.id,
    name: (m as { displayName?: string }).displayName ?? m.id,
  }));
}

// ---------------------------------------------------------------------------
// CLI transport (fallback)
// ---------------------------------------------------------------------------

let activeCursorChatId: string | undefined;

async function discoverCliModels(): Promise<CursorModelInfo[]> {
  try {
    const { stdout } = await execFileAsync(CLI, ["models"], { timeout: 15000 });
    const ids: CursorModelInfo[] = [];
    for (const rawLine of stdout.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      const token = line.split(/\s+/)[0].replace(/^[*>-]+\s*/, "");
      if (/^[a-z0-9][a-z0-9.\-_/]*$/i.test(token) && /[a-z]/i.test(token)) {
        ids.push({ id: token, name: token });
      }
    }
    return ids;
  } catch {
    return [];
  }
}

function streamCli(
  model: Model<never>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const output = createOutput(model);
    stream.push({ type: "start", partial: output });
    if (options?.signal?.aborted) {
      pushError(stream, output, new Error("Aborted"), true);
      return;
    }

    const resume = hasCursorHistory(context) ? activeCursorChatId : undefined;
    const prompt = buildPrompt(context, !resume);

    const args = [
      "--print",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      "--model",
      model.id,
      "--workspace",
      process.cwd(),
      "--trust",
    ];
    if (process.env.PI_CURSOR_NO_FORCE !== "1") args.push("--force");
    if (resume) args.push("--resume", resume);
    args.push(prompt);

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(CLI, args, {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      pushError(stream, output, error, false);
      return;
    }

    const onAbort = () => child.kill("SIGTERM");
    if (options?.signal?.aborted) onAbort();
    else options?.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      output.content.push({ type: "text", text: "" });
      const contentIndex = 0;
      let textOpen = false;
      let buffer = "";
      let stderrText = "";
      let sawResult = false;

      const pushDelta = (delta: string) => {
        if (!delta) return;
        if (!textOpen) {
          stream.push({ type: "text_start", contentIndex, partial: output });
          textOpen = true;
        }
        const block = output.content[contentIndex] as { type: "text"; text: string };
        block.text += delta;
        stream.push({ type: "text_delta", contentIndex, delta, partial: output });
      };

      child.stderr!.on("data", (chunk: Buffer) => {
        stderrText += chunk.toString();
      });

      const exitPromise = new Promise<number | null>((resolve) => child.on("close", resolve));

      await new Promise<void>((resolve, reject) => {
        child.on("error", reject);
        child.stdout!.on("data", (chunk: Buffer) => {
          buffer += chunk.toString();
          let newlineIndex: number;
          while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);
            if (!line) continue;

            let event: Record<string, never>;
            try {
              event = JSON.parse(line);
            } catch {
              continue;
            }

            switch (event.type) {
              case "system":
                if (event.subtype === "init" && typeof event.session_id === "string") {
                  activeCursorChatId = event.session_id;
                }
                break;

              case "assistant": {
                // Only streaming deltas carry new text: timestamp_ms present AND
                // model_call_id absent. Others are duplicate flushes.
                const isDelta =
                  typeof event.timestamp_ms === "number" && event.model_call_id === undefined;
                if (!isDelta) break;
                const content =
                  (event.message as { content?: Array<{ type?: string; text?: string }> })
                    ?.content ?? [];
                for (const block of content) {
                  if (block?.type === "text" && block.text) pushDelta(block.text);
                }
                break;
              }

              case "tool_call":
                if (event.subtype === "started") {
                  pushDelta(`\n\n> tool ${summarizeToolCall(event.tool_call)}\n\n`);
                }
                break;

              case "result": {
                sawResult = true;
                if (event.is_error) {
                  const message =
                    typeof event.result === "string" && event.result
                      ? event.result
                      : stderrText.trim() || "cursor-agent reported an error";
                  reject(new Error(message));
                  return;
                }
                break;
              }
            }
          }
        });
        child.stdout!.on("end", () => resolve());
      });

      const exitCode = await exitPromise;

      if (options?.signal?.aborted) {
        throw Object.assign(new Error("Aborted"), { aborted: true });
      }
      if (!sawResult || (exitCode !== 0 && exitCode !== null)) {
        const detail = stderrText.trim();
        throw new Error(
          `cursor-agent exited with code ${exitCode ?? "unknown"}${detail ? `: ${detail}` : ""}. ` +
            `Check auth with 'cursor-agent status' (or run /cursor-status).`,
        );
      }

      if (textOpen) {
        const block = output.content[contentIndex] as { type: "text"; text: string };
        stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
      } else {
        output.content.pop();
      }

      output.stopReason = "stop";
      output.errorMessage = undefined;
      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      pushError(stream, output, error, options?.signal?.aborted ?? false);
    } finally {
      options?.signal?.removeEventListener("abort", onAbort);
    }
  })();

  return stream;
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI) {
  const apiKey = process.env.CURSOR_API_KEY;
  const forced = process.env.PI_CURSOR_TRANSPORT;
  const sdk = apiKey ? await loadSdk() : undefined;
  const transport: "sdk" | "cli" =
    forced === "sdk" || forced === "cli" ? forced : sdk ? "sdk" : "cli";

  let models: CursorModelInfo[] = [];
  if (transport === "sdk" && apiKey) {
    try {
      models = await discoverSdkModels(apiKey);
    } catch {
      models = [];
    }
  }
  if (models.length === 0) {
    models = await discoverCliModels();
  }
  if (models.length === 0) {
    models = FALLBACK_MODELS;
  }

  pi.registerProvider(PROVIDER, {
    name: "Cursor (subscription)",
    baseUrl: transport === "sdk" ? "cursor-sdk://local" : "cursor-agent://local",
    apiKey: transport === "sdk" ? "$CURSOR_API_KEY" : "cursor-agent-login",
    api: "cursor-bridge" as never,
    models: models.map((m) => ({
      id: m.id,
      name: m.name,
      reasoning: false,
      input: ["text"] as Array<"text">,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8192,
    })),
    streamSimple: (transport === "sdk" ? streamSdk : streamCli) as never,
  });

  pi.registerCommand("cursor-status", {
    description: "Show cursor bridge transport and authentication status",
    handler: async (_args, ctx) => {
      const lines = [`transport: ${transport}${forced ? ` (forced via PI_CURSOR_TRANSPORT)` : ""}`];
      if (transport === "sdk") {
        lines.push(apiKey ? "CURSOR_API_KEY: set" : "CURSOR_API_KEY: NOT SET");
      }
      const result = await pi.exec(CLI, ["status"], { timeout: 10000 });
      const cliText = (result.stdout || result.stderr || "").trim();
      if (cliText) lines.push(`cli: ${cliText}`);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("cursor-reset", {
    description: "Drop the Cursor conversation for this session (next message starts fresh)",
    handler: async (_args, ctx) => {
      activeCursorChatId = undefined;
      const stateKey = sdkStateKey(ctx.cwd, ctx.sessionManager.getSessionId());
      await disposeSdkAgent();
      await deletePersistedAgentId(stateKey);
      sdkResumeKeyToSkip = stateKey;
      ctx.ui.notify(
        "Cursor conversation state cleared. Next message starts a fresh Cursor conversation.",
        "info",
      );
    },
  });
}
