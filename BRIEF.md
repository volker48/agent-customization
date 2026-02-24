# Pi Coding Agent Extension Plan: Recursive Language Model (RLM) Scaffold

## Goal

Implement a Pi coding-agent extension that brings the core idea of **Recursive Language Models (RLMs)** into Pi: keep the root agent’s context small while enabling it to work over **arbitrarily long inputs** by storing them externally and interacting through **tools** plus **sub-calls** (small, focused agent sessions).

This extension will be called **`pi-rlm`**.

---

## 1) Conceptual Mapping (RLM → Pi)

### RLM behaviors to reproduce
1. **Externalize long context**
   - Store long documents outside the LM prompt (extension runtime state).
   - Expose tools that return only small excerpts.

2. **Manipulate long context symbolically**
   - RLM paper uses a REPL and a `context` variable.
   - We replace arbitrary code execution with a safe set of deterministic operations (search/extract/chunk/buffer).

3. **Recursive sub-calls**
   - Root agent orchestrates; sub-calls process chunks and return structured outputs.
   - Sub-calls should be batched and cached to reduce cost.

4. **Stitch intermediate results**
   - Maintain buffers / scratchpads to combine partial outputs into final answers.

### Pi features we will use
- Extension registration and hooks (`pi.on`, `pi.registerTool`)
- Tool schema validation (TypeBox)
- Per-branch state persistence via tool `details` (recommended)
- `ctx.getContextUsage()` to react to context pressure
- SDK (`createAgentSession`, `SessionManager.inMemory()`) to run sub-calls in-process
- Optional: rendering (`renderResult`) for trace visualization

---

## 2) Deliverables

### Primary deliverable
A Pi extension at:
- `pi-extensions/pi-rlm/index.ts`

### Modules
- `index.ts` (extension entry; registers tools; wires hooks)
- `store.ts` (RlmStore implementation)
- `chunking.ts` (chunk strategies)
- `subcall.ts` (RlmSubLM using Pi SDK agent sessions)
- `orchestrator.ts` (map-reduce / selective / tree modes)
- `render.ts` (optional: compact tree trace rendering)
- `types.ts` (schemas + shared types)
- `utils.ts` (hashing, truncation, caching helpers)

---

## 3) State & Persistence Strategy

### Why
Pi sessions can branch/fork. Extension state must survive branching.

### Approach
- Store full runtime state in-memory during execution.
- On every tool call, return a **compact snapshot** in `result.details`.
- When the extension starts / handles a tool call, **rehydrate state** by scanning prior tool results from the current branch and loading the latest snapshot.

### State model (RlmStore)
- `documents: Map<docId, { name, text, metadata }>`
- `chunks: Map<chunkId, { docId, start, end, textHash, preview }>`
- `buffers: Map<string, string>` for intermediate artifacts
- `cache: Map<string, { output, createdAt }>` for sub-call outputs keyed by `(chunkHash + instructionHash + modelConfigHash)`
- `trace: { runId, nodes, edges, stats }` for debugging + rendering

### Snapshot compaction rules
- Never store full huge text in `details` if it risks tool output limits.
- Prefer:
  - document metadata + chunk indices
  - hashes
  - small previews
  - buffers (bounded size)
  - caches (bounded size, truncated)

If necessary, also write large docs to a temp file within the repo/workspace and store only file paths + hashes.

---

## 4) Tool Surface (MVP and Beyond)

## 4.1 MVP Tools

### Tool: `rlm_load`
**Purpose:** Load long input into the store, create chunks, index.
**Inputs:**
- `name: string`
- `sources: Array<{ type: "text" | "file", value: string }>`
- `chunking: { strategy: "fixed" | "overlap", targetChars: number, overlapChars: number }`
- `docId?: string` (optional for overwrite)
**Outputs:**
- `docId`
- chunk count
- summary stats (chars, chunks)
- `details.snapshot` (updated)

### Tool: `rlm_search`
**Purpose:** Search in one or more docs; return bounded excerpts and chunk IDs.
**Inputs:**
- `query: string`
- `regex?: boolean`
- `docIds?: string[]` (default all)
- `maxMatches: number` (default 20)
- `windowChars: number` (default 800)
**Outputs:**
- matches: `{ docId, chunkId, start, end, excerpt }[]` (truncated)
- `details.snapshot`

### Tool: `rlm_extract`
**Purpose:** Extract specific spans by chunk ID or absolute ranges.
**Inputs:**
- `docId: string`
- `ranges?: Array<{ start: number, end: number }>`
- `chunkIds?: string[]`
- `maxChars: number`
**Outputs:**
- extracted text (truncated)
- `details.snapshot`

