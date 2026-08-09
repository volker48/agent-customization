export const REMOTE_CONTROL_ALPN = "pi/remote/1";
export const CAPSULE_CAPABILITY = "context-capsule-v1";
export const CAPSULE_OPERATION = "capsule";

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

export type ControlEnvelope = {
  sessionId: null;
  type: ControlMessageType;
  payload: unknown;
};

export type PerSessionEnvelope = {
  sessionId: string;
  type: PerSessionMessageType;
  payload: unknown;
};

export type RoutedEnvelope =
  | { channel: "control"; envelope: ControlEnvelope }
  | { channel: "session"; envelope: PerSessionEnvelope };

export type CapsuleControlRequest = {
  operation: typeof CAPSULE_OPERATION;
  sessionId: string;
};

export type CapsuleControlError = {
  code:
    | "cancelled"
    | "io"
    | "malformed"
    | "not-attached"
    | "not-found"
    | "oversized"
    | "unavailable"
    | "unsafe"
    | "unsupported-version";
  message: string;
};

export type CapsuleControlResult<T = unknown> =
  | {
      operation: typeof CAPSULE_OPERATION;
      requestId: string;
      supported: true;
      capsule: T;
    }
  | {
      operation: typeof CAPSULE_OPERATION;
      requestId: string;
      supported: true;
      error: CapsuleControlError;
    }
  | {
      operation: typeof CAPSULE_OPERATION;
      requestId: string;
      supported: false;
      capability: typeof CAPSULE_CAPABILITY;
    };

export function capsuleControlRequest(sessionId: string): CapsuleControlRequest {
  return { operation: CAPSULE_OPERATION, sessionId };
}

export function parseCapsuleControlRequest(payload: unknown): CapsuleControlRequest | null {
  if (
    !hasFields(payload, ["operation", "sessionId"]) ||
    payload.operation !== CAPSULE_OPERATION ||
    typeof payload.sessionId !== "string" ||
    payload.sessionId.length === 0
  ) {
    return null;
  }
  return { operation: CAPSULE_OPERATION, sessionId: payload.sessionId };
}

export function isCapsuleControlRequest(payload: unknown): boolean {
  return hasFields(payload, ["operation"]) && payload.operation === CAPSULE_OPERATION;
}

export function encodeFrame(envelope: Envelope): string {
  return `${JSON.stringify(envelope)}\n`;
}

export function decodeFrame(frame: string): Envelope {
  const line = frame.endsWith("\n") ? frame.slice(0, -1) : frame;
  return parseEnvelope(JSON.parse(line));
}

export function decodeFrames(input: string): Envelope[] {
  return input
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => parseEnvelope(JSON.parse(line)));
}

function hasFields<const K extends string>(
  value: unknown,
  fields: readonly K[],
): value is { [P in K]: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    fields.every((field) => field in value)
  );
}

function parseEnvelope(value: unknown): Envelope {
  if (!hasFields(value, ["sessionId", "type", "payload"]) || !isMessageType(value.type)) {
    throw new Error("Remote frame is not a valid envelope");
  }
  const sessionId = parseSessionId(value.sessionId);
  return { sessionId, type: value.type, payload: value.payload };
}

function parseSessionId(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error("Remote frame sessionId must be null or a non-empty string");
}

function isMessageType(value: unknown): value is MessageType {
  return (
    typeof value === "string" &&
    (CONTROL_MESSAGE_TYPES.some((type) => type === value) ||
      PER_SESSION_MESSAGE_TYPES.some((type) => type === value))
  );
}

export function routeEnvelope(envelope: Envelope): RoutedEnvelope {
  if (envelope.sessionId === null) {
    return { channel: "control", envelope: envelope as ControlEnvelope };
  }

  return { channel: "session", envelope: envelope as PerSessionEnvelope };
}
