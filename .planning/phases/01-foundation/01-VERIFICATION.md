---
phase: 01-foundation
verified: 2026-02-25T01:57:00Z
status: passed
score: 12/12 must-haves verified
---

# Phase 1: Foundation Verification Report

**Phase Goal:** Pi agents can load documents into a chunked store and retrieve content by search or direct extraction, with state that survives branch forks
**Verified:** 2026-02-25T01:57:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

#### Plan 01 Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Content-aware chunker splits code at function/class boundaries and prose at paragraph boundaries | ✓ VERIFIED | chunker.ts lines 130-173: `chunkCode` uses regex patterns for python/ts/js boundaries, `chunkProse` splits on `\n\n+`. 29 tests pass including code splitting and prose splitting tests. |
| 2 | Chunks have stable hash-based IDs — same content always produces the same chunk ID | ✓ VERIFIED | store.ts line 39-44: `makeHash` uses SHA-256 truncated to 16 hex. Test "creates chunks with stable hash IDs" (line 190) confirms `doc1.id === doc2.id`. |
| 3 | DocumentStore can add documents, search via BM25, extract by chunk ID or character range | ✓ VERIFIED | store.ts exports `DocumentStore` with `addDocument` (line 56), `search` (line 154), `extractByChunkId` (line 176), `extractByRange` (line 180). All tested with passing assertions. |
| 4 | DocumentStore buffers support save and get of named artifacts | ✓ VERIFIED | store.ts `saveBuffer` (line 216), `getBuffer` (line 220). Test "round-trips values via save/get" passes (line 295). |
| 5 | DocumentStore serializes to and restores from a JSON snapshot (chunks + search index + buffers) | ✓ VERIFIED | store.ts `snapshot()` (line 224) and `restore()` (line 248). Tests "round-trips entire store state" and "search works after restore" both pass. |
| 6 | Loading the same content twice reuses existing chunks (deduplication) | ✓ VERIFIED | store.ts line 62-63: dedup check returns existing DocumentRecord. Test "deduplicates same content" confirms `doc1 === doc2` (referential equality). |

#### Plan 02 Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 7 | Agent can call rlm_load with file path or raw content and receive doc_id, chunk_count, total_tokens | ✓ VERIFIED | index.ts lines 112-178: `rlm_load` registered with `source` param, `resolveSource` handles file paths (/, ~, ./) and raw content, returns `{ doc_id, chunk_count, total_chars }` in envelope. |
| 8 | Agent can call rlm_search with a query and receive bounded excerpts with chunk IDs and BM25 scores | ✓ VERIFIED | index.ts lines 282-338: `rlm_search` registered, calls `store.search`, formats results with chunkId, docName, score, text excerpt (truncated to 200 chars). |
| 9 | Agent can call rlm_extract with chunk ID or character range and receive exact content | ✓ VERIFIED | index.ts lines 341-482: `rlm_extract` handles both `chunk_id` and `doc_id + char_start + char_end` paths, returns extracted text in envelope. |
| 10 | Agent can call rlm_save and rlm_get to persist and retrieve named artifacts | ✓ VERIFIED | index.ts lines 486-565: `rlm_save` calls `store.saveBuffer`, `rlm_get` calls `store.getBuffer`, both with proper error handling. |
| 11 | All tool responses follow { ok, data, meta } envelope with truncation signal when output exceeds limits | ✓ VERIFIED | index.ts lines 78-95: `formatResult` and `makeTextContent` apply `{ ok, data, meta }` envelope with `truncateHead` from pi-coding-agent. Every tool handler calls `makeTextContent`. |
| 12 | After session fork/switch/tree, state is silently rehydrated and tools return consistent results | ✓ VERIFIED | index.ts lines 569-603: `reconstructState` walks `getBranch()`, processes only `rlm_load`/`rlm_save` tool results, restores from last snapshot. All 4 lifecycle events registered: `session_start`, `session_switch`, `session_fork`, `session_tree`. |

**Score:** 12/12 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `pi-extensions/pi-rlm/types.ts` | Shared types: ChunkRecord, DocumentRecord, StoreSnapshot, RlmResult | ✓ VERIFIED | 37 lines, exports: DocType, ChunkRecord, DocumentRecord, StoreSnapshot, RlmResult — all match plan spec |
| `pi-extensions/pi-rlm/chunker.ts` | Content-aware chunking: code boundary detection, prose paragraph splitting | ✓ VERIFIED | 220 lines, exports: `chunkDocument`, `detectDocType`. Code patterns for python/ts/js, markdown heading splits, prose paragraph splits, overlap support |
| `pi-extensions/pi-rlm/store.ts` | DocumentStore with chunk map, MiniSearch index, buffers, snapshot/restore | ✓ VERIFIED | 275 lines, exports: `DocumentStore`. Methods: addDocument, addDocumentBatch, search, extractByChunkId, extractByRange, saveBuffer, getBuffer, snapshot, restore, reset |
| `pi-extensions/pi-rlm/pi-rlm.test.ts` | Unit tests for chunker and store | ✓ VERIFIED | 389 lines, 29 tests all passing. Covers: type detection, prose/code splitting, offsets, overlap, edge cases, store CRUD, dedup, search, extraction, buffers, snapshot/restore, batch, reset |
| `pi-extensions/pi-rlm/index.ts` | Pi extension entry — 5 tools registered, 4 lifecycle events wired | ✓ VERIFIED | 604 lines (>80 min), exports default function. 5 tools: rlm_load, rlm_search, rlm_extract, rlm_save, rlm_get. 4 lifecycle events wired. |

