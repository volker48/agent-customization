import { createHash } from "node:crypto";
import MiniSearch from "minisearch";
import { chunkDocument } from "./chunker.js";
import type {
  ChunkRecord,
  DocType,
  DocumentRecord,
  StoreSnapshot,
} from "./types.js";

const MINISEARCH_CONFIG = {
  fields: ["text"],
  storeFields: [
    "chunkId",
    "docId",
    "docName",
    "charStart",
    "charEnd",
  ],
};

interface SearchHit {
  chunkId: string;
  docId: string;
  docName: string;
  score: number;
  text: string;
  charStart: number;
  charEnd: number;
}

interface AddDocumentOptions {
  name?: string;
  type?: DocType;
  chunkSize?: number;
  overlap?: number;
}

function makeHash(content: string): string {
  return createHash("sha256")
    .update(content)
    .digest("hex")
    .slice(0, 16);
}

function createIndex(): MiniSearch {
  return new MiniSearch(MINISEARCH_CONFIG);
}

export class DocumentStore {
  private chunks = new Map<string, ChunkRecord>();
  private documents = new Map<string, DocumentRecord>();
  private index = createIndex();
  private buffers = new Map<string, unknown>();

  addDocument(
    content: string,
    options: AddDocumentOptions = {},
  ): DocumentRecord {
    const docId = makeHash(content);

    const existing = this.documents.get(docId);
    if (existing) return existing;

    const docName = options.name ?? docId;
    const type = options.type ?? "text";

    const rawChunks = chunkDocument(content, {
      type: options.type,
      chunkSize: options.chunkSize,
      overlap: options.overlap,
    });

    const chunkIds: string[] = [];

    for (let i = 0; i < rawChunks.length; i++) {
      const raw = rawChunks[i];
      const chunkId = makeHash(raw.text);
      chunkIds.push(chunkId);

      if (!this.chunks.has(chunkId)) {
        const record: ChunkRecord = {
          id: chunkId,
          docId,
          docName,
          text: raw.text,
          charStart: raw.charStart,
          charEnd: raw.charEnd,
          index: i,
        };
        this.chunks.set(chunkId, record);
        this.index.add({
          id: chunkId,
          text: raw.text,
          chunkId,
          docId,
          docName,
          charStart: raw.charStart,
          charEnd: raw.charEnd,
        });
      }
    }

    const doc: DocumentRecord = {
      id: docId,
      name: docName,
      chunkIds,
      totalChars: content.length,
      type,
    };
    this.documents.set(docId, doc);
    return doc;
  }

  addDocumentBatch(
    items: Array<{ content: string; options?: AddDocumentOptions }>,
  ): DocumentRecord[] {
    const prepared: Array<{
      content: string;
      options: AddDocumentOptions;
      docId: string;
      rawChunks: Array<{
        text: string;
        charStart: number;
        charEnd: number;
      }>;
    }> = [];

    for (const item of items) {
      const docId = makeHash(item.content);
      const opts = item.options ?? {};
      const rawChunks = chunkDocument(item.content, {
        type: opts.type,
        chunkSize: opts.chunkSize,
        overlap: opts.overlap,
      });
      prepared.push({
        content: item.content,
        options: opts,
        docId,
        rawChunks,
      });
    }

    const results: DocumentRecord[] = [];
    for (const entry of prepared) {
      results.push(
        this.addDocument(entry.content, entry.options),
      );
    }
    return results;
  }

  search(
    query: string,
    options?: { limit?: number },
  ): SearchHit[] {
    const limit = options?.limit ?? 10;
    const results = this.index.search(query);

    return results.slice(0, limit).map((result) => {
      const chunkId = result.chunkId as string;
      const chunk = this.chunks.get(chunkId);
      return {
        chunkId,
        docId: result.docId as string,
        docName: result.docName as string,
        score: result.score,
        text: chunk?.text ?? "",
        charStart: result.charStart as number,
        charEnd: result.charEnd as number,
      };
    });
  }

  extractByChunkId(chunkId: string): ChunkRecord | null {
    return this.chunks.get(chunkId) ?? null;
  }

  extractByRange(
    docId: string,
    charStart: number,
    charEnd: number,
  ): string | null {
    const doc = this.documents.get(docId);
    if (!doc) return null;

    const docChunks = doc.chunkIds
      .map((id) => this.chunks.get(id))
      .filter((c): c is ChunkRecord => c != null)
      .sort((a, b) => a.charStart - b.charStart);

    const overlapping = docChunks.filter(
      (c) => c.charStart < charEnd && c.charEnd > charStart,
    );

    if (overlapping.length === 0) return null;

    let combined = "";
    let offset = overlapping[0].charStart;
    for (const chunk of overlapping) {
      if (chunk.charStart > offset) {
        combined += chunk.text;
      } else {
        const skip = offset - chunk.charStart;
        combined += chunk.text.slice(skip);
      }
      offset = chunk.charEnd;
    }

    const relStart = charStart - overlapping[0].charStart;
    const relEnd = relStart + (charEnd - charStart);
    return combined.slice(relStart, relEnd);
  }

  saveBuffer(name: string, value: unknown): void {
    this.buffers.set(name, value);
  }

  getBuffer(name: string): unknown | undefined {
    return this.buffers.get(name);
  }

  snapshot(): StoreSnapshot {
    const chunks: Record<string, ChunkRecord> = {};
    for (const [id, record] of this.chunks) {
      chunks[id] = record;
    }

    const documents: Record<string, DocumentRecord> = {};
    for (const [id, record] of this.documents) {
      documents[id] = record;
    }

    const bufferObj: Record<string, unknown> = {};
    for (const [name, value] of this.buffers) {
      bufferObj[name] = value;
    }

    return {
      chunks,
      documents,
      searchIndexJson: JSON.stringify(this.index),
      buffers: bufferObj,
    };
  }

  restore(snap: StoreSnapshot): void {
    this.chunks.clear();
    this.documents.clear();
    this.buffers.clear();

    for (const [id, record] of Object.entries(snap.chunks)) {
      this.chunks.set(id, record);
    }
    for (const [id, record] of Object.entries(snap.documents)) {
      this.documents.set(id, record);
    }
    for (const [name, value] of Object.entries(snap.buffers)) {
      this.buffers.set(name, value);
    }

    this.index = MiniSearch.loadJSON(
      snap.searchIndexJson,
      MINISEARCH_CONFIG,
    );
  }

  reset(): void {
    this.chunks.clear();
    this.documents.clear();
    this.buffers.clear();
    this.index = createIndex();
  }
}
