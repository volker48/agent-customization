# Pitfalls Research

**Domain:** RLM extension — recursive long-context processing for coding agents (Pi SDK)
**Researched:** 2026-02-23
**Confidence:** MEDIUM — drawn from Pi extension source patterns (HIGH confidence on Pi-specific
items), general LLM chunking/RAG literature (MEDIUM), and RLM-specific reasoning (MEDIUM where
no published post-mortems exist for this exact pattern).

---

## Critical Pitfalls

### Pitfall 1: Chunking That Destroys Semantic Boundaries

**What goes wrong:**
A fixed-size character or byte splitter cuts mid-function, mid-class, mid-import-block, or across
a comment that explains the following code. The chunk that lands in a sub-call is structurally
incomplete: a function without its signature, a type without its definition, a test without the
code it tests. The sub-call model hallucinates the missing parts or returns confidently wrong
answers about what the code does.

**Why it happens:**
Implementors choose the simplest possible splitter — `text.slice(i, i + CHUNK_SIZE)` — because
they are focused on the pipeline architecture, not the content semantics. The failure only becomes
visible during end-to-end testing on real codebases, which happens late.

**How to avoid:**
Use a language-aware boundary detector as the primary split point. For code: split on top-level
declarations (functions, classes, modules), not bytes. Cascade: try declaration boundary → blank
line boundary → sentence boundary → hard byte limit (emergency fallback only). Add a configurable
overlap (e.g., last N lines of previous chunk prepended to next) to preserve context across
boundaries. Test on real Pi extension source files, not lorem ipsum.

**Warning signs:**
- Sub-call outputs contain phrases like "the function definition is not shown" or "assuming this
  is a continuation of..."
- map_reduce mode produces different answers from selective mode on the same question about
  the same document
- Chunk boundary lands exactly at an opening `{` or `(`

**Phase to address:** Phase 1 (chunking + store) — the split strategy must be correct before
any query mode is built on top of it. Retrofitting a bad splitter after query modes are working
is painful.

---

### Pitfall 2: Sub-Call Prompt Engineering Failure — Hallucinated Synthesis

**What goes wrong:**
Sub-call sessions receive a chunk plus an instruction, but the instruction is underspecified for
the chunk's position in the document. Early chunks receive instructions like "summarize this"
without knowing it is the beginning of a 50-file codebase. The model over-generalizes or hedges
into uselessness. In map_reduce mode, the reduce step receives 30 per-chunk summaries and is
asked to synthesize them without structure — the output is a verbose prose paragraph that drops
the most important concrete findings (line numbers, function names, specific values).

**Why it happens:**
Prompt engineering for sub-calls is treated as an afterthought. The `complete()` call is wired up
with a generic system prompt, and only the user message changes per chunk. The distinction between
"map instruction" and "reduce instruction" is not designed upfront, or the reduce prompt does not
enumerate what structured fields must appear in the output.

**How to avoid:**
Design two distinct prompts for map_reduce: one for per-chunk extraction (returns structured JSON
with explicit schema) and one for synthesis (aggregates the structured JSON, not free text). The
map prompt must specify: extract X, Y, Z from this chunk; if not present, return null for that
field. The reduce prompt receives structured data, not prose. For the tree mode, define the
recursive intermediate summary schema before writing any code. Validate both prompts against
real chunk inputs before wiring up the pipeline.

**Warning signs:**
- Sub-call outputs contain qualifiers like "the chunk may contain..." or "it is unclear whether..."
- Reduce step output is longer than the largest map output (synthesis ballooned instead of
  condensed)
- Final answers from map_reduce contradict direct answers from selective mode on the same
  question

**Phase to address:** Phase 1 (sub-call wiring + first mode). The prompt designs must be
validated before Phase 2 adds additional modes that inherit the same patterns.

---

### Pitfall 3: State Rehydration Bugs Across Branches

