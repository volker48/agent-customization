import { describe, expect, it } from "vitest";

import type { Context } from "@earendil-works/pi-ai";

import { buildPrompt, buildSdkMessage, hasCursorHistory } from "../pi-extensions/cursor/prompt.js";

const timestamp = 1;

describe("Cursor prompt projection", () => {
  it("replays and truncates prior transcript content on a first Cursor turn", () => {
    const context: Context = {
      systemPrompt: "Keep generated files unchanged.",
      messages: [
        { role: "user", content: "Initial task", timestamp },
        {
          role: "assistant",
          content: [{ type: "text", text: "x".repeat(4_001) }],
          api: "cursor-bridge" as never,
          provider: "other",
          model: "model",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp,
        },
        { role: "user", content: "Continue", timestamp },
      ],
    };

    const prompt = buildPrompt(context, true);

    expect(prompt).toContain("System instructions from Pi:\nKeep generated files unchanged.");
    expect(prompt).toContain(`Assistant: ${"x".repeat(4_000)}\n...[truncated]`);
    expect(prompt).not.toContain("x".repeat(4_001));
    expect(prompt).toContain("User: Continue");
  });

  it("projects current images into SDK messages and detects Cursor history", () => {
    const context: Context = {
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Earlier response" }],
          api: "cursor-bridge" as never,
          provider: "cursor",
          model: "model",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp,
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this" },
            { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
          ],
          timestamp,
        },
      ],
    };

    expect(buildSdkMessage(context, false)).toEqual({
      text: "Describe this",
      images: [{ data: "aGVsbG8=", mimeType: "image/png" }],
    });
    expect(hasCursorHistory(context)).toBe(true);
  });
});
