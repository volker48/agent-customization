import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import type { Capsule } from "../pi-extensions/lib/context-capsule.js";
import { projectCapsule } from "../pi-extensions/remote/capsule-projection.js";
import {
  capsuleControlRequest,
  encodeFrame,
  type Envelope,
} from "../pi-extensions/remote/protocol.js";
import { projectTranscriptEvent } from "../pi-extensions/remote/transcript-projection.js";

export type ProtocolFixture = {
  name: string;
  channel: "control" | "session";
  frame: string;
};

const fixturePath = "ios-remote-client/Tests/PiRemoteClientTests/Fixtures/protocol-fixtures.json";

type FixtureEnvelope = {
  name: string;
  channel: ProtocolFixture["channel"];
  envelope: Envelope;
};

export const fixtureEnvelopes: FixtureEnvelope[] = [
  {
    name: "control list request",
    channel: "control",
    envelope: { sessionId: null, type: "list", payload: {} },
  },
  {
    name: "control pair response",
    channel: "control",
    envelope: { sessionId: null, type: "pair", payload: { paired: true } },
  },
  {
    name: "control capsule request",
    channel: "control",
    envelope: { sessionId: null, type: "list", payload: capsuleControlRequest("session-1") },
  },
  {
    name: "control capsule response",
    channel: "control",
    envelope: {
      sessionId: null,
      type: "list",
      payload: {
        operation: "capsule",
        requestId: "request-1",
        supported: true,
        capsule: projectCapsule(fixtureCapsule()),
      },
    },
  },
  {
    name: "session event with escaped lf and unicode separators",
    channel: "session",
    envelope: {
      sessionId: "session-1",
      type: "event",
      payload: projectTranscriptEvent({
        type: "message_update",
        message: {
          role: "assistant",
          content: "line one\nline two\u2028line three\u2029line four 😀",
        },
      }),
    },
  },
  {
    name: "session prompt request",
    channel: "session",
    envelope: {
      sessionId: "session-1",
      type: "prompt",
      payload: { text: "continue from the phone" },
    },
  },
];

function fixtureCapsule(): Capsule {
  return {
    kind: "pi-context-capsule",
    schemaVersion: 1,
    capsuleId: "capsule-1",
    revision: 3,
    createdAt: "2026-01-02T03:04:05.000Z",
    source: { sessionId: "session-1", cwd: "/repo" },
    objective: "Finish the remote capsule view.",
    constraints: ["Generate and redact only on the host."],
    decisions: [{ statement: "Reuse the list control envelope.", status: "confirmed" }],
    resources: [{ kind: "path", value: "pi-extensions/remote/protocol.ts" }],
    observedChanges: [
      { path: "pi-extensions/remote/protocol.ts", status: "observed", provenance: "tool-recorded" },
    ],
    validation: [
      {
        command: "pnpm typecheck",
        outcome: "passed",
        evidence: "TypeScript compilation completed.",
      },
    ],
    blockers: [],
    risks: ["Older daemons return the ordinary session list."],
    nextAction: "Run the native client tests.",
    exclusions: [
      { category: "secret", count: 2 },
      { category: "oversized", count: 1 },
    ],
  };
}

export function protocolFixtures(): ProtocolFixture[] {
  return fixtureEnvelopes.map(({ name, channel, envelope }) => ({
    name,
    channel,
    frame: encodeFrame(envelope),
  }));
}

function writeProtocolFixtures(): void {
  mkdirSync(dirname(fixturePath), { recursive: true });
  writeFileSync(fixturePath, `${JSON.stringify(protocolFixtures(), null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  writeProtocolFixtures();
}
