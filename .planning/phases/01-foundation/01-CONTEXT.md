# Phase 1: Foundation - Context

**Gathered:** 2026-02-24
**Status:** Ready for planning

<domain>
## Phase Boundary

Document store, chunking pipeline, search/extract tools, and branch-safe state for Pi agents. Agents can load documents into a chunked store and retrieve content by search or direct extraction, with state that survives branch forks. Query orchestration (map_reduce, selective, tree) and lifecycle hooks are separate phases.

</domain>

<decisions>
## Implementation Decisions

### Chunking behavior
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

### Claude's Discretion (Chunking)
- Default chunk size selection
- Chunk size configurability (per-load vs global)
- Overlap strategy and size
- Handling oversized functions that exceed chunk size
- Whether to support unloading documents

### Search interface
- Result count configurable with a sensible default (agent passes optional `limit` parameter)
- Always search across all loaded documents (no per-document scoping)
- BM25 relevance scores exposed to the agent in results
- Plain text queries only — no query operators (AND/OR, phrase matching)
- Always include document source (doc name/ID) in each search result
- Zero results returns empty array with clear message — no suggestions

### Claude's Discretion (Search)
- Exact result shape (snippet vs full chunk, metadata fields)
- rlm_extract modes (chunk ID only vs also character ranges — DOC-04 mentions both)

### Tool response shape
- Consistent response envelope across all tools: `{ ok, data, meta }` pattern
- Smart truncation: truncate at natural boundaries (end of chunk, end of line) with truncation signal
- Silent rehydration on branch fork — agent doesn't know or care state was restored

### Claude's Discretion (Responses)
- Error message verbosity level
- Buffer data types for rlm_save/rlm_get (strings only vs JSON-serializable)

### Branch fork state
- Copy-on-fork model: forked branch gets a frozen snapshot of state at fork time, both branches diverge independently
- Silent rehydration: state restored transparently on forked branch, no agent notification

### Claude's Discretion (Fork State)
- What exactly goes in result.details (full snapshot vs minimal references)
- Size limits or warnings on state snapshots

</decisions>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 01-foundation*
*Context gathered: 2026-02-24*
