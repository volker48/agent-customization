# Project Research Summary

**Project:** pi-rlm — long-context document processing extension for Pi coding agent
**Domain:** LLM coding-agent extension (RAG + orchestration over Pi SDK)
**Researched:** 2026-02-23
**Confidence:** HIGH (stack and architecture verified from installed SDK source; features and pitfalls HIGH/MEDIUM)

## Executive Summary

pi-rlm is a Pi coding-agent extension that provides recursive long-context processing (RLM) — the ability to load large documents, chunk them, and answer questions over them via orchestrated in-process sub-agent sessions. Experts in this space (LangChain, LlamaIndex, MemGPT) build these tools as multi-layer pipelines: ingest/chunk, index, retrieve, orchestrate sub-calls, synthesize. The key insight here is that pi-rlm must do this *inside* Pi's extension model, using Pi SDK in-process sessions rather than external APIs or subprocess spawning — a novel pattern that is the single most important technical risk in the project.

The recommended approach is minimal-dependency and Pi-native: a custom inline character chunker (no LangChain overhead), MiniSearch for lexical BM25 search, p-limit for bounded concurrency, and native Map caches keyed by SHA-256 hash. The entire v1 scope — all 14 features including three orchestration modes (selective, map_reduce, tree), per-chunk caching, branch-safe state persistence, and lifecycle hooks — is achievable without any external services or persistence layers. State is persisted via Pi's `result.details` snapshot pattern on every tool return, which is Pi's canonical approach for branch-safe stateful extensions.

The key risk is early: in-process SDK sessions (`createAgentSession` with `SessionManager.inMemory()`) are not documented for concurrent RLM-scale use. This must be stress-tested as the very first implementation step, before any orchestration code is written. If concurrent sessions fail, the fallback is a sequential queue (slower but correct). All 10 critical pitfalls identified in PITFALLS.md are Phase 1 concerns — there are no "defer until later" pitfalls. Chunking quality, cache key correctness, branch rehydration, and abort propagation must all be correct before any orchestration mode ships.

## Key Findings

### Recommended Stack

The stack is nearly zero-net-new. Pi's existing `@mariozechner/pi-coding-agent@0.52.12` and `@mariozechner/pi-ai@0.52.12` (already installed) provide everything needed for extension registration, sub-agent sessions, TypeBox schemas, and truncation utilities. Only two new production dependencies are required: `MiniSearch@7.2.0` (827KB, BM25 search) and `p-limit@7.3.0` (15KB, bounded concurrency). Everything else — chunking, caching, hashing — is implemented inline using Node.js built-ins.

The critical decision to avoid LangChain's text splitters was validated: `@langchain/textsplitters@1.0.1` pulls in 7.5MB of transitive dependencies including langsmith telemetry, and a 30-line sliding-window chunker is equally effective for Pi's character-based output limits.

**Core technologies:**
- `@mariozechner/pi-coding-agent@0.52.12`: Extension API, sub-agent sessions, truncation — already installed, no install cost
- `@mariozechner/pi-ai@0.52.12`: TypeBox schemas for tool parameters — already installed
- `MiniSearch@7.2.0`: In-process BM25 keyword search — preferred over Fuse.js (no BM25) and FlexSearch (no bundled types)
- `p-limit@7.3.0`: Bounded concurrency for parallel sub-calls — 15KB vs. manual semaphore risk
- `node:crypto` (built-in): SHA-256 chunk+instruction cache keys — zero dependency cost
- Custom inline chunker: 30-line sliding-window splitter — avoids 7.5MB LangChain dep chain
- TypeBox + prompt JSON: Structured sub-call output — no response_format API in Pi SDK; prompt-engineered JSON with AJV validation

**Install command:** `pnpm add minisearch@7.2.0 p-limit@7.3.0`

### Expected Features

All 14 v1 features from PROJECT.md are both required and achievable. There are no features to cut from v1 scope; all are rated P1. FEATURES.md confirms this is the full specified scope, not scope-creep.

**Must have (table stakes):**
- `rlm_load` — document chunking and storage; nothing else works without it
- `rlm_search` — lexical BM25 search over stored chunks; any RAG tool requires this
- `rlm_extract` — retrieve chunk by ID or character range; enables citation follow-up
- `rlm_save` / `rlm_get` — named buffer storage for intermediate artifacts
- `rlm_query` (selective mode) — search-narrowed orchestration; most useful for targeted questions
- `rlm_query` (map_reduce mode) — parallel sub-calls + synthesis; required for broad summarization
- `rlm_query` (tree mode) — hierarchical summarization for very large documents
- Sub-call isolation — tool-less in-process Pi SDK sessions; safety prerequisite
- Per-chunk caching — hash(chunk) + hash(instruction); required for map_reduce to be usable at scale
- Bounded concurrency — cap parallel sub-calls; required before any map_reduce ships
- Output truncation with signal — Pi hard requirement (50KB / 2000-line ceiling)
- State persistence via `result.details` — branch-safe snapshots; Pi's canonical pattern
- Context pressure hook — detects high context usage and hints agent to use `rlm_query`
- Auto-load hook — intercepts large pastes and offers `rlm_load`