### Tool: `rlm_buffer_set`
**Purpose:** Save intermediate artifact.
**Inputs:** `{ key: string, value: string, maxChars?: number }`
**Outputs:** `{ ok: true }` + snapshot

### Tool: `rlm_buffer_get`
**Purpose:** Retrieve intermediate artifact.
**Inputs:** `{ key: string, maxChars?: number }`
**Outputs:** `{ key, value }` + snapshot

### Tool: `rlm_query`
**Purpose:** Main “RLM” operation: answer a question over large context using recursion patterns.
**Inputs:**
- `question: string`
- `scope: { docIds?: string[], chunkIds?: string[], searchQuery?: string }`
- `mode: "selective" | "map_reduce" | "tree"`
- `targetChunkChars: number` (default 50_000)
- `maxSubcalls: number` (default 24)
- `maxConcurrency: number` (default 3)
- `reducer: { style: "json" | "markdown", fields?: string[] }`
- `returnTrace: boolean` (default true)
**Outputs:**
- final answer
- optional structured result
- trace summary
- snapshot

---

## 4.2 Optional Tools (Phase 2/3)

### Tool: `rlm_repo_index`
Index a codebase subset:
- inputs: include/exclude globs, max file size
- loads files into doc(s), chunked

### Tool: `rlm_trace`
Return last trace tree and stats.

### Tool: `rlm_gc`
Garbage collect caches/buffers by policy.

---

## 5) Orchestrator Modes (Core Algorithms)

## 5.1 Common building blocks

### Chunking
Implement chunking strategies:
- **Fixed**: split by `targetChars`
- **Overlap**: split by `targetChars` with `overlapChars` overlap
Future: token-aware chunking (optional).

### Truncation discipline
Pi tool output limits: ensure all tool outputs are:
- max 50KB or ~2000 lines
- excerpts only; never dump entire doc
- always include `...TRUNCATED...` marker if truncated

### Caching
Cache subcall outputs keyed by:
- `chunkHash + instructionHash + modelConfigHash`

---

## 5.2 Mode: `selective`
Use search to narrow scope.
Algorithm:
1. If `scope.searchQuery` provided, run store search with window.
2. Convert matches into candidate spans.
3. Merge overlapping spans.
4. For each span: run subcall `answerOverChunk(spanText, question)`
5. Reduce partial answers into final output:
   - prompt reducer with all partial outputs (bounded)
   - ask for final answer with citations referencing span IDs / chunk IDs
6. Save reducer output to `buffers["last_answer"]`

Use when: question is likely answerable from small relevant pieces.

---

## 5.3 Mode: `map_reduce`
Summarize/answer across many chunks.
Algorithm:
1. Determine target chunks:
   - docIds → their chunk lists
   - chunkIds directly
2. If too many chunks, enforce `maxSubcalls` by:
   - sampling / first-N
   - or pre-search for relevance (optional)
3. For each chunk: subcall `summarizeChunk(chunkText, question)` returning JSON:
   - `summary`
   - `keyFacts[]`
   - `openQuestions[]`
   - `evidenceQuotes[]` (short)
4. Reduce all chunk summaries into final answer.

Use when: broad synthesis needed.

---

## 5.4 Mode: `tree` (hierarchical summarization)
Build a summary tree.
Algorithm:
1. Leaf stage: summarize every chunk (bounded)
2. Group leaf summaries into groups of size G (e.g., 6)
3. Summarize each group into a parent summary
4. Repeat until one root summary remains
5. Answer question using root summary + optionally a second pass selective extraction for evidence.

Use when: documents are huge and reduction must be staged.

---

## 6) Sub-call Implementation (RlmSubLM)

### Principle
Sub-calls must be:
- isolated
- small-context
- tool-less (or very limited)
- deterministic and structured

### Implementation method (recommended)
Use Pi SDK:
- `SessionManager.inMemory()`
- `createAgentSession({ sessionManager, tools: [], model: ctx.model })`
- prompt template ensures JSON output

### Subcall prompt templates

#### Summarize chunk
System:
- “You are a micro-summarizer. Use only the provided chunk. Output strict JSON.”

User:
- `CHUNK_ID: ...`
- `CHUNK_TEXT: ...`
- `INSTRUCTION: Summarize in relation to QUESTION: ...`
Output JSON schema:
- `{"chunkId": "...", "summary": "...", "keyFacts": ["..."], "evidenceQuotes": ["..."], "confidence": 0-1}`

#### Answer over span
Output JSON:
- `{"chunkId": "...", "answer": "...", "evidenceQuotes": ["..."], "confidence": 0-1}`

#### Reducer
Provide partials and demand:
- final answer
- list of which chunk IDs support each claim
Output JSON (if reducer style JSON):
- `{"answer": "...", "claims": [{"text":"...", "supports":["chunkId1","chunkId2"]}], "uncertainties":[...]}`

