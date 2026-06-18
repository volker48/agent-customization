import { describe, expect, it } from "vitest";

import {
  projectTranscriptEvent,
  projectTranscriptEvents,
  projectTranscriptMessage,
  type TranscriptMessage,
  type TranscriptProjectionEvent,
} from "../pi-extensions/remote/transcript-projection.js";

describe("remote transcript projection", () => {
  it("projects message events to compact transcript entries", () => {
    const event: TranscriptProjectionEvent = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Done" }],
      },
    };

    expect(projectTranscriptEvent(event)).toEqual({
      role: "assistant",
      text: "Done",
      toolName: null,
      status: "completed",
      truncatedOutput: false,
    });
  });

  it("truncates large tool output", () => {
    const output = "x".repeat(1300);

    expect(
      projectTranscriptEvent(
        {
          type: "tool_execution_end",
          toolCallId: "call-1",
          toolName: "bash",
          result: { content: [{ type: "text", text: output }] },
          isError: false,
        },
        { maxOutputChars: 80 },
      ),
    ).toEqual({
      role: "toolResult",
      text: `${"x".repeat(80)}…`,
      toolName: "bash",
      status: "completed",
      truncatedOutput: true,
    });
  });

  it("projects attach backfill messages and live message_end events identically", () => {
    const message: TranscriptMessage = { role: "user", content: "hello\nworld" };
    const live: TranscriptProjectionEvent = { type: "message_end", message };

    expect(projectTranscriptMessage(message)).toEqual(projectTranscriptEvent(live));
  });

  it("does not split emoji when truncating output", () => {
    expect(
      projectTranscriptEvent(
        {
          type: "tool_execution_end",
          toolCallId: "call-1",
          toolName: "bash",
          result: "😀😀😀",
          isError: false,
        },
        { maxOutputChars: 2 },
      ),
    ).toEqual({
      role: "toolResult",
      text: "😀😀…",
      toolName: "bash",
      status: "completed",
      truncatedOutput: true,
    });
  });

  it("projects non-content tool result shapes", () => {
    expect(
      projectTranscriptEvent({
        type: "tool_execution_update",
        toolCallId: "call-1",
        toolName: "bash",
        partialResult: "raw output",
      }),
    ).toMatchObject({ text: "raw output", toolName: "bash", status: "running" });

    expect(
      projectTranscriptEvent({
        type: "tool_execution_update",
        toolCallId: "call-1",
        toolName: "read",
        partialResult: [{ type: "text", text: "file contents" }],
      }),
    ).toMatchObject({ text: "file contents", toolName: "read", status: "running" });
  });

  it("projects turn and agent lifecycle events without message text", () => {
    expect(projectTranscriptEvents([{ type: "turn_start", turnIndex: 0 }])).toEqual([
      {
        role: "system",
        text: "",
        toolName: null,
        status: "turn_started",
        truncatedOutput: false,
      },
    ]);
    expect(projectTranscriptEvents([{ type: "agent_end", messages: [] }])).toEqual([
      {
        role: "system",
        text: "",
        toolName: null,
        status: "agent_completed",
        truncatedOutput: false,
      },
    ]);
  });
});
