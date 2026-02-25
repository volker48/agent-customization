import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { StringEnum, Type } from "@mariozechner/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@mariozechner/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { DocumentStore } from "./store.js";
import type {
  DocType,
  RlmResult,
  StoreSnapshot,
} from "./types.js";

const DOC_TYPES = [
  "python",
  "typescript",
  "javascript",
  "markdown",
  "text",
] as const;

const EXTENSION_TYPE_MAP: Record<string, DocType> = {
  ".py": "python",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".md": "markdown",
};

interface RlmDetails {
  tool: string;
  snapshot?: StoreSnapshot;
}

function isFilePath(source: string): boolean {
  return (
    source.startsWith("/") ||
    source.startsWith("~") ||
    source.startsWith("./")
  );
}

function inferDocType(filePath: string): DocType {
  const ext = extname(filePath).toLowerCase();
  return EXTENSION_TYPE_MAP[ext] ?? "text";
}

function applyTruncation(text: string): {
  text: string;
  truncated: boolean;
} {
  const result = truncateHead(text, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  if (!result.truncated) {
    return { text: result.content, truncated: false };
  }

  let output = result.content;
  output += "\n\n[Output truncated: showing ";
  output += `${result.outputLines} of ${result.totalLines} lines`;
  output += ` (${formatSize(result.outputBytes)}`;
  output += ` of ${formatSize(result.totalBytes)})]`;

  return { text: output, truncated: true };
}

function formatResult<T>(result: RlmResult<T>): string {
  if (!result.ok) {
    return `Error: ${result.meta.error ?? "Unknown error"}`;
  }

  if (typeof result.data === "string") {
    return result.data;
  }

  return JSON.stringify(result.data, null, 2);
}

function makeTextContent(
  result: RlmResult<unknown>,
): { text: string; truncated: boolean } {
  const formatted = formatResult(result);
  return applyTruncation(formatted);
}

function makeDetails(
  store: DocumentStore,
  toolName: string,
): RlmDetails {
  const mutating =
    toolName === "rlm_load" || toolName === "rlm_save";
  return mutating
    ? { tool: toolName, snapshot: store.snapshot() }
    : { tool: toolName };
}

export default function rlmExtension(pi: ExtensionAPI) {
  const store = new DocumentStore();

  // --- Tool: rlm_load ---
  pi.registerTool({
    name: "rlm_load",
    label: "RLM Load",
    description:
      "Load a document into the RLM store from a file path or raw content string. " +
      "Supports batch loading via the batch parameter.",
    parameters: Type.Object({
      source: Type.String({
        description:
          "File path (starting with /, ~, or ./) or raw content string",
      }),
      type: Type.Optional(
        StringEnum(DOC_TYPES),
      ),
      name: Type.Optional(
        Type.String({ description: "Optional document name" }),
      ),
      chunk_size: Type.Optional(
        Type.Integer({
          description: "Chunk size in characters",
          minimum: 100,
        }),
      ),
      overlap: Type.Optional(
        Type.Integer({
          description: "Overlap between chunks in characters",
          minimum: 0,
        }),
      ),
      batch: Type.Optional(
        Type.Array(
          Type.Object({
            source: Type.String(),
            type: Type.Optional(StringEnum(DOC_TYPES)),
            name: Type.Optional(Type.String()),
          }),
        ),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        if (params.batch && params.batch.length > 0) {
          return await executeBatchLoad(
            params.batch,
            params.chunk_size,
            params.overlap,
          );
        }
        return await executeSingleLoad(params);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err);
        const result: RlmResult<null> = {
          ok: false,
          data: null,
          meta: { truncated: false, error: message },
        };
        const { text, truncated } = makeTextContent(result);
        result.meta.truncated = truncated;
        return {
          content: [{ type: "text", text }],
          details: makeDetails(store, "rlm_load"),
        };
      }
    },
  });

  async function resolveSource(
    source: string,
    explicitType?: DocType,
  ): Promise<{ content: string; type: DocType }> {
    if (isFilePath(source)) {
      const expanded = source.startsWith("~")
        ? source.replace("~", process.env.HOME ?? "")
        : source;
      const content = await readFile(expanded, "utf-8");
      const type = explicitType ?? inferDocType(expanded);
      return { content, type };
    }
    return { content: source, type: explicitType ?? "text" };
  }

  async function executeSingleLoad(params: {
    source: string;
    type?: DocType;
    name?: string;
    chunk_size?: number;
    overlap?: number;
  }) {
    const { content, type } = await resolveSource(
      params.source,
      params.type,
    );
    const doc = store.addDocument(content, {
      name: params.name,
      type,
      chunkSize: params.chunk_size,
      overlap: params.overlap,
    });
    const result: RlmResult<{
      doc_id: string;
      chunk_count: number;
      total_chars: number;
    }> = {
      ok: true,
      data: {
        doc_id: doc.id,
        chunk_count: doc.chunkIds.length,
        total_chars: doc.totalChars,
      },
      meta: { truncated: false },
    };
    const { text, truncated } = makeTextContent(result);
    result.meta.truncated = truncated;
    return {
      content: [{ type: "text" as const, text }],
      details: makeDetails(store, "rlm_load"),
    };
  }

  async function executeBatchLoad(
    batch: Array<{
      source: string;
      type?: DocType;
      name?: string;
    }>,
    chunkSize?: number,
    overlap?: number,
  ) {
    const resolved = await Promise.all(
      batch.map(async (item) => {
        const { content, type } = await resolveSource(
          item.source,
          item.type,
        );
        return { content, type, name: item.name };
      }),
    );

    const items = resolved.map((r) => ({
      content: r.content,
      options: {
        name: r.name,
        type: r.type,
        chunkSize,
        overlap,
      },
    }));
    const docs = store.addDocumentBatch(items);

    const data = docs.map((doc) => ({
      doc_id: doc.id,
      chunk_count: doc.chunkIds.length,
      total_chars: doc.totalChars,
    }));
    const result: RlmResult<typeof data> = {
      ok: true,
      data,
      meta: { truncated: false, batch_count: docs.length },
    };
    const { text, truncated } = makeTextContent(result);
    result.meta.truncated = truncated;
    return {
      content: [{ type: "text" as const, text }],
      details: makeDetails(store, "rlm_load"),
    };
  }

  // --- Tool: rlm_search ---
  pi.registerTool({
    name: "rlm_search",
    label: "RLM Search",
    description:
      "Search across all loaded documents using BM25 lexical search. " +
      "Returns ranked results with chunk IDs, scores, and text excerpts.",
    parameters: Type.Object({
      query: Type.String({
        description: "Plain text search query",
        minLength: 1,
      }),
      limit: Type.Optional(
        Type.Integer({
          description: "Max results to return (default 10)",
          minimum: 1,
          maximum: 100,
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const hits = store.search(params.query, {
        limit: params.limit,
      });

      let formatted = "";
      if (hits.length === 0) {
        formatted = `No results found for: ${params.query}`;
      } else {
        const lines = hits.map(
          (hit, i) =>
            `${i + 1}. [${hit.chunkId}] (${hit.docName}) ` +
            `score=${hit.score.toFixed(3)}\n` +
            `   ${hit.text.slice(0, 200)}${hit.text.length > 200 ? "..." : ""}`,
        );
        formatted =
          `Search results for: ${params.query}\n\n` +
          lines.join("\n\n");
      }

      const result: RlmResult<string> = {
        ok: true,
        data: formatted,
        meta: {
          truncated: false,
          result_count: hits.length,
          query: params.query,
        },
      };
      const { text, truncated } = makeTextContent(result);
      result.meta.truncated = truncated;
      return {
        content: [{ type: "text", text }],
        details: makeDetails(store, "rlm_search"),
      };
    },
  });

  // --- Tool: rlm_extract ---
  pi.registerTool({
    name: "rlm_extract",
    label: "RLM Extract",
    description:
      "Extract exact content by chunk ID or character range from a document.",
    parameters: Type.Object({
      chunk_id: Type.Optional(
        Type.String({
          description: "Chunk ID to extract",
        }),
      ),
      doc_id: Type.Optional(
        Type.String({
          description:
            "Document ID (required with char_start/char_end)",
        }),
      ),
      char_start: Type.Optional(
        Type.Integer({
          description:
            "Start character offset (relative to original document)",
          minimum: 0,
        }),
      ),
      char_end: Type.Optional(
        Type.Integer({
          description:
            "End character offset (relative to original document)",
          minimum: 1,
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (params.chunk_id) {
        const chunk = store.extractByChunkId(params.chunk_id);
        if (!chunk) {
          const result: RlmResult<null> = {
            ok: false,
            data: null,
            meta: {
              truncated: false,
              error: `Chunk not found: ${params.chunk_id}`,
            },
          };
          const { text, truncated } = makeTextContent(result);
          result.meta.truncated = truncated;
          return {
            content: [{ type: "text", text }],
            details: makeDetails(store, "rlm_extract"),
          };
        }
        const result: RlmResult<{
          text: string;
          chunk_id: string;
          doc_id: string;
          char_start: number;
          char_end: number;
        }> = {
          ok: true,
          data: {
            text: chunk.text,
            chunk_id: chunk.id,
            doc_id: chunk.docId,
            char_start: chunk.charStart,
            char_end: chunk.charEnd,
          },
          meta: { truncated: false },
        };
        const { text, truncated } = makeTextContent(result);
        result.meta.truncated = truncated;
        return {
          content: [{ type: "text", text }],
          details: makeDetails(store, "rlm_extract"),
        };
      }

      if (
        params.doc_id &&
        params.char_start !== undefined &&
        params.char_end !== undefined
      ) {
        const extracted = store.extractByRange(
          params.doc_id,
          params.char_start,
          params.char_end,
        );
        if (extracted === null) {
          const result: RlmResult<null> = {
            ok: false,
            data: null,
            meta: {
              truncated: false,
              error: `Range not found in document: ${params.doc_id}`,
            },
          };
          const { text, truncated } = makeTextContent(result);
          result.meta.truncated = truncated;
          return {
            content: [{ type: "text", text }],
            details: makeDetails(store, "rlm_extract"),
          };
        }
        const result: RlmResult<{
          text: string;
          doc_id: string;
          char_start: number;
          char_end: number;
        }> = {
          ok: true,
          data: {
            text: extracted,
            doc_id: params.doc_id,
            char_start: params.char_start,
            char_end: params.char_end,
          },
          meta: { truncated: false },
        };
        const { text, truncated } = makeTextContent(result);
        result.meta.truncated = truncated;
        return {
          content: [{ type: "text", text }],
          details: makeDetails(store, "rlm_extract"),
        };
      }

      const result: RlmResult<null> = {
        ok: false,
        data: null,
        meta: {
          truncated: false,
          error:
            "Provide either chunk_id, or doc_id with char_start and char_end",
        },
      };
      const { text, truncated } = makeTextContent(result);
      result.meta.truncated = truncated;
      return {
        content: [{ type: "text", text }],
        details: makeDetails(store, "rlm_extract"),
      };
    },
  });

  // --- Tool: rlm_save ---
  pi.registerTool({
    name: "rlm_save",
    label: "RLM Save",
    description:
      "Save a named artifact to the buffer store. " +
      "Value can be any JSON-serializable data.",
    parameters: Type.Object({
      name: Type.String({
        description: "Buffer name",
        minLength: 1,
      }),
      value: Type.Unknown({
        description: "JSON-serializable value to store",
      }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      store.saveBuffer(params.name, params.value);
      const result: RlmResult<{
        name: string;
        saved: boolean;
      }> = {
        ok: true,
        data: { name: params.name, saved: true },
        meta: { truncated: false },
      };
      const { text, truncated } = makeTextContent(result);
      result.meta.truncated = truncated;
      return {
        content: [{ type: "text", text }],
        details: makeDetails(store, "rlm_save"),
      };
    },
  });

  // --- Tool: rlm_get ---
  pi.registerTool({
    name: "rlm_get",
    label: "RLM Get",
    description: "Retrieve a named artifact from the buffer store.",
    parameters: Type.Object({
      name: Type.String({
        description: "Buffer name to retrieve",
        minLength: 1,
      }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const value = store.getBuffer(params.name);
      if (value === undefined) {
        const result: RlmResult<null> = {
          ok: false,
          data: null,
          meta: {
            truncated: false,
            error: `Buffer not found: ${params.name}`,
          },
        };
        const { text, truncated } = makeTextContent(result);
        result.meta.truncated = truncated;
        return {
          content: [{ type: "text", text }],
          details: makeDetails(store, "rlm_get"),
        };
      }
      const result: RlmResult<{
        name: string;
        value: unknown;
      }> = {
        ok: true,
        data: { name: params.name, value },
        meta: { truncated: false },
      };
      const { text, truncated } = makeTextContent(result);
      result.meta.truncated = truncated;
      return {
        content: [{ type: "text", text }],
        details: makeDetails(store, "rlm_get"),
      };
    },
  });

  // --- Lifecycle: Branch-safe state reconstruction ---
  const reconstructState = (ctx: ExtensionContext) => {
    store.reset();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const msg = entry.message;
      if (msg.role !== "toolResult") continue;
      if (
        msg.toolName !== "rlm_load" &&
        msg.toolName !== "rlm_save"
      ) {
        continue;
      }
      const details = msg.details as RlmDetails | undefined;
      if (details?.snapshot) {
        store.restore(details.snapshot);
      }
    }
  };

  pi.on(
    "session_start",
    async (_event, ctx) => reconstructState(ctx),
  );
  pi.on(
    "session_switch",
    async (_event, ctx) => reconstructState(ctx),
  );
  pi.on(
    "session_fork",
    async (_event, ctx) => reconstructState(ctx),
  );
  pi.on(
    "session_tree",
    async (_event, ctx) => reconstructState(ctx),
  );
}