**Defer (v2+):**
- `/rlm` command interface — human-friendly CLI for status/GC; low value vs. cost
- `rlm_trace` tool — sub-call trace log for debugging; Phase 2 once modes are working
- `rlm_gc` — garbage collection for stale chunks; low priority for session-scoped store
- Repo indexing — expensive, niche, needs persistent store redesign
- Semantic/embedding search — adds hard external dependency; BM25 is sufficient for code

**Explicit anti-features (never add):**
- Embedding/vector search as default mode — embedding dep introduces cold-start and external API requirement
- Disk-based persistent store — Pi is session-scoped; schema migration complexity is not justified
- Full-repo indexing at startup — expensive, requires file watcher, breaks extension startup time

### Architecture Approach

The architecture is a clean layered extension with five distinct concerns: Tool Layer (5 tools exposed via `pi.registerTool()`), Hook Layer (2 lifecycle hooks), Store Layer (ChunkStore + NamedBuffer as plain Maps), Orchestration Layer (selective/map_reduce/tree as pure async functions), and a Sub-runner (the only Pi SDK-coupled component in orchestration). The layering keeps ChunkStore and the chunker fully Pi-SDK-free — testable in isolation without spawning any sessions.

The defining architectural decision is branch-safe state via `result.details` snapshots: every tool return includes the full store metadata snapshot in `details`, and on every `session_start` event the extension rebuilds in-memory state by walking `ctx.sessionManager.getBranch()`. This eliminates the need for any external persistence layer and integrates naturally with Pi's fork/tree navigation model.

**Major components:**
1. `store/` (ChunkStore + NamedBuffer) — in-memory Maps with branch rehydration from `details` snapshots
2. `chunking/` — pure function `chunkText()` with paragraph-boundary splitting and configurable overlap; no Pi dependency
3. `tools/` — one file per tool; each imports from store + orchestration, Pi coupling only in `execute()`
4. `orchestration/` — three mode functions (selective, map_reduce, tree) plus sub-runner and cache; sub-runner is the only Pi SDK dependent
5. `hooks/` — auto-load (input event) and context-pressure (context event); independent of tools

### Critical Pitfalls

All 10 pitfalls in PITFALLS.md apply to Phase 1. The top 5 with highest project risk:

1. **In-process sub-call session isolation (Pitfall 10)** — Run concurrent session stress test (N=5, N=20) as the very first task before any orchestration code. If concurrent `createAgentSession` calls fail, fall back to sequential queue and redesign concurrency assumptions.

2. **Chunking destroys semantic boundaries (Pitfall 1)** — Do not use byte-boundary splitting. Split on paragraph boundaries first (double newline), then sentence boundaries, then byte limit as emergency fallback. Test on real TypeScript source files with nested closures, not synthetic text.

3. **State rehydration bugs across branches (Pitfall 3)** — Separate "store identity" (what was loaded) from "store availability" (is it in memory now). When a tool finds a stale store ID after branch switch, return a clear actionable error with re-load command. Never return empty results silently.

4. **Output truncation loses most-relevant content (Pitfall 4)** — Structure output answer-first (direct answer, then excerpts by relevance, then metadata). Apply `truncateHead()` after structuring. Pi's `truncateHead()` cuts from the tail — if metadata is at the start, relevant answers are discarded.

5. **Cache key collision or over-invalidation (Pitfall 6)** — Cache key must be `sha256(chunkContent) + ":" + sha256(canonicalInstruction)`. Both components required. Test: same chunk + different instruction = cache miss. Different chunk + same instruction = cache miss. Neither component alone is sufficient.

## Implications for Roadmap

The architecture research provides an explicit build order (ARCHITECTURE.md §Build Order). Research confirms all four phases below are sequentially dependent — you cannot skip ahead.

### Phase 1: Foundation — Core Store, Chunking, and Sub-call Validation

**Rationale:** ChunkStore and the chunker are pure TypeScript with no Pi dependencies — testable immediately. More critically, the in-process sub-call pattern is the single biggest technical risk in the project and must be validated before any orchestration code is written. PITFALLS.md flags this as the very first task of Phase 1.

**Delivers:** A working chunked document store with lexical search, plus validated proof that in-process Pi SDK sessions support concurrent RLM-scale use. If sub-calls don't work concurrently, the fallback is decided here.

