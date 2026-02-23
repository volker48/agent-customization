# Feature Research

**Domain:** Long-context processing extension for LLM coding agents (RAG + orchestration)
**Researched:** 2026-02-23
**Confidence:** MEDIUM — web access unavailable; based on training knowledge of LangChain, LlamaIndex, MemGPT, and established RAG patterns through mid-2025. Well-established domain with stable feature taxonomy.

---

## Feature Landscape

### Table Stakes (Users Expect These)

Features that any long-context tool must have. Missing one makes the tool feel broken.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Document loading (text/code) | No tool is useful without ingestion | LOW | Must handle plain text, markdown, source files. Binary formats (PDF, DOCX) are table stakes for general RAG but out of scope here — coding agent context is text/code |
| Fixed-size chunking with overlap | Baseline chunking strategy; every RAG tutorial starts here | LOW | Overlap prevents answer loss at boundaries. Chunk size and overlap must be configurable |
| Keyword/substring search across chunks | Users expect to grep stored content | LOW | Even before semantic search, lexical search is expected. Returns ranked results by relevance |
| Bounded excerpt retrieval | Returning raw chunks; must not overflow context | LOW | Output must be predictably small. Fixed character/line limits are non-negotiable given Pi's 50KB cap |
| Named buffer / artifact storage | "Save this result and reuse it" — basic intermediate state | LOW | Users expect to name and retrieve saved outputs. Required for multi-step agent work |
| Query over stored documents | The primary reason to ingest anything | MEDIUM | `rlm_query` or equivalent must accept a question, retrieve relevant context, and return an answer |
| Sub-call isolation (no tool access) | Expected safety property: sub-agents don't accidentally recurse | MEDIUM | Sub-calls in RLM workloads must not be able to call the parent's tools — prevents infinite loops |
| Output truncation with signal | Any tool output that can overflow must truncate gracefully and say so | LOW | Must include `truncated: true` and a count of omitted items. Silent truncation causes agent confusion |
| State persistence across sessions | Agent state must survive conversation branches and forks | MEDIUM | Pi's branch/fork model means state stored in memory dies; must use `result.details` snapshots |

### Differentiators (Competitive Advantage)

Features that move pi-rlm from "another RAG tool" to "the right tool for coding agents."

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Map-reduce orchestration mode | Process all chunks in parallel then synthesize; handles "summarize this entire codebase" queries | HIGH | Requires bounded concurrency, per-chunk sub-calls, final reduce step. Most RAG tools do this serially |
| Selective orchestration mode | Search-narrowed sub-calls; only process relevant chunks; far cheaper than map-reduce | MEDIUM | Search first, pass only top-K chunks to sub-call. Dramatically reduces latency and cost for targeted questions |
| Tree (hierarchical) orchestration mode | Recursive summarization for ultra-long inputs; builds a summary tree bottom-up | HIGH | Tree reduces a 1M-token document to a single answer without any single sub-call seeing the full document |
| Per-chunk sub-call caching (by hash) | Same chunk + same instruction = reuse cached output; huge speedup on repeated queries | MEDIUM | Cache key = hash(chunk_content) + hash(instruction). Cache must survive across tool invocations within a session |
| Context pressure hook | Proactive hint to agent when context is getting full: "consider using rlm_query" | LOW | `pi.on()` lifecycle hook that monitors token usage and injects guidance. Prevents agent from silently degrading |
| Auto-load hook for large pastes | Detect when user pastes a huge document and offer to externalize it automatically | MEDIUM | `pi.on('user_message')` or equivalent; measure paste size; offer to call `rlm_load` on the user's behalf |
| Chunk-ID-based span extraction | "Give me chunk 14-17" — direct extraction without search | LOW | Enables agent to re-read specific spans it already knows about from a prior search result |
| Citation-backed answers | Each answer includes which chunk IDs it was derived from | LOW | Agent can follow up with `rlm_extract` on cited chunks. No other coding agent extension does this routinely |
| Structured JSON sub-call outputs | Sub-calls return typed JSON, not free-form text — enables reliable downstream parsing | LOW | Requires sub-call prompt to demand a JSON schema. Prevents agent from having to parse unstructured LLM prose |
| Bounded concurrency on parallel sub-calls | Map-reduce doesn't spawn unlimited goroutines; respects system limits | LOW | Simple semaphore/queue. Without it, map-reduce on a 500-chunk doc would make 500 simultaneous API calls |

### Anti-Features (Commonly Requested, Often Problematic)

