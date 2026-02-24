# Phase 1: Foundation - Research

**Researched:** 2026-02-24
**Domain:** Pi extension API, in-memory document store, BM25 search, content-aware chunking
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Chunking behavior:**
- Content-aware splitting: detect code vs prose, split code at function/class boundaries when possible
- Optional `type` parameter on `rlm_load` — agent can hint the type (e.g., 'python', 'markdown'), auto-detect as fallback
- When loading from file path, infer document type from file extension (`.py` → python, `.md` → markdown), explicit type param overrides
- Silent deduplication: loading the same content twice reuses existing chunks (idempotent)
- `rlm_load` returns summary with metadata: doc_id, chunk_count, total_tokens
- Optional document name parameter, auto-generate hash-based ID if not provided
- No hard limit on number of documents per session — memory is the natural constraint
- Support both file paths and raw content strings as load sources
- Batch loading supported: accept array of files/content in a single `rlm_load` call
- Batch loading is all-or-nothing: if one file fails, entire batch fails (no partial state)

**Search interface:**
- Result count configurable with a sensible default (agent passes optional `limit` parameter)
- Always search across all loaded documents (no per-document scoping)
- BM25 relevance scores exposed to the agent in results
- Plain text queries only — no query operators (AND/OR, phrase matching)
- Always include document source (doc name/ID) in each search result
- Zero results returns empty array with clear message — no suggestions

**Tool response shape:**
- Consistent response envelope across all tools: `{ ok, data, meta }` pattern
- Smart truncation: truncate at natural boundaries (end of chunk, end of line) with truncation signal
- Silent rehydration on branch fork — agent doesn't know or care state was restored

**Branch fork state:**
- Copy-on-fork model: forked branch gets a frozen snapshot of state at fork time, both branches diverge independently
- Silent rehydration: state restored transparently on forked branch, no agent notification

### Claude's Discretion

**Chunking:**
- Default chunk size selection
- Chunk size configurability (per-load vs global)
- Overlap strategy and size
- Handling oversized functions that exceed chunk size
- Whether to support unloading documents

**Search:**
- Exact result shape (snippet vs full chunk, metadata fields)
- rlm_extract modes (chunk ID only vs also character ranges — DOC-04 mentions both)

**Responses:**
- Error message verbosity level
- Buffer data types for rlm_save/rlm_get (strings only vs JSON-serializable)

**Fork State:**
- What exactly goes in result.details (full snapshot vs minimal references)
- Size limits or warnings on state snapshots

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| DOC-01 | User can load text/code documents into external store with configurable chunk size and overlap | Content-aware chunking via manual splitting logic; MiniSearch as the index; chunk size defaults from research below |
| DOC-02 | Chunks use hash-based stable IDs for deduplication and caching | Node.js built-in `crypto.createHash('sha256')` on chunk content; no external dep needed |
| DOC-03 | User can search across stored chunks via BM25 lexical search returning bounded excerpts with chunk IDs | MiniSearch 7.2.0 uses BM25+ natively; exposes scores; serialize/restore via `JSON.stringify`/`MiniSearch.loadJSON` |
| DOC-04 | User can extract specific spans by chunk ID or character range with bounded output | Stored chunk map (Map<chunkId, ChunkRecord>); character offset arithmetic; truncation via Pi's `truncateHead` |
| STATE-01 | User can save named intermediate artifacts to buffers | In-memory `Map<name, value>` inside extension closure; serialized to `details` on each `rlm_save` call |
| STATE-02 | User can retrieve named artifacts from buffers | Read from same in-memory Map; reconstructed on session events |
| STATE-03 | Store state persists across branch forks via `result.details` snapshots | Pi's canonical pattern: every tool returns full state snapshot in `details`; `session_start/switch/fork/tree` events trigger reconstruction from `getBranch()` |
| STATE-04 | All tool outputs truncate gracefully with truncation signal when exceeding Pi limits | Pi exports `truncateHead`, `truncateTail`, `DEFAULT_MAX_BYTES` (50KB), `DEFAULT_MAX_LINES` (2000) from `@mariozechner/pi-coding-agent` |
</phase_requirements>

