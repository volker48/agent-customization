import { describe, expect, it } from "vitest";

import { CAPSULE_MAX_BYTES, type Capsule } from "../pi-extensions/lib/context-capsule.js";
import { projectCapsule } from "../pi-extensions/remote/capsule-projection.js";

describe("remote capsule projection", () => {
  it("keeps only the bounded host-safe brief and explicit exclusion metadata", () => {
    const projection = projectCapsule(capsuleFixture());

    expect(projection).toMatchObject({
      capsuleId: "capsule-1",
      objective: "Finish capsule retrieval",
      redactions: [
        { category: "secret", count: 2 },
        { category: "oversized", count: 1 },
      ],
      truncated: true,
      maxPayloadBytes: CAPSULE_MAX_BYTES,
    });
    expect(projection).not.toHaveProperty("resources");
    expect(projection).not.toHaveProperty("observedChanges");
    expect(projection).not.toHaveProperty("source");
    expect(projection).not.toHaveProperty("createdAt");
    expect(JSON.stringify(projection)).not.toContain("session-file.jsonl");
    expect(Buffer.byteLength(JSON.stringify(projection), "utf8")).toBeLessThanOrEqual(
      CAPSULE_MAX_BYTES,
    );
  });
});

function capsuleFixture(): Capsule {
  return {
    kind: "pi-context-capsule",
    schemaVersion: 1,
    capsuleId: "capsule-1",
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    source: {
      sessionId: "session-1",
      sessionFile: "/private/session-file.jsonl",
      cwd: "/repo",
    },
    objective: "Finish capsule retrieval",
    constraints: ["Host-generated only"],
    decisions: [{ statement: "Use list compatibility", status: "confirmed" }],
    resources: [{ kind: "path", value: "pi-extensions/remote/protocol.ts" }],
    observedChanges: [
      { path: "pi-extensions/remote/protocol.ts", status: "observed", provenance: "tool-recorded" },
    ],
    validation: [{ command: "pnpm typecheck", outcome: "passed", evidence: "No diagnostics" }],
    blockers: [],
    risks: ["Mixed versions"],
    nextAction: "Run tests",
    exclusions: [
      { category: "secret", count: 2 },
      { category: "oversized", count: 1 },
    ],
  };
}