Features that seem like natural extensions but create disproportionate complexity or conflict with the extension model.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Semantic / vector embedding search | "RAG needs embeddings" — common assumption from LangChain tutorials | Requires an embedding model or external API (OpenAI, local), adds a hard runtime dependency, and introduces the cold-start problem. Lexical + BM25 search is sufficient for code/document retrieval in a coding agent context where queries are specific | Use lexical search + keyword expansion. If semantic search is later needed, add it as an optional backend, not a requirement |
| Persistent disk-based vector store | "Store embeddings to disk for reuse across sessions" | Pi is an interactive coding agent, not a long-running service. A disk store creates schema migration, versioning, and cleanup problems. Sessions are short-lived | Use in-memory store per session, persist only named buffers via `result.details` |
| Full-repo indexing at startup | "Index the whole project on load so everything is searchable" | Expensive upfront cost (minutes for large repos), requires file watcher for invalidation, and makes the extension feel slow to start | Offer `rlm_load` as an explicit user action. Let the agent decide what to index |
| Real-time streaming sub-call results | "Stream tokens from sub-calls as they arrive" | Pi's tool return model is synchronous; streaming sub-call output conflicts with the structured JSON return contract and makes result caching impossible | Return complete results. Use bounded concurrency to keep wall time acceptable |
| Automatic re-chunking on context overflow | "If a chunk is still too big, split it again automatically" | Multi-level dynamic chunking is complex to reason about and can produce inconsistent chunk IDs between runs, breaking caching | Set a conservative fixed chunk size (e.g., 4000 chars) that is always safely under the sub-call context limit. Warn if a document produces abnormally large chunks |
| User-facing chunk management UI | "Let users browse, delete, or rename chunks" | Scope creep. The agent is the user-facing interface; direct chunk management is a dev/debug concern | Expose chunk metadata via `rlm_list` for agent use only. Phase 2: add `/rlm` command for humans if needed |
| Cross-session persistent memory | "Remember things from last week's session" | Pi sessions are not designed for cross-session state. Implementing this requires a persistence backend, user identity, and a security model outside Pi's current design | Scope to within-session buffers only. Long-term memory is a separate product concern |

---

## Feature Dependencies

```
rlm_load (document loading + chunking)
    └──required by──> rlm_search (needs a store to search)
    └──required by──> rlm_extract (needs stored chunks to extract from)
    └──required by──> rlm_query (needs stored chunks to query over)

rlm_search
    └──used by──> selective mode (search-narrowed orchestration)
    └──used by──> citation-backed answers

rlm_extract
    └──used by──> citation-backed answers (agent follows up on cited chunks)

rlm_query (orchestration entry point)
    └──requires──> sub-call isolation (sub-agents must be tool-less)
    └──requires──> bounded concurrency (for map-reduce and tree modes)

sub-call caching
    └──requires──> chunk hashing (stable chunk IDs)
    └──enhances──> map-reduce mode (eliminates redundant sub-calls on repeated queries)

per-chunk sub-call caching
    └──requires──> stable chunk IDs (chunk identity must not change between calls)

context pressure hook
    └──enhances──> rlm_query (makes agent more likely to use it proactively)

auto-load hook
    └──requires──> rlm_load (hooks into the same loading pipeline)

state persistence (result.details snapshots)
    └──required by──> named buffers (rlm_save / rlm_get)
    └──required by──> chunk store rehydration across branch forks
```

### Dependency Notes

- **rlm_load is the foundation**: nothing else works without it. Must be the first tool implemented and validated.
- **Sub-call isolation is a prerequisite for rlm_query**: orchestration modes cannot be built safely until the sub-call pattern is validated to actually prevent tool recursion.
- **Caching requires stable chunk IDs**: if chunk IDs are not deterministic (same document = same IDs on re-load), caching will produce stale results. Hash-based IDs are required.
- **Context pressure hook is independent**: it does not depend on any other RLM tool. Can be implemented and tested in isolation.
- **Auto-load hook depends on rlm_load**: it's a thin wrapper that calls rlm_load on the user's behalf; implement rlm_load first.

---

## MVP Definition

### Launch With (v1)

Minimum viable product — validates the core "load big thing, ask questions about it" workflow.

- [ ] `rlm_load` — document loading with fixed-size chunking and overlap; returns chunk count and IDs
- [ ] `rlm_search` — lexical search across stored chunks; returns bounded list of excerpts with chunk IDs
- [ ] `rlm_extract` — retrieve specific chunk by ID or character range; returns bounded text
- [ ] `rlm_save` / `rlm_get` — named buffer storage for intermediate artifacts
- [ ] `rlm_query` with selective mode — search-narrowed orchestration; most useful for targeted questions
- [ ] `rlm_query` with map_reduce mode — broad synthesis over all chunks; needed for summarization
- [ ] `rlm_query` with tree mode — hierarchical summarization; needed for very large documents
- [ ] Sub-call isolation — sub-agents are tool-less in-process Pi SDK sessions
- [ ] Per-chunk caching — by hash(chunk) + hash(instruction)
- [ ] Bounded concurrency — cap parallel sub-calls (e.g., 5 concurrent)
- [ ] Output truncation with signal — all tools truncate gracefully with `truncated: true`
- [ ] State persistence via `result.details` — chunk store and named buffers survive branch forks
- [ ] Context pressure hook — detects high context usage and hints agent to use `rlm_query`
- [ ] Auto-load hook — intercepts large pastes and offers to run `rlm_load`

