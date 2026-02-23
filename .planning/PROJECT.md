# pi-rlm

## What This Is

A Pi coding-agent extension that implements Recursive Language Model (RLM) patterns — enabling Pi to work with arbitrarily long inputs by externalizing context to a store, exposing search/extract tools, and using focused sub-agent sessions to process chunks and synthesize answers. Built as `pi-rlm`, it solves both context overflow (inputs too large for the prompt) and quality degradation (coherence loss on long documents).

## Core Value

Pi agents can load, search, and query documents of any size without flooding their context window — getting structured, citation-backed answers through recursive decomposition.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Load large documents into external store with chunking
- [ ] Search across stored documents returning bounded excerpts
- [ ] Extract specific spans by chunk ID or character range
- [ ] Save/retrieve intermediate artifacts via named buffers
- [ ] Answer questions over large context using selective mode (search-narrowed)
- [ ] Answer questions over large context using map_reduce mode (broad synthesis)
- [ ] Answer questions over large context using tree mode (hierarchical summarization)
- [ ] Sub-calls run as isolated, tool-less in-process Pi SDK sessions
- [ ] Sub-call outputs cached by chunk hash + instruction hash
- [ ] Bounded concurrency on parallel sub-calls
- [ ] State persists across branching via tool result `details` snapshots
- [ ] Auto-load hook intercepts large user pastes and offers to externalize
- [ ] Context pressure hook detects high usage and hints agent to use rlm_query
- [ ] All tool outputs respect Pi's output limits (truncation as first-class feature)

### Out of Scope

- Repo indexing (`rlm_repo_index`) — Phase 3, not MVP
- CI log triage workflows — Phase 3
- Memory artifact compaction — Phase 3
- Token-aware chunking — future optimization
- `/rlm` command interface — deferred to Phase 2
- `rlm_trace` standalone tool — deferred to Phase 2
- `rlm_gc` garbage collection tool — deferred to Phase 2

## Context

- **Pi** is an open-source coding agent (github.com/badlogic/pi-mono) with a plugin-based extension system
- Extensions register tools via `pi.registerTool()` with TypeBox schemas and hook into lifecycle events via `pi.on()`
- State persistence uses `result.details` on tool returns + rehydration from branch history
- Sub-agent sessions available via `createAgentSession({ sessionManager: SessionManager.inMemory(), tools: [] })`
- Existing extensions in the repo (plugins, themes) serve as reference patterns
- The sub-call SDK pattern is documented but not yet battle-tested for RLM-style workloads — needs early validation

## Constraints

- **Extension API**: Must use Pi's extension API — `pi.registerTool()`, `pi.on()`, TypeBox schemas
- **Output limits**: Pi tool outputs capped at ~50KB/2000 lines — all outputs must truncate gracefully
- **Sub-call isolation**: Sub-calls must be tool-less and structured-output only (JSON)
- **Branch safety**: State must survive Pi's branch/fork model via `details` snapshots
- **Dependencies**: Minimize new deps — Pi already bundles TypeBox and the SDK

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| In-process SDK sessions for sub-calls | Avoids process spawn overhead, uses Pi's native API | — Pending (needs validation) |
| State via tool `details` + rehydration | Pi's recommended persistence pattern for extensions | — Pending |
| All 3 orchestration modes in v1 | User wants selective, map_reduce, and tree for completeness | — Pending |
| MVP + hooks as definition of done | Tools + auto-load hook + context pressure hook | — Pending |

---
*Last updated: 2026-02-23 after initialization*
