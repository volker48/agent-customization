export type DocType =
  | "python"
  | "typescript"
  | "javascript"
  | "markdown"
  | "text";

export interface ChunkRecord {
  id: string;
  docId: string;
  docName: string;
  text: string;
  charStart: number;
  charEnd: number;
  index: number;
}

export interface DocumentRecord {
  id: string;
  name: string;
  chunkIds: string[];
  totalChars: number;
  type: string;
}

export interface StoreSnapshot {
  chunks: Record<string, ChunkRecord>;
  documents: Record<string, DocumentRecord>;
  searchIndexJson: string;
  buffers: Record<string, unknown>;
}

export interface RlmResult<T> {
  ok: boolean;
  data: T;
  meta: { truncated: boolean; [key: string]: unknown };
}