### Parallelism
Implement bounded concurrency:
- `maxConcurrency` with a promise pool
- preserve ordering for determinism in reduction

---

## 7) Extension Integration (index.ts)

### Register tools
For each tool:
- define TypeBox input schema
- implement handler that:
  1) rehydrates store from prior tool details (branch)
  2) performs operation
  3) returns result with updated snapshot in `details`

### Optional hooks (Phase 2)
#### Input hook: auto-load big pastes
- `pi.on("input", ...)`
- If user message length > threshold (e.g., 30k chars):
  - offer confirmation via `ctx.ui.confirm`
  - if accepted: call internal load logic, then rewrite prompt to reference stored doc

#### Context pressure hook
- Use `ctx.getContextUsage()`
- If high usage, inject short instruction to prefer `rlm_query` and avoid dumping text

---

## 8) Trace & Debugging UX

### Trace data model
Maintain per `rlm_query`:
- `runId`
- `nodes`: chunks, subcalls, reducer
- `edges`: “used_by” relationships
- `stats`: chars processed, subcalls, cache hits

### Rendering (optional but recommended)
Implement `renderResult` for `rlm_query`:
- show final answer preview
- show subcall count, cache hit rate
- show top chunk IDs used
- show a collapsible trace tree if UI supports it

Also allow `returnTrace: false` to reduce output.

---

## 9) Safety, Cost, and Limits

### Hard caps
- `maxSubcalls` (default 24)
- `maxConcurrency` (default 3)
- `maxTotalCharsSentToSubLM` (e.g., 1,200,000)
- chunk size defaults (50k chars) with overlap (2k)

### Output bounds
- all tool outputs truncated
- never return full documents through tool output

### Caching & GC
- LRU cache for subcall outputs with max entries (e.g., 200)
- `rlm_gc` to clear caches and large buffers

### Determinism
- Prefer low temperature (if model supports)
- stable ordering
- stable hashing

---

## 10) Phased Implementation Roadmap

## Phase 1: MVP (explicit tool use)
1. Scaffold extension structure
2. Implement `RlmStore` + snapshot persistence
3. Implement chunking
4. Implement `rlm_load`, `rlm_search`, `rlm_extract`
5. Implement `RlmSubLM` via SDK sessions
6. Implement `rlm_query` with `selective` and `map_reduce`
7. Add basic trace + caching
8. Test on:
   - huge paste text
   - long logs
   - large markdown docs

## Phase 2: Native-feeling UX
1. Add input auto-load hook
2. Add context pressure hinting
3. Add `/rlm` command-like interface (if supported) or docs examples
4. Add `rlm_trace` tool + better renderer

## Phase 3: Coding-agent superpowers
1. `rlm_repo_index`: load repo files by glob
2. Long-range codebase Q&A and architecture summaries
3. CI log triage workflows
4. “Memory artifact” compaction strategy:
   - store structured memory in buffer
   - ensure compaction preserves it

---

## 11) Example Usage Flows (for testing)

### Flow A: Large paste triage
1. User pastes 200k chars of logs.
2. Agent calls:
   - `rlm_load(name="ci-logs", sources=[{type:"text", value:"..."}])`
   - `rlm_query(mode="selective", scope={searchQuery:"error|exception|traceback"}, question="What broke and how to fix?")`

### Flow B: Broad synthesis
1. Load multiple docs.
2. `rlm_query(mode="map_reduce", scope={docIds:[...]}, question="Summarize design, risks, and TODOs")`

### Flow C: Huge doc
1. Load 2MB doc.
2. `rlm_query(mode="tree", scope={docIds:[...]}, question="Extract key decisions and unresolved issues")`

---

## 12) Acceptance Criteria

MVP is complete when:
- You can load a large document without flooding context.
- You can search and extract bounded excerpts.
- `rlm_query` returns correct structured answers for:
  - selective extraction
  - map-reduce synthesis
- Subcalls are cached and concurrency-limited.
- Tool outputs respect Pi’s output limits and remain readable.
- Branching does not lose state (rehydration works from tool `details`).

---

## 13) Implementation Notes (Practical Guidance)

- Prefer in-process SDK sessions for subcalls to avoid spawning overhead.
- Keep subcalls tool-less to prevent runaway behavior.
- Always return chunk IDs and hashes for traceability.
- Make reducer prompts strict and schema-driven to avoid “creative” formatting.
- Treat truncation as a first-class feature, not an afterthought.

---

## 14) Suggested File Skeleton
pi-rlm/
index.ts
store.ts
chunking.ts
subcall.ts
orchestrator.ts
render.ts (optional)
types.ts
utils.ts
README.md (usage + examples)