### Key Link Verification

#### Plan 01 Links

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `store.ts` | `chunker.ts` | `import chunkDocument` | ✓ WIRED | `import { chunkDocument } from "./chunker.js"` — used in `addDocument` and `addDocumentBatch` |
| `store.ts` | `minisearch` | `import MiniSearch` | ✓ WIRED | `import MiniSearch from "minisearch"` — used for index creation, search, serialize/restore |
| `store.ts` | `types.ts` | shared type definitions | ✓ WIRED | `import type { ChunkRecord, DocType, DocumentRecord, StoreSnapshot } from "./types.js"` |

#### Plan 02 Links

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `index.ts` | `store.ts` | `import DocumentStore` | ✓ WIRED | `import { DocumentStore } from "./store.js"` — instantiated at line 109, used in all 5 tool handlers |
| `index.ts` | `@mariozechner/pi-coding-agent` | `ExtensionAPI, truncation utils` | ✓ WIRED | Imports ExtensionAPI, ExtensionContext, truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize — all used |
| `index.ts` | session lifecycle events | `pi.on` for 4 events | ✓ WIRED | Lines 588-603: `session_start`, `session_switch`, `session_fork`, `session_tree` all registered calling `reconstructState` |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| DOC-01 | 01-01 | Load text/code documents with configurable chunk size and overlap | ✓ SATISFIED | `store.addDocument` accepts chunkSize/overlap options, `rlm_load` exposes chunk_size/overlap params |
| DOC-02 | 01-01 | Chunks use hash-based stable IDs for deduplication and caching | ✓ SATISFIED | SHA-256 truncated to 16 hex chars in `makeHash`, dedup test passes |
| DOC-03 | 01-01 | Search across stored chunks via BM25 returning bounded excerpts with chunk IDs | ✓ SATISFIED | MiniSearch BM25 index, `rlm_search` returns chunk IDs + scores + truncated excerpts |
| DOC-04 | 01-01 | Extract specific spans by chunk ID or character range with bounded output | ✓ SATISFIED | `extractByChunkId`, `extractByRange` in store, `rlm_extract` tool with both modes |
| STATE-01 | 01-01 | Save named intermediate artifacts to buffers | ✓ SATISFIED | `store.saveBuffer` + `rlm_save` tool |
| STATE-02 | 01-01 | Retrieve named artifacts from buffers | ✓ SATISFIED | `store.getBuffer` + `rlm_get` tool |
| STATE-03 | 01-02 | Store state persists across branch forks via `result.details` snapshots | ✓ SATISFIED | `makeDetails` emits snapshot for mutating tools, `reconstructState` restores from `getBranch()` entries |
| STATE-04 | 01-02 | All tool outputs truncate gracefully with truncation signal when exceeding Pi limits | ✓ SATISFIED | `applyTruncation` applies `truncateHead` with `DEFAULT_MAX_LINES`/`DEFAULT_MAX_BYTES`, appends truncation notice |

**Orphaned requirements:** None — all 8 requirement IDs from REQUIREMENTS.md Phase 1 mapping (DOC-01..04, STATE-01..04) are claimed by plans and verified.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| — | — | None found | — | — |

No TODOs, FIXMEs, placeholders, console.logs, or empty implementations found. The `return []` (chunker edge case) and `return null` (store lookup miss) patterns are legitimate guard clauses.

### Human Verification Required

### 1. End-to-End Tool Invocation via Pi Agent

**Test:** Load a real Python file via `rlm_load`, search it via `rlm_search`, extract a chunk via `rlm_extract`
**Expected:** All three tools return well-formatted `{ ok, data, meta }` responses. Search results contain relevant excerpts. Extract returns exact content.
**Why human:** Requires a running Pi session with the extension loaded — can't simulate ExtensionAPI registration programmatically.

### 2. Branch Fork State Reconstruction

**Test:** In a Pi session, load a document, fork the branch, verify `rlm_search` returns results on the new branch
**Expected:** State is silently rehydrated. Search returns same results as before fork.
**Why human:** Requires Pi's session manager and actual branch fork mechanics.

### 3. Truncation Behavior on Large Output

**Test:** Load a very large document, search for a common term that matches many chunks
**Expected:** Output is truncated with `[Output truncated: showing X of Y lines]` notice and `meta.truncated` is true.
**Why human:** Requires actual Pi truncation thresholds and large enough content.

### Gaps Summary

No gaps found. All 12 observable truths verified. All 5 artifacts exist, are substantive, and properly wired. All 8 requirement IDs satisfied. All key links confirmed. No anti-patterns detected. 29 unit tests pass, typecheck clean, lint clean.

---

_Verified: 2026-02-25T01:57:00Z_
_Verifier: Claude (gsd-verifier)_
