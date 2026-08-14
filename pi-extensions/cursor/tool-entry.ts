import type { EntryRenderer } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

import type { CursorToolEntry } from "./types.js";

export const TOOL_ENTRY_TYPE = "cursor-tool";

function summarizeToolCall(toolCall: unknown): string {
  if (!toolCall || typeof toolCall !== "object") return "tool";
  const call = toolCall as Record<string, unknown>;
  // SDK shape: { type: "read" | "shell" | ..., args: {...} } (MCP nests args.args).
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

  // CLI stream-JSON shape: { readToolCall: { args: {...} } }.
  const [kind, payload] = Object.entries(call)[0] ?? ["tool", {}];
  const args = ((payload as { args?: Record<string, unknown> })?.args ?? {}) as Record<
    string,
    unknown
  >;
  const name = kind.replace(/ToolCall$/, "");
  const target = args.path ?? args.command ?? args.pattern ?? args.query ?? "";
  return target ? `${name}: ${String(target)}` : name;
}

function containsErrorStatus(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== "object" || depth > 5) return false;
  const record = value as Record<string, unknown>;
  if (record.status === "error") return true;
  return Object.values(record).some((item) => containsErrorStatus(item, depth + 1));
}

function collectPreviewText(value: unknown, depth = 0): string[] {
  if (!value || typeof value !== "object" || depth > 5) return [];
  const lines: string[] = [];
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (
      typeof item === "string" &&
      ["stdout", "stderr", "content", "text", "message", "path"].includes(key) &&
      item.trim()
    ) {
      lines.push(item.trim());
    } else if (typeof item === "object") {
      lines.push(...collectPreviewText(item, depth + 1));
    }
  }
  return lines;
}

export function createToolEntry(toolCall: unknown): CursorToolEntry {
  const details = JSON.stringify(toolCall, null, 2) ?? String(toolCall);
  const previewText = collectPreviewText(toolCall).join("\n");
  const preview = (previewText || details).slice(0, 1200);
  return {
    summary: summarizeToolCall(toolCall),
    status: containsErrorStatus(toolCall) ? "error" : "success",
    preview:
      preview.length < (previewText || details).length ? `${preview}\n...[truncated]` : preview,
    details: details.length > 8000 ? `${details.slice(0, 8000)}\n...[truncated]` : details,
  };
}

export const renderCursorToolEntry: EntryRenderer<CursorToolEntry> = (
  entry,
  { expanded },
  theme,
) => {
  const icon = entry.data.status === "error" ? "✗" : "✓";
  const background = entry.data.status === "error" ? "toolErrorBg" : "toolSuccessBg";
  const box = new Box(1, 0, (text) => theme.bg(background, text));
  let content = theme.fg("toolTitle", `${icon} ${entry.data.summary}`);
  const body = expanded ? entry.data.details : entry.data.preview;
  if (body) content += `\n${theme.fg("toolOutput", body)}`;
  box.addChild(new Text(content, 0, 0));
  return box;
};
