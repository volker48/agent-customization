import { describe, expect, it } from "vitest";

import { createToolEntry } from "../pi-extensions/cursor/tool-entry.js";

describe("Cursor tool entries", () => {
  it("normalizes nested CLI errors and truncates previews", () => {
    const entry = createToolEntry({
      shellToolCall: {
        args: { command: "pnpm test" },
        result: { status: "error", stderr: "x".repeat(1_201) },
      },
    });

    expect(entry.summary).toBe("shell: pnpm test");
    expect(entry.status).toBe("error");
    expect(entry.preview).toBe(`${"x".repeat(1_200)}\n...[truncated]`);
  });

  it("truncates serialized details independently from the preview", () => {
    const entry = createToolEntry({
      type: "read",
      args: { path: "large.txt" },
      result: { value: { metadata: "x".repeat(9_000) } },
    });

    expect(entry.summary).toBe("read: large.txt");
    expect(entry.details).toHaveLength(8_015);
    expect(entry.details.endsWith("\n...[truncated]")).toBe(true);
  });
});
