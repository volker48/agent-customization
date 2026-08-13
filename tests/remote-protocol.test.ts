import { describe, expect, it } from "vitest";

import {
  CAPSULE_CAPABILITY,
  REMOTE_CONTROL_ALPN,
  CONTROL_MESSAGE_TYPES,
  PER_SESSION_MESSAGE_TYPES,
  capsuleControlRequest,
  decodeFrame,
  decodeFrames,
  encodeFrame,
  parseCapsuleControlRequest,
  routeEnvelope,
  type Envelope,
} from "../pi-extensions/remote/protocol.js";

describe("remote wire protocol", () => {
  it("round-trips an envelope faithfully", () => {
    const envelope: Envelope = {
      sessionId: "session-1",
      type: "event",
      payload: {
        text: "hello",
        nested: { ok: true },
      },
    };

    expect(decodeFrame(encodeFrame(envelope))).toEqual(envelope);
  });

  it("splits JSONL frames on LF only", () => {
    const first: Envelope = {
      sessionId: "session-1",
      type: "event",
      payload: { text: "line one\nline two\u2028line three\u2029line four" },
    };
    const second: Envelope = {
      sessionId: null,
      type: "list",
      payload: {},
    };

    expect(decodeFrames(`${encodeFrame(first)}${encodeFrame(second)}`)).toEqual([first, second]);
  });

  it.each([
    { sessionId: 42, type: "event", payload: {} },
    { sessionId: "", type: "event", payload: {} },
    { sessionId: "session-1", type: "unknown", payload: {} },
    { sessionId: "session-1", type: "event" },
  ])("rejects malformed envelopes at the JSONL boundary: %o", (frame) => {
    expect(() => decodeFrame(`${JSON.stringify(frame)}\n`)).toThrow(/frame|sessionId|envelope/);
  });

  it("would break if framing used a generic line reader", () => {
    const envelope: Envelope = {
      sessionId: "session-1",
      type: "event",
      payload: { text: "before\u2028after" },
    };

    const genericLines = encodeFrame(envelope)
      .split(/\r\n|[\n\r\u2028\u2029]/u)
      .filter((line) => line.length > 0);

    expect(() => genericLines.map((line) => JSON.parse(line))).toThrow();
    expect(decodeFrames(encodeFrame(envelope))).toEqual([envelope]);
  });

  it("routes null session ids to control and non-null ids to per-session", () => {
    expect(routeEnvelope({ sessionId: null, type: "list", payload: {} })).toEqual({
      channel: "control",
      envelope: { sessionId: null, type: "list", payload: {} },
    });
    expect(routeEnvelope({ sessionId: "session-1", type: "prompt", payload: {} })).toEqual({
      channel: "session",
      envelope: { sessionId: "session-1", type: "prompt", payload: {} },
    });
  });

  it("adds capsule requests inside the compatible list control envelope", () => {
    const request = capsuleControlRequest("session-1");

    expect(request).toEqual({ operation: "capsule", sessionId: "session-1" });
    expect(parseCapsuleControlRequest(request)).toEqual(request);
    expect(parseCapsuleControlRequest({ operation: "capsule", sessionId: "" })).toBeNull();
    expect(CAPSULE_CAPABILITY).toBe("context-capsule-v1");
    expect(CONTROL_MESSAGE_TYPES).not.toContain("capsule");
  });

  it("exports message type vocabularies and the ALPN constant", () => {
    expect(CONTROL_MESSAGE_TYPES).toEqual(["pair", "list", "attach", "detach", "session_ended"]);
    expect(PER_SESSION_MESSAGE_TYPES).toEqual(["event", "prompt", "abort"]);
    expect(REMOTE_CONTROL_ALPN).toBe("pi/remote/1");
  });
});
