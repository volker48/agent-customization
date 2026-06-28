import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import { encodeFrame, type Envelope } from "../pi-extensions/remote/protocol.js";
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