## Summary

Phase 1 builds the document store and four tools (`rlm_load`, `rlm_search`, `rlm_extract`, `rlm_save`/`rlm_get`) as a Pi extension. The implementation follows patterns that are already established in this codebase: Pi's `ExtensionAPI`, TypeBox schemas, `result.details` for branch-safe state, and `truncateHead`/`truncateTail` for output bounds.

The primary technical decisions are: (1) **MiniSearch 7.2.0** for BM25+ search — it serializes to JSON cleanly, has native TypeScript types, and no external binary dependencies; (2) **manual chunking logic** for content-aware splitting — no chunking library handles code boundary detection well enough to avoid hand-rolling the language-specific splitter; (3) **Node.js `crypto.createHash`** for stable chunk IDs — zero additional dependency.

State persistence follows the canonical Pi pattern demonstrated in `todo.ts` example: every mutating tool call returns the complete current state in `details`, and `session_start`, `session_switch`, `session_fork`, and `session_tree` events reconstruct in-memory state by scanning `getBranch()` for `toolResult` messages. This gives branch safety for free — a forked branch's history ends at the fork point, so reconstruction yields the correct snapshot.

**Primary recommendation:** Build as a single multi-file extension in `.pi/extensions/pi-rlm/` (or `~/.pi/agent/extensions/pi-rlm/`), with MiniSearch as the only new external dependency.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@mariozechner/pi-coding-agent` | 0.52.12 (already installed) | ExtensionAPI, truncation utils, TypeBox | Already in project; extension entry point |
| `@mariozechner/pi-ai` | 0.52.12 (already installed) | `StringEnum` for Google-compatible enums | Required for pi tool parameters |
| `@sinclair/typebox` | (bundled with pi) | Tool parameter schemas | Pi's native schema system |
| `minisearch` | 7.2.0 | BM25+ full-text search, serialize/restore | Pure JS/TS, no binary deps, JSON round-trips cleanly |
| `node:crypto` | built-in | SHA-256 chunk IDs | No dep, stable and fast |
| `node:fs/promises` | built-in | Reading file paths in `rlm_load` | Already available in Node 22 |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `vitest` | 4.0.18 (already installed) | Unit tests for chunker, store, tools | Colocated `*.test.ts` per project convention |
| `oxlint` | 1.47.0 (already installed) | Linting | Run before commit |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| MiniSearch | wink-bm25-text-search | wink requires more boilerplate, no built-in JSON serialization |
| MiniSearch | flexsearch | FlexSearch is faster but doesn't expose BM25 scores and serialization is more complex |
| MiniSearch | hand-rolled BM25 | 200+ lines for correct IDF/TF normalization — don't hand-roll |
| node:crypto | nanoid or uuid | SHA-256 of content gives content-addressed IDs (dedup); UUIDs don't |

**Installation:**
```bash
pnpm add minisearch
```

## Architecture Patterns

### Recommended Project Structure
```
pi-extensions/
└── pi-rlm/
    ├── index.ts         # Extension entry — registers tools, wires lifecycle events
    ├── store.ts         # DocumentStore class (chunks, MiniSearch, buffers)
    ├── chunker.ts       # Content-aware chunking logic (prose + code)
    └── pi-rlm.test.ts   # Colocated unit tests