**Addresses:** `rlm_load`, `rlm_search`, `rlm_extract`, sub-call isolation validation, `rlm_save`/`rlm_get` (simple, build in parallel), branch-safe `result.details` state model

**Avoids (pitfalls):** Pitfall 10 (sub-call session isolation — validate first), Pitfall 1 (semantic chunking), Pitfall 3 (branch rehydration), Pitfall 4 (output truncation structure), Pitfall 6 (cache key design), Pitfall 7 (JSON extraction layer)

**Research flag:** Phase 1 needs research on `createAgentSession` concurrent behavior limits. The SDK docs are silent on this. Stress test is the only way to know.

### Phase 2: Orchestration — map_reduce Mode with Caching

**Rationale:** map_reduce is the highest-value orchestration mode and the hardest to implement correctly. Caching is required for map_reduce to be usable at scale — without caching, a 200-chunk document re-runs 200 sub-calls on every repeated query. This phase builds on Phase 1's validated sub-runner and store.

**Delivers:** Working `rlm_query` in map_reduce mode with per-chunk caching, bounded concurrency (p-limit), and cost safeguards (max chunk count, cost estimate before dispatch).

**Implements:** `orchestration/map-reduce.ts`, `orchestration/cache.ts`, `orchestration/sub-runner.ts`, `tools/rlm-query.ts` (map_reduce path)

**Avoids (pitfalls):** Pitfall 2 (sub-call prompt engineering — map vs. reduce prompts designed upfront), Pitfall 5 (runaway token cost — chunk limit cap required before shipping), Pitfall 8 (concurrency races — `Promise.allSettled()`, index-based result collection, abort propagation)

**Research flag:** Prompt design for map step (extract JSON schema) and reduce step (aggregate structured data) needs validation against real Pi source files before the orchestration is wired up.

### Phase 3: Orchestration — selective and tree Modes

**Rationale:** selective mode (search-narrowed sub-calls) is cheaper than map_reduce and covers most targeted-question use cases. tree mode (hierarchical summarization) handles the ultra-large-document case. Both reuse the sub-runner and cache from Phase 2. selective mode should default over map_reduce since it dramatically reduces cost.

**Delivers:** Complete `rlm_query` with all three modes. selective becomes the default. tree is available for documents too large for map_reduce.

**Implements:** `orchestration/selective.ts`, `orchestration/tree.ts`, `tools/rlm-query.ts` (mode routing)

**Avoids (pitfalls):** Pitfall 5 (default to selective to avoid runaway costs on large stores), Pitfall 2 (tree mode recursive prompt schema must be defined before any code is written)

**Research flag:** tree mode has no direct Pi SDK reference implementation. The hierarchical reduction pattern is well-documented in RAG literature but the recursive session structure needs careful design.

### Phase 4: Hooks and UX Polish

**Rationale:** Hooks (auto-load, context-pressure) are independent of the tool pipeline and enhance discoverability but are not required for correctness. They are listed as MVP per PROJECT.md but can be built last since they only depend on ChunkStore + chunker (Phase 1 outputs). Building last avoids designing around a broken state model.

**Delivers:** Context pressure hook (warns agent when context is full), auto-load hook (intercepts large pastes), and all output truncation / error message polish (clear re-load-on-branch-error messages, progress feedback for long map_reduce runs).

**Implements:** `hooks/auto-load.ts`, `hooks/context-pressure.ts`, output formatting polish across all tools

**Avoids (pitfalls):** Pitfall 9 (auto-load hook breaks normal pastes — set high threshold ~100KB, test dismiss path explicitly), Pitfall 4 (output structure verification across all tools)

**Research flag:** Pi's `input` event API and `context` event shape need verification against installed SDK source before hook implementation. ARCHITECTURE.md cites these but the hook API signatures need confirmation.

### Phase Ordering Rationale

- **Phase 1 must be first** because ChunkStore, chunking, and sub-call validation are prerequisites for everything else. Branch rehydration must be correct before adding orchestration modes that depend on it.
- **Phase 2 before Phase 3** because selective mode depends on `rlm_search` (Phase 1) and the sub-runner cache (Phase 2). tree mode is a superset of map_reduce. Both inherit Phase 2's concurrency infrastructure.
- **Phase 4 last** because hooks are pure UX enhancement, independent of query correctness. They can be built without waiting for Phase 3 but would be distraction while Phase 2-3 correctness is unresolved.
- **All pitfalls concentrate in Phase 1** — this is a strong signal. Phase 1 is significantly more complex than it appears and should be allocated extra time.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 1:** Concurrent `createAgentSession` behavior under RLM-scale load — no documentation, must stress test. Also: `result.details` size implications for large stores (chunk metadata only, not chunk text).
- **Phase 2:** map_reduce prompt engineering — map schema and reduce schema must be designed and validated against real TypeScript source before pipeline wiring. This is design work, not just coding.
- **Phase 3:** tree mode recursive structure — hierarchical summarization schema needs upfront design; no Pi reference implementation exists.
- **Phase 4:** Pi `input` event and `context` event API surface — verify hook signatures from installed SDK source before writing hook code.