**What goes wrong:**
Pi's branch model allows users to fork conversation history. The RLM extension stores chunk
metadata and artifact identifiers in `result.details` on tool returns. When the user branches from
a point where `rlm_load` was called, the new branch rehydrates the store ID from `details`, but
the in-memory store is gone (it was only populated in the original branch's process session). The
agent calls `rlm_query` with a stale store ID and receives a "store not found" error, or worse,
silently returns empty results because the ID matched a different session's store.

**Why it happens:**
The `details` pattern (learned from handoff extension) persists metadata across tool calls within
a branch, but does not automatically reconstruct transient in-memory state. Implementors model
`details` as durable storage when it is actually a snapshot of the last-known state. The
in-process session manager is ephemeral; only the branch history persists.

**How to avoid:**
Separate "store identity" (what was loaded) from "store availability" (is it loaded right now).
Store IDs must encode enough information to reconstruct from source (file path + chunk count +
hash) or re-trigger load. The `rlm_query` tool must check whether the store ID is live, and if
not, surface a clear actionable error: "Store [id] is not available in this branch. Re-run
rlm_load with [source] to restore it." Do not silently return empty results. Consider writing
chunk data to a named buffer (a file on disk, or the existing buffer store) that survives branch
switches, rather than keeping it only in memory.

**Warning signs:**
- Branching from a conversation that used `rlm_load` and then calling `rlm_query` silently
  returns nothing
- Store ID appears in `details` but no corresponding entry in the in-memory map
- Tests only cover the linear (non-branched) case

**Phase to address:** Phase 1 (state model design). Getting this wrong means branch safety must
be retrofitted, which touches every tool that touches state.

---

### Pitfall 4: Output Truncation That Loses the Most Relevant Content

**What goes wrong:**
Pi's `truncateHead()` cuts from the tail of output. For `rlm_query` in selective mode, the most
relevant chunk excerpts may appear at the end of the output (ranked by relevance score descending,
then concatenated). Head truncation discards the highest-relevance excerpts and keeps the
boilerplate header and low-relevance context. The agent sees "no relevant results" when there were
excellent results, they were just truncated.

**Why it happens:**
The existing Pi extensions (webfetch, exa_search) use `truncateHead()` because their content is
naturally front-loaded (HTTP headers and status come first, results are already ranked and the
top results appear first). RLM output may be structured differently: metadata first, then
excerpts in relevance order, then synthesis. Blindly applying `truncateHead()` without considering
output structure is the trap.

**How to avoid:**
Design output format so the highest-signal content appears first. For `rlm_query`: emit the
direct answer or synthesis first, then supporting excerpts in relevance order. Reserve metadata
and chunk source attribution for the end where truncation is acceptable. Apply `truncateHead()`
only after structuring output this way. Test by intentionally generating outputs that exceed the
50KB/2000 line limit and verifying what the agent actually sees.

**Warning signs:**
- Agent reports no results but `details.totalChunksConsidered` is non-zero
- Truncation notice appears after the first result block (meaning results were cut)
- Test output from large documents is smaller than expected

**Phase to address:** Phase 1 (every tool output). This is structural and must be established
before multi-mode orchestration in Phase 2.

---

### Pitfall 5: Runaway Token Cost from Unbounded Sub-Call Fan-Out

**What goes wrong:**
map_reduce mode is called on a large document with no chunk limit. A 500KB file becomes 200
chunks at 2500 chars each. All 200 are dispatched to sub-call sessions concurrently (or
sequentially). Each sub-call burns ~1,500 tokens minimum for the map step. Total: 300,000 tokens
before the reduce step. With GPT-4 or Claude-tier pricing, a single `rlm_query` invocation costs
several dollars. Worse, if the concurrency pool is unbounded, 200 simultaneous in-process sessions
saturate memory and crash Pi.

**Why it happens:**
Implementors prototype with small documents (10–20 chunks). The map_reduce call feels fast and
cheap. The concurrency cap and per-query chunk limit are not designed in from the start, they are
added reactively after observing the problem.

**How to avoid:**
Three mandatory constraints, designed before any map_reduce code ships:
1. **Max chunks per query** — hard cap (e.g., 50 chunks) with a clear error when exceeded,
   prompting the user to narrow via `rlm_search` first.
2. **Concurrency cap** — bounded parallel sub-call pool (e.g., 8 concurrent sessions). Already
   listed in PROJECT.md requirements.
3. **Cost estimate before execution** — before dispatching, report estimated chunk count and warn
   if above a threshold. Let the agent or user confirm for large operations.

**Warning signs:**
- `rlm_query` in map_reduce mode takes >30 seconds on a moderate document
- Memory usage spikes during concurrent sub-call execution
- No maximum chunk count parameter on `rlm_query`

**Phase to address:** Phase 1 (architecture of the orchestrator). The concurrency cap and chunk
limit must be part of the initial API design; retrofitting them after the tool signature is
finalized is a breaking change.

---

### Pitfall 6: Cache Key Collision or Over-Invalidation

**What goes wrong:**
Two failure modes. (A) Over-invalidation: the cache key includes a full document hash, so any
edit to the source document (even a comment change) invalidates all chunk caches for that
document. Every subsequent query re-runs all sub-calls. (B) Under-invalidation: the cache key
omits the instruction/prompt text and only hashes the chunk content. Changing the query (e.g.,
from "summarize" to "extract security issues") returns the cached summary from the previous query,
silently serving the wrong answer.

**Why it happens:**
Cache key design is deferred until "we have a working system," then rushed. The two-component key
(chunk hash + instruction hash) in PROJECT.md is the right design but easy to get wrong: hashing
the full prompt template including formatting boilerplate rather than just the semantic instruction
leads to unnecessary cache misses; hashing only the chunk ID without content means stale results
after document re-load.

**How to avoid:**
Cache key = `sha256(chunkContent) + ":" + sha256(canonicalInstruction)`. Canonical instruction
strips whitespace normalization, version prefixes, and any dynamic context that does not affect
output. Test the two failure modes explicitly: assert that identical chunks with different
instructions produce different cache entries, and that different chunks with identical instructions
also produce different cache entries. Test that re-loading a document with one changed chunk only
invalidates that chunk's cache entries, not the entire document's.

**Warning signs:**
- Query results do not change after modifying the query text (under-invalidation)
- Every re-load of a large document triggers a full re-run of all sub-calls (over-invalidation)
- Cache hit rate is 0% or 100% in all scenarios (both are suspect)

**Phase to address:** Phase 1 (caching layer design). Cannot be safely changed after tools are
wired up, as it affects performance characteristics that users will come to rely on.

---

### Pitfall 7: Structured Output Parsing Failures from Sub-Calls

**What goes wrong:**
Sub-call sessions are required to return structured JSON (PROJECT.md constraint). The map step
prompt instructs the model to return JSON like `{"findings": [...], "relevant": true}`. In
practice, models wrap JSON in markdown code fences, add explanatory preamble, return valid JSON
with extra fields, or return an empty object when the chunk contains nothing relevant. The parsing
code does `JSON.parse(response)` and crashes on the markdown-wrapped case, or silently discards
the extra fields the model added to communicate important edge cases.

**Why it happens:**
JSON extraction from LLM output is harder than it looks. The `complete()` API returns raw text;
there is no structured output enforcement at the API level (unlike function-calling modes). When
testing with a small, simple document, the model reliably returns clean JSON. Real documents
produce edge cases that trigger markdown wrapping.

**How to avoid:**
Implement a robust JSON extraction layer: try direct `JSON.parse()`, then extract the first JSON
object from a markdown code fence, then fall back to a schema-validated partial parse. Define a
TypeBox schema for sub-call output and validate against it after parsing. If validation fails, the
sub-call result must be marked as an error, not silently ignored or returned as empty. Log the
raw sub-call output (in `details`) when parsing fails so the failure is diagnosable. Do not use
`JSON.parse()` without a try-catch anywhere in the sub-call result pipeline.

**Warning signs:**
- Sub-call results are inconsistently structured across different document types
- Empty findings on a chunk that clearly contains relevant content
- Parsing errors only appear with certain document formats (Markdown with code blocks is the
  most common trigger, as the model mimics the surrounding format)

**Phase to address:** Phase 1 (sub-call session abstraction). Build and test the JSON extraction
layer before connecting it to any orchestration mode.

---

### Pitfall 8: Concurrency Bugs in the Parallel Sub-Call Pool

**What goes wrong:**
When map_reduce runs N sub-calls concurrently, shared mutable state causes races. Common examples:
(A) A shared `results: ChunkResult[]` array pushed to from concurrent async functions without
synchronization — Node.js is single-threaded but `await` yields let concurrent pushes interleave
incorrectly if results depend on order. (B) A shared cache Map written from multiple concurrent
sub-calls for different keys — not a race in Node.js but easy to introduce a bug where a cache
write is conditional on a read (`if (!cache.has(key)) { ... cache.set(key, ...) }`) that gets
duplicated before the write resolves. (C) Abort signal propagation: if the parent tool call is
aborted mid-flight, in-progress sub-calls must be cancelled; forgetting this leaks in-process
sessions that continue consuming memory.

**Why it happens:**
Concurrent async code is harder to reason about than sequential code, and the bugs only manifest
under load (multiple chunks, realistic concurrency). The `p-limit` or equivalent concurrency
limiter is used to bound parallelism but the results collection logic inside the limited function
is not reviewed for ordering or cancellation safety.

**How to avoid:**
Use `Promise.allSettled()` instead of `Promise.all()` — a single sub-call failure should not
abort the entire map step (fail the individual chunk, continue with others). Collect results into
a pre-allocated array by index: `results[i] = await subcall(chunks[i])` rather than pushing. Pass
the parent AbortSignal into each sub-call so cancellation propagates. Write a test that aborts a
multi-chunk query mid-flight and asserts no sessions are leaked (check session manager's
active session count before and after).

**Warning signs:**
- Results appear in different orders across identical runs (ordering not deterministic)
- Aborting a query leaves Pi consuming elevated memory
- Race conditions that only appear on documents with >20 chunks

**Phase to address:** Phase 1 (parallel sub-call pool implementation). Must be addressed
alongside the concurrency cap, as both belong to the same orchestration layer.

---

### Pitfall 9: Auto-Load Hook Intercepts and Breaks Normal Large Pastes

**What goes wrong:**
The auto-load hook intercepts large user pastes and offers to externalize them. This is correct
for large documents, but the interception threshold is set too low (e.g., 5KB) and captures
normal code pastes that the user intended to include directly in context. The hook fires mid-paste
with an interruption dialog, breaks the user's flow, and after they dismiss it, the paste is not
applied. Alternatively, the hook fires but the user accepts, the content is externalized, and the
agent proceeds without realizing the paste was removed from its working context — it queries the
store instead of reading the content directly from the message.

**Why it happens:**
The hook threshold is guessed without empirical data on what size is "too large for context."
Pi's context window is large; a 10KB code file is comfortably within context but triggers the
hook anyway. The edge case where interception fails (user dismisses) and the content is lost is
not handled.

**How to avoid:**
Set the auto-load threshold conservatively high (e.g., >100KB, or >Pi's context pressure threshold
from the context pressure hook). Treat the hook as advisory: if the user dismisses, the paste
proceeds normally into context. Never silently discard content. The interception UI must show the
content size and estimated context usage so the user can make an informed decision. Test the
dismiss path explicitly.

**Warning signs:**
- Users reporting that pasted code disappears or is not seen by the agent
- Hook fires on files under 20KB
- No test coverage for the dismiss/cancel path of the auto-load hook

**Phase to address:** Phase 1 (hooks implementation). The auto-load hook is part of MVP per
PROJECT.md and its failure modes directly affect correctness.

---

### Pitfall 10: In-Process Sub-Call Session Isolation Assumption Violated

**What goes wrong:**
PROJECT.md notes that the sub-call SDK pattern ("in-process SDK sessions") is "not yet
battle-tested for RLM-style workloads — needs early validation." The risk: `createAgentSession`
with `SessionManager.inMemory()` and `tools: []` may share process-level state in unexpected
ways. If Pi's session manager has a global registry, creating 50 simultaneous in-process sessions
may saturate it. If the `complete()` API has per-process rate limiting or connection pooling, 50
concurrent sub-calls will hit that limit. If the sub-call sessions share a model client instance,
concurrent access may cause request interleaving or auth token exhaustion.

**Why it happens:**
The sub-call API is documented for single-session use (handoff extension uses `complete()` for one
generation at a time). Concurrent use is untested and any global state in the SDK becomes a
problem at scale.

**How to avoid:**
Run the sub-call API stress test as the first step of Phase 1 implementation — before writing
any RLM logic. Create N concurrent in-process sessions (start with N=5, then N=20) and verify
they complete independently without errors. Check memory usage before and after. If the SDK has
session limits, document them and enforce them in the concurrency cap. If the sub-call pattern
does not support concurrent use, fall back to a sequential queue (slower but correct).

**Warning signs:**
- Sub-calls succeed individually but fail intermittently under concurrency
- Memory grows linearly with concurrent session count and does not shrink after completion
- SDK errors that mention "session limit" or "concurrent calls"

**Phase to address:** Phase 1 (first task). This is explicitly flagged in PROJECT.md as needing
early validation. Validate before writing the orchestration layer.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Fixed-size character chunker | Fast to implement | Breaks semantic boundaries on all real code; must be replaced | Never — use language-aware boundaries from day one |
| Single cache key (chunk hash only, no instruction hash) | Simple cache API | Wrong answers silently served when query changes | Never — two-component key is required for correctness |
| Sequential sub-calls only (no concurrency) | No race conditions | map_reduce on large docs is unusably slow | MVP phase only — must be replaced in Phase 2 |
| No chunk limit on map_reduce | Simpler API surface | Runaway cost and memory on large docs | Never — the limit must exist before first release |
| `JSON.parse()` without markdown extraction | One-liner parsing | Crashes on markdown-wrapped JSON from models | Never — wrap in extraction layer from first sub-call |
| Hard-code truncation to `truncateHead()` | Consistent with other extensions | Loses most-relevant content when output is not front-loaded | Never — design output structure first, then truncate |
| Store only in memory (no disk persistence) | Simple implementation | Branch rehydration fails; store lost after session restart | MVP phase only if store IDs trigger clear re-load errors |

---

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Pi `result.details` | Treating `details` as durable storage across branches | Treat as a snapshot of last-known state; design tools to detect and recover from stale IDs |
| Pi `complete()` API | Calling without passing parent AbortSignal | Always propagate the parent tool's AbortSignal to sub-calls for cancellation |
| Pi `truncateHead()` | Applying before structuring output | Structure output (answer first, excerpts, metadata last), then truncate |
| Pi `registerTool()` TypeBox schema | Defining optional parameters with no defaults in execute() | Always provide defaults in execute() code, not just in the schema description |
| Pi `SessionManager.inMemory()` | Assuming concurrent use is safe | Validate concurrent use under load before building the concurrency pool on top of it |
| Pi context pressure hook | Firing too early (wrong threshold) | Calibrate threshold against actual Pi context usage measurement, not a guessed byte count |

---

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Unbounded concurrent sub-calls | Memory spike, process crash, API rate limit errors | Hard concurrency cap (8 concurrent), tested under load | Any document >20 chunks |
| Re-chunking on every query | Visible delay before first result on repeated queries | Cache chunk boundaries alongside chunk content | Documents >50KB, repeated queries |
| Synchronous chunk store scan for search | `rlm_search` latency grows linearly with store size | Index chunk embeddings or keyword tokens at load time | Stores >200 chunks |
| Full-document map_reduce when selective would suffice | Excessive token cost per query | Default to selective mode; require explicit user opt-in for map_reduce on large stores | First use on any document >100KB |
| Blocking event loop with large synchronous operations | Pi UI freezes during `rlm_load` of large files | Stream-read and chunk asynchronously; yield between chunks | Files >1MB |

---

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Storing chunk content in `result.details` verbatim | Sensitive source content exposed in Pi session history | Store only chunk IDs and metadata in `details`; keep content in the store only |
| No size limit on auto-load paste | Attacker-controlled content triggers OOM via giant paste | Cap auto-load input at a configurable maximum (e.g., 50MB) before chunking |
| Sub-call prompt includes raw user input without sanitization | Prompt injection: user's document content overrides sub-call instructions | Structure sub-call prompts so document content is in a clearly delimited user turn, never in the system prompt |

---

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| No progress feedback during map_reduce on large docs | Agent appears frozen for 30-60 seconds | Emit streaming progress: "Processing chunk 12/47..." in tool output |
| Generic "store not found" error on branch switch | User does not know how to recover | Include the re-load command in the error: "Run rlm_load <path> to restore" |
| Auto-load hook dismissal silently discards content | User's paste disappears; no indication it was lost | If dismissed, apply paste to context normally; never silently drop content |
| map_reduce output is prose, not structured | Agent cannot extract specific facts from synthesis | Enforce structured output (JSON or Markdown table) for map_reduce results |
| rlm_search returns chunk IDs the agent cannot use | Agent gets IDs but cannot act on them without rlm_extract | Chain: search returns excerpts directly, or include a clear "use rlm_extract with ID X to get full chunk" instruction |

---

## "Looks Done But Isn't" Checklist

- [ ] **Chunking:** Chunks look correct in unit tests on small files — verify on real Pi extension
  source (TypeScript with nested closures, JSX, long import blocks)
- [ ] **Sub-call isolation:** Sub-calls work with one session — verify 20 concurrent sessions
  complete independently without errors or memory leaks
- [ ] **Branch safety:** Works in linear conversation — verify that branching from after
  `rlm_load` and then calling `rlm_query` produces a clear, actionable error (not empty results)
- [ ] **Cache correctness:** Cache hits work — verify that changing only the query instruction
  (not the chunk) produces a cache miss and fresh result
- [ ] **Output truncation:** Short outputs look correct — verify an output exceeding 50KB/2000
  lines still presents the most relevant content in the visible portion
- [ ] **Abort propagation:** Happy path works — verify that aborting a multi-chunk map_reduce
  mid-flight terminates all in-progress sub-calls and does not leak sessions
- [ ] **Auto-load dismiss path:** Accept path works — verify dismiss path returns content to
  context normally
- [ ] **Cost estimation:** Query runs — verify that a 200-chunk document triggers a warning or
  confirmation before dispatching 200 sub-calls

---

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Broken semantic chunking | HIGH | Re-design split strategy, re-test all orchestration modes end-to-end |
| State rehydration bug discovered post-ship | MEDIUM | Add explicit re-load error with recovery instructions; add disk-backed persistence option |
| Cache key collision found after caching deployed | MEDIUM | Invalidate entire cache (accept full re-run penalty); fix key design; add regression test |
| Runaway cost from unbounded map_reduce | LOW | Add chunk limit cap; deploy; existing large queries are already incurred |
| Concurrent session instability discovered late | HIGH | Fall back to sequential queue; entire concurrency architecture may need redesign |
| Output truncation cuts relevant content | MEDIUM | Restructure output format (answer-first); no API changes required |

---

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Semantic chunking failure | Phase 1: Chunking + Store | Unit tests on real TypeScript source, not synthetic text |
| Sub-call prompt engineering failure | Phase 1: Sub-call wiring | Compare map_reduce vs. selective answers on identical question; must agree |
| State rehydration across branches | Phase 1: State model | Fork a session after rlm_load; rlm_query must return actionable error, not empty |
| Output truncation loses relevant content | Phase 1: Every tool | Generate output >50KB; verify answer appears in visible portion |
| Runaway token cost from fan-out | Phase 1: Orchestrator design | Assert max-chunk-count parameter exists and is enforced before first map_reduce call |
| Cache key collision/over-invalidation | Phase 1: Caching layer | Test: same chunk, different instruction → different cache entry |
| Structured output parsing failure | Phase 1: Sub-call abstraction | Inject markdown-wrapped JSON as sub-call response; assert extraction succeeds |
| Concurrency race conditions | Phase 1: Parallel pool | Abort test: mid-flight cancellation leaves 0 leaked sessions |
| Auto-load hook breaks normal pastes | Phase 1: Hooks | Dismiss test: paste is preserved in context after hook dismissed |
| In-process sub-call session isolation | Phase 1: First task (validation) | Concurrent session stress test (N=20) passes before any orchestration code written |

---

## Sources

- Pi extension source patterns: `pi-extensions/webfetch.ts`, `pi-extensions/exa-search.ts`,
  `pi-extensions/handoff/` (HIGH confidence — direct code inspection)
- Project constraints: `.planning/PROJECT.md` (HIGH confidence — authoritative for this project)
- General RLM/RAG chunking failure modes: inferred from first principles and well-documented
  RAG literature patterns (MEDIUM confidence — no specific published post-mortems for Pi RLM)
- Pi SDK sub-call pattern: `handoff/helpers.ts` use of `complete()` API (HIGH confidence on
  the API shape; MEDIUM confidence on concurrent-use behavior — untested per PROJECT.md)

---
*Pitfalls research for: Pi RLM extension — recursive long-context processing*
*Researched: 2026-02-23*