```

Or as a global extension at `~/.pi/agent/extensions/pi-rlm/index.ts` with the same layout.

### Pattern 1: State Management via `result.details` + Branch Reconstruction

This is the canonical Pi pattern for stateful tools. Every mutating tool call returns the full current state in `details`. On session lifecycle events, reconstruct in-memory state by walking `getBranch()`.

**What:** Store a JSON snapshot of all state (chunks, MiniSearch index, buffers) in the `details` field of every tool result. On `session_start`, `session_switch`, `session_fork`, and `session_tree`, scan the current branch's `toolResult` entries in order and restore from the last snapshot.

**When to use:** Any extension that needs state to survive Pi's branch/fork model. Required here.

**Example (from `todo.ts` in Pi examples, verified directly):**
```typescript
// Source: node_modules/@mariozechner/pi-coding-agent/examples/extensions/todo.ts
const reconstructState = (ctx: ExtensionContext) => {
  // Reset then replay from branch history
  store.reset();
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (msg.role !== "toolResult" || msg.toolName !== "rlm_load") continue;
    const details = msg.details as RlmLoadDetails | undefined;
    if (details?.snapshot) store.restore(details.snapshot);
  }
};

pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
pi.on("session_switch", async (_event, ctx) => reconstructState(ctx));
pi.on("session_fork", async (_event, ctx) => reconstructState(ctx));
pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));
```

**Critical insight:** `getBranch()` returns only entries on the current branch path. When a session is forked, the new branch's `getBranch()` ends at the fork point — so reconstruction automatically yields the correct pre-fork snapshot without any special fork handling.

### Pattern 2: MiniSearch Index Serialization

MiniSearch serializes to plain JSON via `JSON.stringify(index)` and restores via `MiniSearch.loadJSON(json, config)`. This is what goes into `details.snapshot.searchIndexJson`.

```typescript
// Source: https://lucaong.github.io/minisearch/classes/MiniSearch.MiniSearch.html
// Serialize:
const json = JSON.stringify(miniSearch);

// Restore (must use same config as original creation):
const miniSearch = MiniSearch.loadJSON(json, {
  fields: ["text"],
  storeFields: ["chunkId", "docId", "docName"],
});
```

**Important:** The MiniSearch config (fields, storeFields, searchOptions) must be identical between serialization and restoration. Hard-code it as a constant.

### Pattern 3: Content-Aware Chunking

No library handles code boundary detection adequately — this is hand-rolled but straightforward.

**Strategy:**
1. Detect document type: explicit `type` param → file extension → heuristic (presence of `def`, `class`, `function`, `fn`, `struct` keywords)
2. **Prose/Markdown:** Split on paragraph boundaries (`\n\n`), then merge until chunk size reached, with overlap via trailing sentences
3. **Code:** Split on top-level function/class definitions using language-specific regex patterns; fall back to paragraph-style splitting if no boundaries found; if a single function exceeds chunk size, split at line boundaries within it

**Chunk size recommendation:** 1500 characters default (roughly 375 tokens), 200-character overlap. This is within MiniSearch's optimal range and keeps Pi tool output manageable. Configurable per-load.

### Pattern 4: Hash-Based Chunk IDs

```typescript
// Source: Node.js built-in crypto
import { createHash } from "node:crypto";