Phases with standard patterns (skip research-phase):
- **Phase 1 — chunking:** Character-based sliding window with paragraph boundaries is well-documented. The inline implementation in STACK.md is sufficient.
- **Phase 1 — store and tools:** Plain Map + TypeBox tool registration is the established Pi extension pattern. Many reference implementations in the SDK examples.
- **Phase 2 — caching:** SHA-256 two-component key is well-documented in PITFALLS.md. Implementation is straightforward.
- **Phase 4 — context pressure hook:** Threshold calibration is judgment-based, not research-dependent.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All technologies verified against installed node_modules; npm versions confirmed; dep chains inspected directly |
| Features | HIGH | Full scope defined by PROJECT.md (authoritative); feature taxonomy cross-validated against LangChain/LlamaIndex patterns |
| Architecture | HIGH | Verified from Pi SDK source docs and extension examples in installed node_modules; data flows confirmed against session.md and extensions.md |
| Pitfalls | MEDIUM | Pi-specific pitfalls (details pattern, truncateHead, sub-call tools) are HIGH confidence from direct source inspection; concurrent sub-call behavior is MEDIUM — untested per PROJECT.md |

**Overall confidence:** HIGH

### Gaps to Address

- **Concurrent sub-call limits:** `createAgentSession` concurrent behavior is undocumented. Must validate N=5 and N=20 concurrent sessions before Phase 2 planning. If there is a global session registry limit, the concurrency cap must be set below it.
- **Sub-call prompt schemas:** The exact JSON schemas for map step (per-chunk extraction) and reduce step (synthesis) are not specified in research. Must be designed and validated against real inputs before Phase 2 implementation.
- **`details` snapshot size budget:** Research recommends storing only chunk metadata (not text) in `details` to avoid session JSONL bloat, but no concrete size budget is established. Should be measured during Phase 1 with a realistic 100KB document.
- **Pi `input` event API:** The auto-load hook's interception and transform API (how to replace a paste with an `rlm_load` call) is described conceptually but the exact Pi event mutation API needs verification from SDK source.
- **Web search unavailability:** FEATURES.md research was conducted without web access. LangChain/LlamaIndex feature claims should be spot-checked before any Phase 3 comparisons are made.

## Sources

### Primary (HIGH confidence)
- `/Users/marcusmccurdy/code/agent-customization/node_modules/@mariozechner/pi-coding-agent/dist/core/sdk.d.ts` — `createAgentSession`, `SessionManager.inMemory()`, `ToolDefinition` types
- `/Users/marcusmccurdy/code/agent-customization/node_modules/@mariozechner/pi-coding-agent/dist/core/agent-session.d.ts` — `getLastAssistantText()` confirmed
- `/Users/marcusmccurdy/code/agent-customization/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md` — `input` event, `before_agent_start`, `context` event, lifecycle
- `/Users/marcusmccurdy/code/agent-customization/node_modules/@mariozechner/pi-coding-agent/docs/sdk.md` — sub-agent session API
- `/Users/marcusmccurdy/code/agent-customization/node_modules/@mariozechner/pi-coding-agent/docs/session.md` — branch model, `result.details` persistence
- `/Users/marcusmccurdy/code/agent-customization/node_modules/@mariozechner/pi-coding-agent/examples/extensions/subagent/index.ts` — reference sub-agent pattern
- `.planning/PROJECT.md` — authoritative scope definition
- Pi extension source: `pi-extensions/webfetch.ts`, `pi-extensions/exa-search.ts`, `pi-extensions/handoff/` — pattern verification

### Secondary (MEDIUM confidence)
- Training knowledge of LangChain RAG documentation and source (through mid-2025) — feature taxonomy and competitor comparison
- Training knowledge of MemGPT/Letta architecture (through mid-2025) — orchestration mode patterns
- Training knowledge of LlamaIndex query engine patterns (through mid-2025) — tree summarization design
- General RAG/map-reduce chunking literature (Nakano et al. WebGPT, Guo et al.) — pitfall identification

### Tertiary (LOW confidence)
- Inferred concurrent sub-call behavior — no published documentation; requires empirical validation in Phase 1

---
*Research completed: 2026-02-23*
*Ready for roadmap: yes*
