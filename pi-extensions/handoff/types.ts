export type ToolCallSummary = {
  name: string;
  summary: string;
};

export type HandoffContext = {
  goal: string;
  conversationText: string;
  relevantFiles: string[];
  toolCalls: ToolCallSummary[];
};

export type DraftGenerationResult =
  | { status: "ok"; draft: string }
  | { status: "cancelled" }
  | { status: "error"; message: string };