function chunkId(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
```

16 hex characters (8 bytes) is sufficient — collision probability is negligible for session-scale document sets.

### Pattern 5: Tool Response Envelope

All tools return a consistent shape. The `{ ok, data, meta }` envelope is user-decided:

```typescript
interface RlmResult<T> {
  ok: boolean;
  data: T;
  meta: { truncated: boolean; [key: string]: unknown };
}
```

The `content` field (what the LLM sees) is formatted text. The `details` field carries the state snapshot.

### Anti-Patterns to Avoid
- **Storing chunks only in MiniSearch `storeFields`:** MiniSearch `storeFields` stores document fields at index time. For raw chunk text retrieval by ID (needed for `rlm_extract`), maintain a separate `Map<chunkId, ChunkRecord>`. MiniSearch is for search only.
- **Storing full chunk content in `details` as a raw array:** This bloats the session file. Store the serialized MiniSearch index JSON plus the chunk map as a single JSON blob. Be wary of size.
- **Reconstructing state from ALL entries instead of `getBranch()`:** `getEntries()` includes all branches; `getBranch()` returns only the current branch path. Always use `getBranch()` for reconstruction.
- **Not handling batch-load atomicity:** The user decision is all-or-nothing batch loading. Validate and read all files before mutating any store state.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| BM25 scoring | Custom IDF/TF algorithm | MiniSearch 7.2.0 | Correct BM25+ normalization handles edge cases (zero-length docs, single-term corpus) that are easy to get wrong |
| JSON serialization | Custom format | `JSON.stringify` / `JSON.parse` | MiniSearch's `toJSON()` is already the integration point |
| Output truncation | Custom byte counter | `truncateHead`/`truncateTail` from `@mariozechner/pi-coding-agent` | Pi exports these with the exact limits that match Pi's enforced caps |

**Key insight:** The chunking logic is the one piece that must be custom — no library handles "split at function boundaries for Python, class boundaries for TypeScript, paragraph boundaries for Markdown" without a dependency like tree-sitter (which would be a massive dep). Keep the chunker simple: regex-based boundary detection, not AST parsing.

## Common Pitfalls

### Pitfall 1: State Snapshot Size Budget
**What goes wrong:** Including full chunk text in every tool's `details` means the session file grows O(n_chunks * n_tool_calls). A 100KB document split into ~67 chunks, loaded once, is already 100KB in details. After 10 tool calls, the session has 1MB of repeated chunk data.
**Why it happens:** The naive pattern copies the entire store into every `details`.
**How to avoid:** Only the LAST tool result in a branch needs a valid snapshot for reconstruction. But Pi writes every tool result to disk. Keep snapshot size bounded: serialize only chunk IDs + content hashes for fast dedup check, plus the MiniSearch index JSON. Store raw chunk text in a session-scoped in-memory map rebuilt from the stored content only when needed. Alternatively, only emit a fresh snapshot from `rlm_load` calls (the only tool that changes the chunk store); `rlm_search`, `rlm_extract`, `rlm_save`/`rlm_get` emit minimal details.
**Warning signs:** Session `.jsonl` file grows beyond 10MB after a few loads.

### Pitfall 2: MiniSearch Config Mismatch on Restore
**What goes wrong:** `MiniSearch.loadJSON` throws or returns wrong results if the config differs from what was used to create the index.
**Why it happens:** Config is passed separately from the serialized data.
**How to avoid:** Define `MINISEARCH_CONFIG` as a single exported constant. Use it in both `new MiniSearch(MINISEARCH_CONFIG)` and `MiniSearch.loadJSON(json, MINISEARCH_CONFIG)`. Never inline the config.

### Pitfall 3: Forgetting `session_tree` Event
**What goes wrong:** Agent navigates to an earlier point in the session tree; state doesn't rewind to match.
**Why it happens:** Developers handle `session_fork` but miss `session_tree` (in-place navigation).
**How to avoid:** Always register all four events: `session_start`, `session_switch`, `session_fork`, `session_tree`. The `todo.ts` example in Pi's own examples does all four.

### Pitfall 4: Chunk ID Collision from Truncated Hash
**What goes wrong:** Two different chunks get the same 8-byte hash prefix (unlikely but possible in large document sets).
**Why it happens:** Truncating SHA-256 to too few bytes increases collision probability.
**How to avoid:** 16 hex characters (8 bytes) gives 1-in-18-quintillion collision probability — sufficient. Don't go below 12.

### Pitfall 5: Batch Load Partial State on File Read Error
**What goes wrong:** First file loads, second file fails, store is in partial state.
**Why it happens:** Naive sequential loading mutates state before all files are validated.
**How to avoid:** Read and chunk all inputs first, then apply all to the store atomically. The user decision is explicit: all-or-nothing.

### Pitfall 6: `StringEnum` vs `Type.Union` for Tool Params
**What goes wrong:** Google's API rejects tools using `Type.Union`/`Type.Literal` for string enums.
**Why it happens:** Google requires OpenAPI-style enum arrays, not JSON Schema `anyOf`.
**How to avoid:** Always use `StringEnum` from `@mariozechner/pi-ai` for string enum parameters. The exa-search extension in this project demonstrates this correctly.

## Code Examples

Verified patterns from official sources and codebase:

### Tool Registration Pattern (from exa-search.ts in this project)
```typescript
// Source: /pi-extensions/exa-search.ts
import { StringEnum, Type } from "@mariozechner/pi-ai";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function rlmExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "rlm_load",
    label: "RLM Load",
    description: "Load a document into the RLM store",
    parameters: Type.Object({
      source: Type.String({ description: "File path or raw content string" }),
      type: Type.Optional(StringEnum(["python", "typescript", "markdown", "text"] as const)),
      name: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      // ... implementation
      return {
        content: [{ type: "text", text: "Loaded 42 chunks" }],
        details: { snapshot: store.snapshot() },
      };
    },
  });
}
```

### State Reconstruction Pattern (from todo.ts Pi example — canonical)
```typescript
// Source: node_modules/@mariozechner/pi-coding-agent/examples/extensions/todo.ts
pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
pi.on("session_switch", async (_event, ctx) => reconstructState(ctx));
pi.on("session_fork", async (_event, ctx) => reconstructState(ctx));
pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

