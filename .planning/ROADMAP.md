# Roadmap: pi-rlm

## Overview

Build pi-rlm in four sequential phases, each unblocking the next. Phase 1 establishes the document store, chunking pipeline, and branch-safe state — the foundation everything else depends on, including an early stress-test of the in-process sub-call pattern before any orchestration code is written. Phase 2 adds the map_reduce orchestration mode with caching and bounded concurrency, which is the highest-risk orchestration path. Phase 3 completes query coverage with selective and tree modes. Phase 4 wires in the lifecycle hooks that surface RLM to the agent without explicit tool invocation.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Foundation** - Document store, chunking, search/extract tools, and branch-safe state
- [ ] **Phase 2: map_reduce Orchestration** - Sub-runner, caching, bounded concurrency, and map_reduce query mode
- [ ] **Phase 3: selective and tree Modes** - Remaining query modes with citation references
- [ ] **Phase 4: Hooks** - Auto-load and context-pressure lifecycle integration

## Phase Details

### Phase 1: Foundation
**Goal**: Pi agents can load documents into a chunked store and retrieve content by search or direct extraction, with state that survives branch forks
**Depends on**: Nothing (first phase)
**Requirements**: DOC-01, DOC-02, DOC-03, DOC-04, STATE-01, STATE-02, STATE-03, STATE-04
**Success Criteria** (what must be TRUE):
  1. Agent can call `rlm_load` with a large text/code document and it is chunked into stable hash-keyed entries in the store
  2. Agent can call `rlm_search` with a query string and receive bounded excerpts with chunk IDs from stored documents
  3. Agent can call `rlm_extract` with a chunk ID or character range and receive the exact span with bounded output
  4. Agent can call `rlm_save` and `rlm_get` to persist and retrieve named intermediate artifacts
  5. After a Pi branch fork, previously loaded store state is correctly rehydrated from `result.details` and tools return consistent results
**Plans:** 2 plans
Plans:
- [ ] 01-01-PLAN.md — Core data layer: types, content-aware chunker, DocumentStore with MiniSearch search, extraction, buffers, snapshot/restore
- [ ] 01-02-PLAN.md — Pi tool integration: register 5 tools, lifecycle events for branch-safe state, truncation

### Phase 2: map_reduce Orchestration
**Goal**: Agent can query stored documents using map_reduce mode — parallel sub-calls over all chunks, each cached by content+instruction hash, with concurrency bounded to prevent runaway resource use
**Depends on**: Phase 1
**Requirements**: QUERY-02, QUERY-04, QUERY-05, QUERY-06
**Success Criteria** (what must be TRUE):
  1. Agent can call `rlm_query` with `mode: "map_reduce"` and receive a synthesized answer drawn from all stored chunks
  2. A repeated `rlm_query` with the same instruction returns immediately from cache without re-running sub-calls on unchanged chunks
  3. Parallel sub-calls are visibly capped — calling `rlm_query` on a 200-chunk document never exceeds the configured concurrency limit
  4. Sub-calls run as isolated tool-less Pi SDK sessions (no tools available inside the sub-call)
**Plans**: TBD

### Phase 3: selective and tree Modes
**Goal**: Agent can query stored documents using all three orchestration modes — selective for targeted questions (default), tree for ultra-large documents — and every answer includes chunk ID citations
**Depends on**: Phase 2
**Requirements**: QUERY-01, QUERY-03, QUERY-07
**Success Criteria** (what must be TRUE):
  1. Agent can call `rlm_query` with `mode: "selective"` and receive an answer based only on search-narrowed chunks (fewer sub-calls than map_reduce)
  2. Agent can call `rlm_query` with `mode: "tree"` and receive a hierarchically summarized answer for documents too large for map_reduce
  3. Every `rlm_query` answer includes citation references that map claims back to specific source chunk IDs
**Plans**: TBD

### Phase 4: Hooks
**Goal**: Pi's lifecycle events automatically surface RLM capabilities — large pastes trigger an offer to externalize, and high context usage prompts the agent to prefer `rlm_query`
**Depends on**: Phase 3
**Requirements**: HOOK-01, HOOK-02
**Success Criteria** (what must be TRUE):
  1. When a user pastes a document exceeding the threshold, Pi intercepts it and offers to run `rlm_load` instead of flooding context
  2. When the agent's context usage is high, Pi emits a hint that the agent can use `rlm_query` to avoid further context pressure
  3. Dismissing the auto-load offer results in normal paste behavior — the hook does not alter pastes below the threshold
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation | 0/2 | Planned | - |
| 2. map_reduce Orchestration | 0/? | Not started | - |
| 3. selective and tree Modes | 0/? | Not started | - |
| 4. Hooks | 0/? | Not started | - |
