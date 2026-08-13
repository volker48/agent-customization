/**
 * Sound Notifications Plugin for OpenCode
 *
 * Plays a random sound file from ~/Documents/sounds/<event_name>/
 * whenever the matching OpenCode event fires.
 *
 * To add a new sound event:
 *   1. Create a folder in ~/Documents/sounds/ named after the event
 *   2. Drop .mp3, .aiff, .wav, or .m4a files into it
 *   3. Reload the plugin
 *
 * Available event names to use as folder names:
 *
 *   Session events:
 *     session.created      - Session is created
 *     session.compacted    - Session compaction completes
 *     session.idle         - Session becomes idle (agent finishes)
 *     session.error        - Session encounters an error
 *
 *   Tool events:
 *     tool.execute.before  - Before a tool executes
 *     tool.execute.after   - After a tool executes
 *
 *   TUI events:
 *     tui.prompt.append    - User submits input
 *     tui.command.execute  - User runs a command
 *     tui.toast.show       - Toast notification shown
 *
 *   File events:
 *     file.edited          - File is edited
 *     file.watcher.updated - File watcher detects change
 *
 *   Message events:
 *     message.updated      - Message is updated
 *     message.part.updated - Message part is updated
 *     message.part.removed - Message part is removed
 *     message.removed      - Message is removed
 *
 *   Other events:
 *     command.executed     - Command is executed
 *     permission.asked     - Permission is requested
 *     permission.replied   - Permission is replied to
 *     todo.updated         - Todo list is updated
 *     server.connected     - Server connection established
 *     lsp.updated          - LSP update
 *     lsp.client.diagnostics - LSP diagnostics received
 *     shell.env            - Shell environment updated
 *     installation.updated - Installation updated
 *
 * Debug mode: Set SOUND_DEBUG=1 to see logs
 * Cooldown: Set SOUND_MIN_INTERVAL_MS (default: 250)
 */

import type { Plugin } from "@opencode-ai/plugin";
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEBUG = process.env.SOUND_DEBUG === "1";
const SOUNDS_DIR = join(process.env.HOME || homedir(), "Documents", "sounds");
const AUDIO_FILE_REGEX = /\.(mp3|aiff|wav|m4a)$/i;
const DEFAULT_MIN_INTERVAL_MS = 250;

const parsedMinInterval = Number(process.env.SOUND_MIN_INTERVAL_MS ?? DEFAULT_MIN_INTERVAL_MS);
const MIN_INTERVAL_MS =
  Number.isFinite(parsedMinInterval) && parsedMinInterval >= 0
    ? parsedMinInterval
    : DEFAULT_MIN_INTERVAL_MS;

let lastPlayedAt = 0;

// Supported event names (folder names in ~/Documents/sounds/)
const SUPPORTED_EVENTS = [
  // Session events
  "session.created",
  "session.compacted",
  "session.idle",
  "session.error",
  // Tool events
  "tool.execute.before",
  "tool.execute.after",
  // TUI events
  "tui.prompt.append",
  "tui.command.execute",
  "tui.toast.show",
  // File events
  "file.edited",
  "file.watcher.updated",
  // Message events
  "message.updated",
  "message.part.updated",
  "message.part.removed",
  "message.removed",
  // Other events
  "command.executed",
  "permission.asked",
  "permission.replied",
  "todo.updated",
  "server.connected",
  "lsp.updated",
  "lsp.client.diagnostics",
  "shell.env",
  "installation.updated",
] as const;

type EventName = (typeof SUPPORTED_EVENTS)[number];

function getSoundFiles(eventName: EventName): string[] {
  try {
    const dir = join(SOUNDS_DIR, eventName);
    return readdirSync(dir)
      .filter((fileName) => AUDIO_FILE_REGEX.test(fileName))
      .map((fileName) => join(dir, fileName));
  } catch {
    return [];
  }
}

function playRandomSound(eventName: EventName): void {
  const now = Date.now();
  const elapsed = now - lastPlayedAt;

  if (elapsed < MIN_INTERVAL_MS) {
    if (DEBUG) {
      console.error(
        `[sound-notify] Cooldown active (${elapsed}ms < ${MIN_INTERVAL_MS}ms). Skipping: ${eventName}`,
      );
    }
    return;
  }

  const files = getSoundFiles(eventName);
  if (files.length === 0) {
    if (DEBUG) console.error(`[sound-notify] No files found for event: ${eventName}`);
    return;
  }

  const file = files[Math.floor(Math.random() * files.length)];
  if (DEBUG) console.error(`[sound-notify] Playing ${eventName}: ${file}`);

  lastPlayedAt = now;

  const child = spawn("afplay", [file], {
    stdio: "ignore",
    detached: true,
  });

  child.on("error", (err) => {
    if (DEBUG) console.error(`[sound-notify] Error spawning afplay: ${err}`);
  });

  child.unref();

  if (DEBUG) {
    console.error(`[sound-notify] Sound spawned (PID: ${child.pid ?? "unknown"})`);
  }
}

export const SoundNotifications: Plugin = async ({ client: _client }) => {
  const eventFileMap = new Map<EventName, string[]>();

  for (const event of SUPPORTED_EVENTS) {
    eventFileMap.set(event, getSoundFiles(event));
  }

  if (DEBUG) {
    console.error(`[sound-notify] Plugin loaded. SOUNDS_DIR: ${SOUNDS_DIR}`);
    console.error(`[sound-notify] Cooldown: ${MIN_INTERVAL_MS}ms`);
    console.error("[sound-notify] Checking for sound files...");
    for (const event of SUPPORTED_EVENTS) {
      console.error(`[sound-notify]   ${event}: ${eventFileMap.get(event)?.length ?? 0} files`);
    }
  }

  // Build hooks object with only events that have sound files
  const hooks: Record<string, () => void> = {};

  for (const event of SUPPORTED_EVENTS) {
    if ((eventFileMap.get(event)?.length ?? 0) > 0) {
      hooks[event] = () => {
        if (DEBUG) console.error(`[sound-notify] Event triggered: ${event}`);
        playRandomSound(event);
      };
    }
  }

  return hooks;
};
