import type {
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";

export interface CursorModelInfo {
  id: string;
  name: string;
}

export interface CursorToolEntry {
  summary: string;
  status: "success" | "error";
  preview: string;
  details: string;
}

export type ToolActivitySink = (entry: CursorToolEntry) => void;

export type CursorStream = (
  model: Model<never>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  onToolActivity: ToolActivitySink,
) => AssistantMessageEventStream;
