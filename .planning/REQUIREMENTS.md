# Requirements: pi-rlm

**Defined:** 2026-02-24
**Core Value:** Pi agents can load, search, and query documents of any size without flooding their context window — getting structured, citation-backed answers through recursive decomposition.

## v1 Requirements

### Document Management

- [ ] **DOC-01**: User can load text/code documents into external store with configurable chunk size and overlap
- [ ] **DOC-02**: Chunks use hash-based stable IDs for deduplication and caching
- [ ] **DOC-03**: User can search across stored chunks via BM25 lexical search returning bounded excerpts with chunk IDs
- [ ] **DOC-04**: User can extract specific spans by chunk ID or character range with bounded output

### Intermediate State

- [ ] **STATE-01**: User can save named intermediate artifacts to buffers
- [ ] **STATE-02**: User can retrieve named artifacts from buffers
- [ ] **STATE-03**: Store state persists across branch forks via `result.details` snapshots
- [ ] **STATE-04**: All tool outputs truncate gracefully with truncation signal when exceeding Pi limits

### Query Orchestration

- [ ] **QUERY-01**: User can query stored documents using selective mode (search-narrowed sub-calls)
- [ ] **QUERY-02**: User can query stored documents using map_reduce mode (parallel chunk processing + synthesis)
- [ ] **QUERY-03**: User can query stored documents using tree mode (hierarchical summarization)
- [ ] **QUERY-04**: Sub-calls run as isolated, tool-less in-process Pi SDK sessions
- [ ] **QUERY-05**: Sub-call outputs cached by hash(chunk_content) + hash(instruction)
- [ ] **QUERY-06**: Parallel sub-calls bounded by configurable concurrency limit
- [ ] **QUERY-07**: Query answers include citation references to source chunk IDs

### Agent Integration

- [ ] **HOOK-01**: Auto-load hook intercepts large user pastes and offers to externalize via rlm_load
- [ ] **HOOK-02**: Context pressure hook detects high context usage and hints agent to prefer rlm_query

## v2 Requirements

### Developer Tools

- **DEV-01**: `/rlm` command interface for human-friendly status, chunk listing, GC
- **DEV-02**: `rlm_trace` tool exposes sub-call trace log for debugging orchestration
- **DEV-03**: `rlm_gc` tool garbage-collects stale chunks and buffers

### Advanced Features

- **ADV-01**: `rlm_repo_index` indexes codebase subset by glob patterns
- **ADV-02**: CI log triage specialized orchestration mode
- **ADV-03**: Memory artifact compaction for large buffers
- **ADV-04**: Token-aware chunking (requires tokenizer dependency)

## Out of Scope

| Feature | Reason |
|---------|--------|
| Semantic/embedding search | Adds hard external dependency (embedding model); BM25 sufficient for code queries |
| Disk-based persistent store | Pi is session-scoped; schema migration complexity not justified |
| Full-repo indexing at startup | Expensive, requires file watcher, breaks extension startup time |
| Cross-session persistent memory | Requires persistence backend and user identity outside Pi's design |
| Real-time streaming sub-call results | Pi tool return is synchronous; conflicts with structured JSON and caching |
| Automatic re-chunking on overflow | Dynamic chunking produces inconsistent IDs, breaks caching |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| DOC-01 | — | Pending |
| DOC-02 | — | Pending |
| DOC-03 | — | Pending |
| DOC-04 | — | Pending |
| STATE-01 | — | Pending |
| STATE-02 | — | Pending |
| STATE-03 | — | Pending |
| STATE-04 | — | Pending |
| QUERY-01 | — | Pending |
| QUERY-02 | — | Pending |
| QUERY-03 | — | Pending |
| QUERY-04 | — | Pending |
| QUERY-05 | — | Pending |
| QUERY-06 | — | Pending |
| QUERY-07 | — | Pending |
| HOOK-01 | — | Pending |
| HOOK-02 | — | Pending |

**Coverage:**
- v1 requirements: 17 total
- Mapped to phases: 0
- Unmapped: 17 ⚠️

---
*Requirements defined: 2026-02-24*
*Last updated: 2026-02-24 after initial definition*