const reconstructState = (ctx: ExtensionContext) => {
  store.reset();
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (msg.role !== "toolResult") continue;
    // Only rlm_load mutates the chunk store — reconstruct from last snapshot
    if (msg.toolName === "rlm_load" || msg.toolName === "rlm_save") {
      const details = msg.details as RlmDetails | undefined;
      if (details?.snapshot) store.restore(details.snapshot);
    }
  }
};
```

### Output Truncation (from exa-search.ts in this project)
```typescript
// Source: /pi-extensions/exa-search.ts
import { truncateHead, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES, formatSize } from "@mariozechner/pi-coding-agent";

const truncation = truncateHead(outputText, {
  maxLines: DEFAULT_MAX_LINES,
  maxBytes: DEFAULT_MAX_BYTES,
});

let result = truncation.content;
if (truncation.truncated) {
  result += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines`;
  result += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
}
```

### MiniSearch Setup (from official docs, version 7.2.0)
```typescript
// Source: https://lucaong.github.io/minisearch/classes/MiniSearch.MiniSearch.html
import MiniSearch from "minisearch";

const SEARCH_CONFIG = {
  fields: ["text"],
  storeFields: ["chunkId", "docId", "docName", "charStart", "charEnd"],
  searchOptions: { boost: { text: 1 }, prefix: false, fuzzy: false },
} as const;

// Create
const index = new MiniSearch(SEARCH_CONFIG);
index.add({ id: chunkId, text: chunkText, chunkId, docId, docName, charStart, charEnd });

// Serialize (goes into details.snapshot.searchIndexJson)
const json = JSON.stringify(index);

// Restore (must use same SEARCH_CONFIG)
const index = MiniSearch.loadJSON(json, SEARCH_CONFIG);
```

### Chunk ID Generation
```typescript
// Source: Node.js built-in — no external reference needed
import { createHash } from "node:crypto";

function makeChunkId(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
```

### ToolResultMessage Type (from Pi SDK types — verified in node_modules)
```typescript
// Source: node_modules/.pnpm/@mariozechner+pi-ai@0.52.12/.../types.d.ts
interface ToolResultMessage<TDetails = any> {
  role: "toolResult";
  toolCallId: string;
  toolName: string;           // Match on this for reconstruction
  content: (TextContent | ImageContent)[];
  details?: TDetails;         // Your state snapshot lives here
  isError: boolean;
  timestamp: number;
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| BM25 (classic) | BM25+ (improved lower-bound) | MiniSearch v6+ | Better scoring for short queries; no action needed, MiniSearch handles it |
| Separate search index serialization formats | `JSON.stringify(miniSearch)` round-trip | MiniSearch v6 | Simple, no custom serializer needed |
| LangChain-style chunkers with tokenizer deps | Character-based chunking with code boundary detection | Current best practice for extension context | No tokenizer dep; character counts are predictable |

**Deprecated/outdated:**
- `flexsearch`: Doesn't expose BM25 scores; serialization format changed across versions; not suitable here
- `lunr.js`: No longer maintained; no BM25 by default

## Open Questions

1. **Snapshot size with large documents**
   - What we know: A 100KB document produces ~67 chunks at 1500 chars each. MiniSearch's serialized index for 67 documents is typically 50-150KB depending on term frequency.
   - What's unclear: Whether the session `.jsonl` file becomes unmanageable after multiple large documents. Pi's compaction may help, but the behavior with 50KB+ details entries is untested.
   - Recommendation: In Phase 1, emit the full snapshot in `rlm_load` details only. For `rlm_search`/`rlm_extract`, include only a minimal `{ truncated: boolean, query: string }` in details — no snapshot. This limits snapshot writes to load operations only. Validate with a realistic 100KB file as noted in STATE.md.

2. **Behavior of `rlm_save`/`rlm_get` details (Claude's Discretion)**
   - What we know: STATE-01/02 require named artifact buffers. The buffer state (Map<name, value>) must also be branch-safe.
   - What's unclear: Whether buffers should be merged into the same snapshot as the chunk store, or tracked separately.
   - Recommendation: Merge into a single snapshot object: `{ chunks: ChunkMap, searchIndex: string, buffers: Record<string, unknown> }`. Emit on every `rlm_save` call. This keeps reconstruction logic uniform.

3. **`rlm_extract` character range mode (Claude's Discretion)**
   - What we know: DOC-04 says "by chunk ID or character range." Character ranges require knowing the source document's character offsets.
   - What's unclear: Whether character ranges are relative to the original document or to a specific chunk.
   - Recommendation: Character ranges are relative to the original document. Store `charStart`/`charEnd` per chunk (the document offset of that chunk's content). `rlm_extract` with a range walks chunks to find overlapping ones and reconstructs the span. Chunk ID extraction is simpler — return the chunk directly.

## Sources

### Primary (HIGH confidence)
- Pi SDK source (node_modules/@mariozechner/pi-coding-agent) — ExtensionAPI, state management, truncation utilities, `ToolResultMessage` type, `getBranch()` API
- Pi examples (node_modules/…/examples/extensions/todo.ts) — canonical state management pattern, all four lifecycle events
- Project source (/pi-extensions/exa-search.ts, /pi-extensions/sound-notifications.ts) — tool registration conventions, `StringEnum` usage, truncation pattern
- MiniSearch docs (https://lucaong.github.io/minisearch/) — `toJSON`/`loadJSON` API, version 7.2.0 confirmed

### Secondary (MEDIUM confidence)
- npm search results for BM25 TypeScript libraries (2025) — confirms MiniSearch as ecosystem standard for pure-JS BM25
- MiniSearch npm page — version 7.2.0, TypeScript-native

### Tertiary (LOW confidence)
- WebSearch results for TypeScript chunking libraries — informed the decision NOT to use an external chunker (none handle code boundary detection without tree-sitter)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — Pi API verified from installed package types and examples; MiniSearch version confirmed from official docs
- Architecture: HIGH — State management pattern taken directly from Pi's own `todo.ts` example; chunk ID pattern is Node.js built-in
- Pitfalls: MEDIUM — Snapshot size concern is based on arithmetic; actual behavior with large sessions needs validation (noted as open question)

**Research date:** 2026-02-24
**Valid until:** 2026-05-24 (stable: Pi SDK version pinned in package.json; MiniSearch API is stable)
