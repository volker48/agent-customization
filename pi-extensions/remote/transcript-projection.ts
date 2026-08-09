const DEFAULT_MAX_OUTPUT_CHARS = 4000;

export type TranscriptRole = "user" | "assistant" | "toolResult" | "system" | (string & {});

export type TranscriptEntry = {
  role: TranscriptRole;
  text: string;
  toolName: string | null;
  status: string | null;
  truncatedOutput: boolean;
};

export type TranscriptProjectionOptions = {
  maxOutputChars?: number;
};

export type TranscriptMessage = {
  role: TranscriptRole;
  content?: unknown;
  toolName?: string;
};

export type TranscriptProjectionEvent =
  | { type: "message_start" | "message_update" | "message_end"; message: TranscriptMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args?: unknown }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args?: unknown;
      partialResult?: unknown;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result?: unknown;
      isError?: boolean;
    }
  | { type: "turn_start"; turnIndex?: number; timestamp?: number }
  | { type: "turn_end"; turnIndex?: number; message?: unknown; toolResults?: unknown }
  | { type: "agent_end"; messages?: unknown };

export function projectTranscriptEvents(
  events: TranscriptProjectionEvent[],
  options: TranscriptProjectionOptions = {},
): TranscriptEntry[] {
  return events.map((event) => projectTranscriptEvent(event, options));
}

export function projectTranscriptMessage(
  message: TranscriptMessage,
  options: TranscriptProjectionOptions = {},
): TranscriptEntry {
  return projectMessage("completed", message, options);
}

export function projectTranscriptEvent(
  event: TranscriptProjectionEvent,
  options: TranscriptProjectionOptions = {},
): TranscriptEntry {
  switch (event.type) {
    case "message_start":
    case "message_update":
    case "message_end":
      return projectMessageEvent(event.type, event.message, options);
    case "tool_execution_start":
      return emptyEntry("toolResult", event.toolName, "running");
    case "tool_execution_update":
      return projectToolEvent(event.toolName, "running", event.partialResult, options);
    case "tool_execution_end":
      return projectToolEvent(
        event.toolName,
        event.isError ? "error" : "completed",
        event.result,
        options,
      );
    case "turn_start":
      return emptyEntry("system", null, "turn_started");
    case "turn_end":
      return emptyEntry("system", null, "turn_completed");
    case "agent_end":
      return emptyEntry("system", null, "agent_completed");
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

function projectMessageEvent(
  type: "message_start" | "message_update" | "message_end",
  message: TranscriptMessage,
  options: TranscriptProjectionOptions,
): TranscriptEntry {
  return projectMessage(messageStatus(type), message, options);
}

function projectMessage(
  status: string,
  message: TranscriptMessage,
  options: TranscriptProjectionOptions,
): TranscriptEntry {
  const truncated = truncateText(extractText(message.content), outputLimit(options));

  return {
    role: message.role,
    text: truncated.text,
    toolName: message.toolName ?? null,
    status,
    truncatedOutput: truncated.truncated,
  };
}

function projectToolEvent(
  toolName: string,
  status: string,
  result: unknown,
  options: TranscriptProjectionOptions,
): TranscriptEntry {
  const truncated = truncateText(extractToolText(result), outputLimit(options));

  return {
    role: "toolResult",
    text: truncated.text,
    toolName,
    status,
    truncatedOutput: truncated.truncated,
  };
}

function emptyEntry(
  role: TranscriptRole,
  toolName: string | null,
  status: string,
): TranscriptEntry {
  return { role, text: "", toolName, status, truncatedOutput: false };
}

function messageStatus(type: "message_start" | "message_update" | "message_end"): string {
  const statuses = {
    message_start: "started",
    message_update: "streaming",
    message_end: "completed",
  } as const;
  return statuses[type];
}

function outputLimit(options: TranscriptProjectionOptions): number {
  return options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  const codePoints = [...text];
  if (codePoints.length <= maxChars) {
    return { text, truncated: false };
  }

  return { text: `${codePoints.slice(0, maxChars).join("")}…`, truncated: true };
}

function extractToolText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (hasField(value, "content")) {
    return extractText(value.content);
  }

  return extractText(value);
}

function extractText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (!Array.isArray(value)) {
    return "";
  }

  return value.map(textFromBlock).filter(Boolean).join("\n");
}

function textFromBlock(block: unknown): string {
  if (!hasField(block, "type")) {
    return "";
  }

  if (block.type === "text" && "text" in block && typeof block.text === "string") {
    return block.text;
  }

  if (block.type === "thinking" && "thinking" in block && typeof block.thinking === "string") {
    return block.thinking;
  }

  if (block.type === "toolCall" && "name" in block && typeof block.name === "string") {
    return `Tool call: ${block.name}`;
  }

  return "";
}

function hasField<const K extends string>(
  value: unknown,
  field: K,
): value is { [P in K]: unknown } {
  return typeof value === "object" && value !== null && field in value;
}
