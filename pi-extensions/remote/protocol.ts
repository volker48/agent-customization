export const REMOTE_CONTROL_ALPN = "pi/remote/1";

export const CONTROL_MESSAGE_TYPES = ["pair", "list", "attach", "detach", "session_ended"] as const;
export const PER_SESSION_MESSAGE_TYPES = ["event", "prompt", "abort"] as const;

export type ControlMessageType = (typeof CONTROL_MESSAGE_TYPES)[number];
export type PerSessionMessageType = (typeof PER_SESSION_MESSAGE_TYPES)[number];
export type MessageType = ControlMessageType | PerSessionMessageType;

export type Envelope = {
  sessionId: string | null;
  type: MessageType;
  payload: unknown;
};

export type ControlEnvelope = Envelope & {
  sessionId: null;
  type: ControlMessageType;
};

export type PerSessionEnvelope = Envelope & {
  sessionId: string;
  type: PerSessionMessageType;
};

export type RoutedEnvelope =
  | { channel: "control"; envelope: ControlEnvelope }
  | { channel: "session"; envelope: PerSessionEnvelope };

export function encodeFrame(envelope: Envelope): string {
  return `${JSON.stringify(envelope)}\n`;
}

export function decodeFrame(frame: string): Envelope {
  const line = frame.endsWith("\n") ? frame.slice(0, -1) : frame;
  return JSON.parse(line) as Envelope;
}

export function decodeFrames(input: string): Envelope[] {
  return input
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Envelope);
}

export function routeEnvelope(envelope: Envelope): RoutedEnvelope {
  if (envelope.sessionId === null) {
    return { channel: "control", envelope: envelope as ControlEnvelope };
  }

  return { channel: "session", envelope: envelope as PerSessionEnvelope };
}
