/**
 * Sound Notifications Extension for macOS
 *
 * Plays a random sound file from ~/Documents/sounds/<event_name>/
 * whenever the matching Pi agent event fires.
 *
 * To add a new sound event:
 *   1. Create a folder in ~/Documents/sounds/ named after the event
 *   2. Drop .mp3, .aiff, .wav, or .m4a files into it
 *   3. Reload the extension (/reload)
 *
 * Available event names to use as folder names:
 *
 *   Session events:
 *     session_start        - Session loads
 *     session_shutdown     - Exiting pi (Ctrl+C, Ctrl+D)
 *     session_switch       - Switching or resuming a session
 *     session_fork         - Forking a session
 *     session_compact      - Compaction completes
 *     session_tree         - Tree navigation completes
 *
 *   Agent events:
 *     agent_start          - Agent begins processing a prompt
 *     agent_end            - Agent finishes processing
 *     turn_start           - Each LLM turn begins
 *     turn_end             - Each LLM turn ends
 *
 *   Tool events:
 *     tool_call            - Before a tool executes
 *     tool_result          - After a tool executes
 *
 *   Other events:
 *     model_select         - Model changes
 *     input                - User submits input
 *     user_bash            - User runs ! or !! command
 *
 * Debug mode: Set SOUND_DEBUG=1 to see logs
 * Cooldown: Set SOUND_MIN_INTERVAL_MS (default: 250)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
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

const SUPPORTED_EVENTS = [
  "session_start",
  "session_shutdown",
  "session_switch",
  "session_fork",
  "session_compact",
  "session_tree",
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "tool_call",
  "tool_result",
  "model_select",
  "input",
  "user_bash",
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

function registerEventHandler(pi: ExtensionAPI, event: EventName, handler: () => void): void {
  switch (event) {
    case "session_start":
      pi.on("session_start", handler);
      break;
    case "session_shutdown":
      pi.on("session_shutdown", handler);
      break;
    case "session_switch":
      pi.on("session_switch", handler);
      break;
    case "session_fork":
      pi.on("session_fork", handler);
      break;
    case "session_compact":
      pi.on("session_compact", handler);
      break;
    case "session_tree":
      pi.on("session_tree", handler);
      break;
    case "agent_start":
      pi.on("agent_start", handler);
      break;
    case "agent_end":
      pi.on("agent_end", handler);
      break;
    case "turn_start":
      pi.on("turn_start", handler);
      break;
    case "turn_end":
      pi.on("turn_end", handler);
      break;
    case "tool_call":
      pi.on("tool_call", handler);
      break;
    case "tool_result":
      pi.on("tool_result", handler);
      break;
    case "model_select":
      pi.on("model_select", handler);
      break;
    case "input":
      pi.on("input", handler);
      break;
    case "user_bash":
      pi.on("user_bash", handler);
      break;
  }
}

export default function (pi: ExtensionAPI) {
  const eventFileMap = new Map<EventName, string[]>();

  for (const event of SUPPORTED_EVENTS) {
    eventFileMap.set(event, getSoundFiles(event));
  }

  if (DEBUG) {
    console.error(`[sound-notify] Extension loaded. SOUNDS_DIR: ${SOUNDS_DIR}`);
    console.error(`[sound-notify] Cooldown: ${MIN_INTERVAL_MS}ms`);
    console.error("[sound-notify] Checking for sound files...");
    for (const event of SUPPORTED_EVENTS) {
      console.error(`[sound-notify]   ${event}: ${eventFileMap.get(event)?.length ?? 0} files`);
    }
  }

  for (const event of SUPPORTED_EVENTS) {
    if ((eventFileMap.get(event)?.length ?? 0) > 0) {
      registerEventHandler(pi, event, () => {
        if (DEBUG) console.error(`[sound-notify] Event triggered: ${event}`);
        playRandomSound(event);
      });
    }
  }
}