Note: All 14 items are in scope for v1 per PROJECT.md. The "minimum" here is the full set described in the project brief — nothing has been added beyond what was specified.

### Add After Validation (v1.x)

Features to add once core workflow is proven.

- [ ] `/rlm` command interface — human-friendly CLI for status, listing chunks, GC
- [ ] `rlm_trace` tool — expose sub-call trace log for debugging orchestration failures
- [ ] `rlm_gc` — garbage-collect stale chunks and buffers from session store

### Future Consideration (v2+)

Features to defer until product-market fit is established.

- [ ] Repo indexing (`rlm_repo_index`) — index entire codebase on demand; high complexity, niche value
- [ ] CI log triage — specialized orchestration mode for parsing CI failure logs
- [ ] Memory artifact compaction — compress named buffers when they grow large
- [ ] Token-aware chunking — split on token count rather than character count; requires tokenizer dep

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| rlm_load (chunking + store) | HIGH | LOW | P1 |
| rlm_search (lexical) | HIGH | LOW | P1 |
| rlm_extract (by chunk ID) | MEDIUM | LOW | P1 |
| rlm_save / rlm_get (buffers) | MEDIUM | LOW | P1 |
| rlm_query selective mode | HIGH | MEDIUM | P1 |
| rlm_query map_reduce mode | HIGH | HIGH | P1 |
| rlm_query tree mode | MEDIUM | HIGH | P1 |
| Sub-call isolation | HIGH | MEDIUM | P1 — safety prerequisite |
| Per-chunk caching | HIGH | MEDIUM | P1 — needed for map_reduce to be usable |
| Bounded concurrency | HIGH | LOW | P1 — safety prerequisite |
| Output truncation | HIGH | LOW | P1 — Pi hard requirement |
| State persistence (details) | HIGH | MEDIUM | P1 — Pi branch model requires this |
| Context pressure hook | MEDIUM | LOW | P1 — low cost, high discovery value |
| Auto-load hook | MEDIUM | MEDIUM | P1 — improves onboarding significantly |
| /rlm command | LOW | MEDIUM | P2 |
| rlm_trace | MEDIUM | MEDIUM | P2 |
| rlm_gc | LOW | LOW | P2 |
| Repo indexing | MEDIUM | HIGH | P3 |
| Semantic/embedding search | LOW | HIGH | P3 — adds dep, marginal gain for code queries |

---

## Competitor Feature Analysis

Note: There are no direct competitors building a Pi-specific RLM extension. The comparison below covers analogous tools in adjacent spaces.

| Feature | LangChain (Python) | MemGPT / Letta | Our Approach |
|---------|-------------------|----------------|--------------|
| Document loading | Rich loader ecosystem (PDF, web, etc.) | Text-focused, memory segments | Text/code files only; minimizes deps |
| Chunking | Fixed, recursive, semantic | Fixed segments per memory tier | Fixed with overlap; no dep on recursive or semantic |
| Search | Hybrid (lexical + vector) | Lexical only within archival memory | Lexical only for MVP; avoids embedding dep |
| Orchestration modes | Map-reduce, refine, stuff | Single-pass or paged recall | All three modes (selective, map_reduce, tree) in v1 |
| Caching | Per-query result caching (optional) | No caching of sub-results | Per-chunk-instruction hash caching; first-class feature |
| State persistence | External DB / session object | Core design (memory tiers) | Pi `result.details` snapshots; Pi-native approach |
| Context pressure | Manual — user decides when to retrieve | Automatic via memory manager | Automatic hook + manual tools; hybrid |
| Sub-call isolation | N/A (Python functions, not agent sub-calls) | N/A | Pi SDK in-process sessions; novel pattern |
| Output limits | Configurable; no hard cap | Configurable | Hard-limited to Pi's 50KB/2000-line ceiling |
| Tracing/debugging | LangSmith integration | Basic logging | Phase 2: `rlm_trace` tool |

---

## Sources

- Training knowledge of LangChain RAG documentation and source code (through mid-2025) — MEDIUM confidence
- Training knowledge of MemGPT / Letta architecture papers and GitHub (through mid-2025) — MEDIUM confidence
- Training knowledge of LlamaIndex query engine patterns (through mid-2025) — MEDIUM confidence
- PROJECT.md requirements list — HIGH confidence (primary source for scope decisions)
- General RAG/long-context agent patterns from published research (Nakano et al. WebGPT, Guo et al. map-reduce summarization) — MEDIUM confidence

**Verification gaps:** Web access was unavailable during research. The feature taxonomy for RAG tools is stable and well-established; these findings are unlikely to be materially wrong, but current LangChain/LlamaIndex docs should be checked against the chunking and caching claims before Phase 1 implementation decisions are finalized.

---
*Feature research for: pi-rlm — long-context processing extension for Pi coding agent*
*Researched: 2026-02-23*
