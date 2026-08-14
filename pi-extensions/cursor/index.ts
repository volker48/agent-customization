/**
 * Cursor bridge: use the models available in your Cursor subscription as a pi provider.
 *
 * Architecture: "agent-as-model". Cursor exposes no raw model-inference
 * API, so each pi model call drives a Cursor agent run. The Cursor agent does
 * file/shell work with its own harness; pi records completed tools as transcript
 * cards, then emits the buffered assistant output so the answer follows the work.
 *
 * Transports (billing is identical — both draw from your plan's usage pools):
 *   1. SDK (primary)  - @cursor/sdk with CURSOR_API_KEY. Adds thinking content,
 *                       images, and current-turn token usage. Persists the Cursor
 *                       agent ID to disk, so conversations resume across pi restarts.
 *   2. CLI (fallback) - spawns `cursor-agent` in print mode, authenticated by your
 *                       existing browser login (`cursor-agent login`). Text-only;
 *                       used when CURSOR_API_KEY is unset or the SDK is not installed.
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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";

import { createCliTransport } from "./cli-transport.js";
import { createSdkTransport } from "./sdk-transport.js";
import { renderCursorToolEntry, TOOL_ENTRY_TYPE } from "./tool-entry.js";
import type { CursorModelInfo, CursorToolEntry, ToolActivitySink } from "./types.js";

const CLI = process.env.CURSOR_AGENT_BIN ?? "cursor-agent";
const PROVIDER = "cursor";
const sdkTransport = createSdkTransport();
const cliTransport = createCliTransport(CLI);

const FALLBACK_MODELS: CursorModelInfo[] = [
  { id: "auto", name: "Cursor Auto" },
  { id: "composer-2.5", name: "Composer 2.5" },
  { id: "composer-2", name: "Composer 2" },
];

export default async function (pi: ExtensionAPI) {
  const apiKey = process.env.CURSOR_API_KEY;
  const forced = process.env.PI_CURSOR_TRANSPORT;
  const sdk = apiKey ? await sdkTransport.load() : undefined;
  const transport: "sdk" | "cli" =
    forced === "sdk" || forced === "cli" ? forced : sdk ? "sdk" : "cli";

  let models: CursorModelInfo[] = [];
  if (transport === "sdk" && apiKey) {
    try {
      models = await sdkTransport.discoverModels(apiKey);
    } catch {
      models = [];
    }
  }
  if (models.length === 0) models = await cliTransport.discoverModels();
  if (models.length === 0) models = FALLBACK_MODELS;

  pi.registerEntryRenderer<CursorToolEntry>(TOOL_ENTRY_TYPE, renderCursorToolEntry);

  const onToolActivity: ToolActivitySink = (entry) => {
    pi.appendEntry(TOOL_ENTRY_TYPE, entry);
  };
  const stream = transport === "sdk" ? sdkTransport.stream : cliTransport.stream;

  pi.registerProvider(PROVIDER, {
    name: "Cursor (subscription)",
    baseUrl: transport === "sdk" ? "cursor-sdk://local" : "cursor-agent://local",
    apiKey: transport === "sdk" ? "$CURSOR_API_KEY" : "cursor-agent-login",
    api: "cursor-bridge" as never,
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: "auto",
        low: "auto",
        medium: "auto",
        high: "auto",
        xhigh: null,
        max: null,
      },
      input: (transport === "sdk" ? ["text", "image"] : ["text"]) as Array<"text" | "image">,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8192,
    })),
    streamSimple: ((model: Model<never>, context: Context, options?: SimpleStreamOptions) =>
      stream(model, context, options, onToolActivity)) as never,
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
      cliTransport.reset();
      await sdkTransport.reset({
        cwd: ctx.cwd,
        sessionId: ctx.sessionManager.getSessionId(),
      });
      ctx.ui.notify(
        "Cursor conversation state cleared. Next message starts a fresh Cursor conversation.",
        "info",
      );
    },
  });
}
