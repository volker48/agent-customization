import { describe, expect, it } from "vitest";

import {
  enforceSchema,
  ensureAcceptanceChecklist,
  extractFileCandidates,
  truncateText,
  type HandoffContext,
} from "./handoff.js";

describe("handoff helpers", () => {
  it("keeps the newest conversation text when truncating", () => {
    const result = truncateText("abcdef", 4);
    const [notice, tail] = result.split("\n\n");

    expect(notice).toContain("showing most recent context");
    expect(tail).toBe("cdef");
  });

  it("normalizes acceptance criteria into checklist items", () => {
    expect(ensureAcceptanceChecklist("step one\n- step two")).toBe(
      "- [ ] step one\n- [ ] step two",
    );
    expect(ensureAcceptanceChecklist("")).toContain("- [ ] Implementation satisfies the Objective");
  });

  it("enforces required markdown sections with sensible fallbacks", () => {
    const context: HandoffContext = {
      goal: "Ship the handoff patch",
      conversationText: "previous discussion",
      relevantFiles: ["pi-extensions/handoff.ts"],
      notableCommands: ["pnpm run typecheck"],
    };

    const schema = enforceSchema("Draft with no headings", context);

    expect(schema).toContain("## Objective\nShip the handoff patch");
    expect(schema).toContain("## Relevant Files\n- pi-extensions/handoff.ts");
    expect(schema).toContain("## Acceptance Criteria\n- [ ]");
  });

  it("extracts likely file paths and ignores numeric extension noise", () => {
    const files = extractFileCandidates(
      "Update @pi-extensions/handoff.ts and package.json, not version v1.2",
    );

    expect(files).toContain("pi-extensions/handoff.ts");
    expect(files).toContain("package.json");
    expect(files).not.toContain("v1.2");
  });
});
