# Architecture Research

**Domain:** Long-context processing extension for Pi coding agent (RLM pattern)
**Researched:** 2026-02-23
**Confidence:** HIGH — Based on Pi SDK source docs read directly from installed node_modules

## Standard Architecture

### System Overview

```
┌────────────────────────────────────────────────────────────────────┐
│                     Pi Agent (host process)                         │
│                                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐             │
│  │  Tool Layer  │  │  Hook Layer  │  │  State Layer │             │
│  │              │  │              │  │              │             │
│  │ rlm_load     │  │ input hook   │  │ details[]    │             │
│  │ rlm_search   │  │ context hook │  │ branch tree  │             │
│  │ rlm_extract  │  │              │  │              │             │
│  │ rlm_query    │  │              │  │              │             │
│  │ rlm_buffer   │  │              │  │              │             │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘             │
│         │                 │                  │                      │
│  ┌──────┴─────────────────┴──────────────────┴───────────────┐     │
│  │              pi-rlm Extension Entry (index.ts)             │     │
│  └──────────────────────────────┬────────────────────────────┘     │
└─────────────────────────────────┼──────────────────────────────────┘
                                  │
              ┌───────────────────┼──────────────────┐
              │                   │                  │
              ▼                   ▼                  ▼
┌─────────────────────┐ ┌──────────────────┐ ┌──────────────────────┐
│   Document Store    │ │  Sub-call Runner │ │   Result Cache       │
│                     │ │                  │ │                      │
│ ChunkStore (Map)    │ │ createAgentSession│ │ Map<hash, output>    │
│ chunk_id → text     │ │ SessionManager   │ │ chunkHash+instrHash  │
│ metadata (source,   │ │   .inMemory()    │ │ → JSON result        │
│  offset, length)    │ │ tools: []        │ │                      │
│                     │ │ structured JSON  │ │                      │
│ NamedBuffer (Map)   │ │ bounded concurr. │ │                      │
│ name → text         │ │                  │ │                      │
└─────────────────────┘ └──────────────────┘ └──────────────────────┘
              │                   │
              ▼                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Chunking Pipeline                                 │
│                                                                      │
│  text input → split() → [{id, text, offset, source}] → ChunkStore  │
└─────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Typical Implementation |
|-----------|----------------|------------------------|
| Extension Entry (`index.ts`) | Register tools + hooks, compose all sub-modules | Default export fn receiving `ExtensionAPI` |
| Tool Layer | Expose 5 tools to the LLM agent | `pi.registerTool()` per tool, TypeBox schemas |
| Hook Layer | Intercept input events for auto-load; monitor context usage | `pi.on("input")`, `pi.on("context")` |
| ChunkStore | In-memory store mapping chunk_id → text + metadata | Plain `Map<string, Chunk>` per-session, rebuilt from `details` on branch change |
| NamedBuffer | Key-value store for intermediate artifacts | Plain `Map<string, string>`, same branch-rebuild pattern |
| Chunking Pipeline | Split raw text into bounded chunks with stable IDs | Pure function: `chunk(text, source) → Chunk[]` |
| Sub-call Runner | Run isolated Pi SDK sessions to process chunks | `createAgentSession({ sessionManager: SessionManager.inMemory(), tools: [] })` |
| Result Cache | Cache sub-call outputs by content hash | `Map<string, string>` keyed by `sha1(chunkText + instruction)` |
| Orchestration Modes | selective / map_reduce / tree strategies | Three pure async functions called from `rlm_query.execute()` |

## Recommended Project Structure

```
src/
├── index.ts                # Extension entry — registers all tools and hooks
├── store/
│   ├── chunk-store.ts      # ChunkStore: in-memory Map + branch rehydration
│   ├── buffer-store.ts     # NamedBuffer: in-memory Map + branch rehydration
│   └── types.ts            # Chunk, Buffer, StoreState types
├── chunking/
│   ├── chunker.ts          # split text → Chunk[] with stable IDs
│   └── types.ts            # Chunk type definition
├── tools/
│   ├── rlm-load.ts         # rlm_load: chunk + store text
│   ├── rlm-search.ts       # rlm_search: keyword/embedding search over ChunkStore
│   ├── rlm-extract.ts      # rlm_extract: fetch span by chunk_id or char range
│   ├── rlm-query.ts        # rlm_query: orchestrate sub-calls, synthesize
│   └── rlm-buffer.ts       # rlm_buffer: get/set/list named buffers
├── orchestration/
│   ├── selective.ts        # selective mode: search-narrow then sub-call
│   ├── map-reduce.ts       # map_reduce mode: parallel sub-calls + synthesis
│   ├── tree.ts             # tree mode: hierarchical summarization
│   ├── sub-runner.ts       # createAgentSession wrapper, concurrency control
│   └── cache.ts            # Result cache keyed by chunk+instruction hash
└── hooks/
    ├── auto-load.ts        # input hook: detect large paste, offer externalize
    └── context-pressure.ts # context hook: detect high usage, hint rlm_query
```

### Structure Rationale

- **store/:** Isolated because it owns the branching-safe rehydration logic. Both tools and hooks read from it. Changes to branching semantics stay here.
- **chunking/:** Pure functions, no Pi API dependency. Testable in isolation, can be swapped later (e.g., token-aware chunking).
- **tools/:** One file per tool. Each imports from `store/`, `orchestration/` as needed. Follows Pi's single-responsibility pattern seen in built-in tools.
- **orchestration/:** Isolated from tools so modes can be unit-tested without spawning Pi sessions. `sub-runner.ts` is the only file with a Pi SDK dependency.
- **hooks/:** Separated from tools because hooks fire on Pi lifecycle events, not tool calls. Each hook is a single listener.

## Architectural Patterns

### Pattern 1: Branch-Safe State via `details` Snapshots

**What:** Every RLM tool returns the full current store state in `result.details`. On `session_start` (and on every `session_before_tree` / `session_before_fork`), the extension rebuilds in-memory state by walking `ctx.sessionManager.getBranch()` and reading `entry.message.details` from the most recent `rlm_*` tool result.

**When to use:** Always. This is Pi's canonical pattern for stateful extensions. It guarantees that branching (forking, `/tree` navigation) automatically inherits the correct store snapshot without any extra persistence layer.

**Trade-offs:** Details are serialized into every tool result. For large stores this could bloat the session file. Mitigate by storing only chunk IDs + metadata in details, not the chunk text itself. The text lives in the in-memory Map and is populated from a separate persistence key (or simply lost on restart, which is acceptable for a session-scoped store).

**Example:**
```typescript
// store/chunk-store.ts
export function rehydrateFromBranch(entries: SessionEntry[]): ChunkStore {
  const store = new ChunkStore();
  // Walk branch oldest-to-newest; each rlm_* toolResult overwrites store state
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (msg.role !== "toolResult") continue;
    if (!msg.toolName.startsWith("rlm_")) continue;
    if (msg.details?.chunks) {
      store.replace(msg.details.chunks);
    }
  }
  return store;
}

// In tool execute():
return {
  content: [{ type: "text", text: summary }],
  details: {
    chunks: store.snapshot(),   // Array of { id, source, offset, length }
    buffers: bufferStore.snapshot(),
  },
};
```

### Pattern 2: In-Process Sub-Calls via Pi SDK

**What:** Each chunk-level sub-call uses `createAgentSession({ sessionManager: SessionManager.inMemory(), tools: [] })` to spawn an isolated, tool-less agent session that produces structured JSON output. The session runs entirely in-process — no `exec()`, no subprocess spawning.

**When to use:** For all map/reduce leaves and tree summarization nodes. The in-process approach avoids process spawn overhead and integrates cleanly with Pi's native auth and model registry.

**Trade-offs:**
- Con: In-process sessions share the Node.js event loop; true parallelism requires Promise.all with bounded concurrency, not actual threads.
- Con: SDK sub-sessions are not yet battle-tested for RLM-scale workloads (per PROJECT.md). Must validate early with concurrency + long chunk inputs.
- Pro: Full type safety, no serialization overhead, abort signal propagation works natively.

**Example:**
```typescript
// orchestration/sub-runner.ts
import { createAgentSession, SessionManager } from "@mariozechner/pi-coding-agent";

export async function runSubCall(
  instruction: string,
  chunkText: string,
  signal: AbortSignal,
): Promise<string> {
  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    tools: [],  // tool-less: structured output only
  });

  let result = "";
  session.subscribe((event) => {
    if (event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta") {
      result += event.assistantMessageEvent.delta;
    }
  });

  await session.prompt(
    `${instruction}\n\n---\n${chunkText}\n\nRespond with JSON only.`,
  );
  session.dispose();
  return result;
}
```

### Pattern 3: Bounded Concurrency with p-limit (or manual semaphore)

**What:** map_reduce mode fans out sub-calls across all chunks. Unbounded parallelism will hit API rate limits and overwhelm the event loop. Cap concurrent in-flight sessions at a configurable limit (default: 4, same as Pi's subagent example).

**When to use:** Any fan-out across N chunks where N > concurrency limit.

**Trade-offs:** Adds complexity. A simple manual semaphore avoids the `p-limit` dependency (Pi already bundles nothing for concurrency). A semaphore is ~10 lines of TypeScript.

**Example:**
```typescript
// orchestration/map-reduce.ts
async function mapReduce(
  chunks: Chunk[],
  instruction: string,
  signal: AbortSignal,
  maxConcurrent = 4,
): Promise<string> {
  const semaphore = new Semaphore(maxConcurrent);
  const results = await Promise.all(
    chunks.map((chunk) =>
      semaphore.run(() => runCachedSubCall(instruction, chunk, signal))
    )
  );
  return synthesize(results, instruction, signal);
}
```

### Pattern 4: Chunking by Character Count with Overlap

**What:** Split text on paragraph boundaries (double newline), accumulating characters until `MAX_CHUNK_CHARS` (default 4000 chars ≈ 1000 tokens), then start a new chunk. Overlap the last N characters of the previous chunk into the next to preserve cross-boundary context.

**When to use:** Default chunking for all `rlm_load` calls. Override with sentence-boundary splitting for prose, or line-boundary splitting for code.

**Trade-offs:** Character count is a proxy for token count. 4000 chars is conservative (most code is ~3 chars/token). Token-aware chunking is more accurate but requires a tokenizer dependency — defer to Phase 3.

## Data Flow

### rlm_load Flow

```
Agent calls rlm_load(source, text)
    │
    ▼
chunker.split(text, source)
    │ returns Chunk[]
    ▼
ChunkStore.add(chunks)
    │ keyed by sha1(source + offset)
    ▼
tool returns:
  content: "Loaded N chunks from <source>"
  details: { chunks: store.snapshot(), buffers: bufferStore.snapshot() }
    │
    ▼
Pi session: toolResult message written to session JSONL
  (details persisted in session tree — branch-safe)
```

### rlm_query (map_reduce mode) Flow

```
Agent calls rlm_query(question, mode="map_reduce")
    │
    ▼
orchestration/map-reduce.ts
    │
    ├── for each Chunk in ChunkStore (or filtered subset):
    │     cache.get(hash(chunk.text + question))
    │         hit  → return cached string
    │         miss → sub-runner.runSubCall(question, chunk.text, signal)
    │                    → createAgentSession(inMemory, tools=[])
    │                    → session.prompt(question + chunk)
    │                    → collect text_delta events
    │                    → session.dispose()
    │                    → cache.set(hash, result)
    │                (bounded by Semaphore(4))
    │
    ├── collect all per-chunk results
    │
    └── synthesize(results, question, signal)
          → sub-runner.runSubCall(synthesisPrompt, joined results, signal)
          → return final answer string
    │
    ▼
tool returns:
  content: final answer (truncated to 50KB if needed)
  details: { chunks: store.snapshot(), buffers: bufferStore.snapshot(),
             queryMode: "map_reduce", sourceChunks: N }
```

### State Persistence Flow (Branch-Safe)

```
User: /fork (branches session)
    │
    ▼
Pi: session_before_fork event fires
    │  (extension can observe, no action needed here)
    ▼
Pi: creates new session file at fork point
    │
    ▼
User resumes forked branch
    │
    ▼
Pi: session_start event fires
    │
    ▼
Extension: rehydrateFromBranch(ctx.sessionManager.getBranch())
    │  Walks entries, finds last rlm_* toolResult, reads details.chunks
    ▼
ChunkStore rebuilt correctly for this branch
    │
    ▼
Agent continues: rlm_search, rlm_query work against correct branch state
```

### Auto-Load Hook Flow

```
User pastes large text (> threshold chars) into Pi editor
    │
    ▼
Pi: input event fires (event.text = pasted content)
    │
    ▼
Hook: auto-load.ts checks len(event.text) > AUTO_LOAD_THRESHOLD (e.g. 10000 chars)
    │
    ├── yes: ctx.ui.confirm("Large input detected", "Externalize to RLM store?")
    │           confirmed → transform event to call rlm_load internally
    │                       (or return { action: "transform", text: injected_call })
    │           denied   → return { action: "continue" }
    │
    └── no: return { action: "continue" }
```

### Context Pressure Hook Flow

```
Pi: context event fires before each LLM call
    │
    ▼
Hook: context-pressure.ts reads ctx.getContextUsage()
    │
    ├── usage.tokens > PRESSURE_THRESHOLD (e.g. 80% of contextWindow):
    │     inject custom message into event.messages:
    │     "Context window is getting full. Consider using rlm_query instead
    │      of pasting more content."
    │     return { messages: modified }
    │
    └── below threshold: return undefined (no modification)
```

## Scaling Considerations

| Scale | Architecture Adjustments |
|-------|--------------------------|
| Small docs (< 50K chars) | Single rlm_load + selective mode. No concurrency needed. |
| Medium docs (50K–500K chars) | map_reduce with default concurrency (4). In-process sub-calls. |
| Large docs (500K+ chars) | tree mode for hierarchical reduction. Chunk count may require two-pass (summarize summaries). |
| Repo indexing (Phase 3) | Persistent store (SQLite or flat file index) replaces in-memory Map. Embedding-based search replaces keyword search. |

### Scaling Priorities

1. **First bottleneck:** API rate limits on map_reduce fan-out. Fix: exponential backoff in sub-runner, configurable concurrency limit.
2. **Second bottleneck:** Session JSONL bloat from large `details` snapshots. Fix: store only chunk metadata (ids + offsets) in details, not full text. Full text is ephemeral (in-memory only, lost on restart).

## Anti-Patterns

### Anti-Pattern 1: Sub-Calls with Tools Enabled

**What people do:** Pass standard coding tools (`readTool`, `bashTool`) to sub-call sessions so the sub-agent can "look things up."

**Why it's wrong:** Sub-calls must produce deterministic, bounded JSON output. Tools introduce non-determinism (filesystem reads), uncontrolled output size, and the risk of the sub-agent spawning further tool chains. PROJECT.md explicitly requires sub-calls to be tool-less.

**Do this instead:** Pre-load relevant text via `rlm_load`. Pass only the needed text in the sub-call prompt. If the sub-agent needs more context, that is a sign the chunk selection (selective mode) needs improvement — not that the sub-agent should have tools.

### Anti-Pattern 2: Global In-Memory State Without Branch Rehydration

**What people do:** Store the ChunkStore in a module-level variable and mutate it directly, assuming it persists across tool calls.

**Why it's wrong:** Pi's branch model means the conversation tree can navigate to different points. A module-level variable will reflect the wrong branch after `/fork` or `/tree` navigation. The extension docs are explicit: stateful tools must rebuild state from `ctx.sessionManager.getBranch()` on `session_start`.

**Do this instead:** On every `session_start` event, call `rehydrateFromBranch()` to rebuild ChunkStore from the branch's toolResult `details`. The rehydrate function is idempotent and fast (details are already parsed JSON).

### Anti-Pattern 3: Returning Untruncated Sub-Call Results to the Agent

**What people do:** Pass the raw concatenated sub-call outputs directly as tool `content`, without checking size.

**Why it's wrong:** Pi enforces a 50KB / 2000-line hard limit on tool output. Exceeding it causes context overflow or truncation that Pi may not communicate clearly to the agent. The agent may also get confused by very large tool results and lose coherence.

**Do this instead:** Apply `truncateHead()` from Pi's built-in utilities to all tool content. If the full result is larger, write it to a `rlm_buffer` and return a reference: "Full result stored in buffer 'query-result-1'. Use rlm_buffer(action='get', name='query-result-1') to retrieve."

### Anti-Pattern 4: Chunking on Fixed Byte Boundaries

**What people do:** Split text every N bytes to keep chunk sizes predictable.

**Why it's wrong:** Fixed byte splits break mid-word and mid-sentence, making chunk boundaries semantically meaningless. Sub-call quality degrades significantly because the LLM gets partial sentences at the start and end of every chunk.

**Do this instead:** Split on paragraph boundaries (double newline), accumulating to a byte budget. If a single paragraph exceeds the budget, split on sentence end (`. `, `! `, `? `). This keeps semantic units intact while bounding chunk size.

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| LLM API (via Pi's auth) | `createAgentSession()` reuses host's `AuthStorage` / `ModelRegistry` | Sub-calls inherit the configured model; no separate API key needed |
| Pi Session JSONL | Write via `details` on toolResult; read via `ctx.sessionManager.getBranch()` | This is the only persistence mechanism — no DB, no files |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| Extension entry ↔ Tool modules | Direct import | Tools are plain TypeScript modules, no Pi API coupling except in `execute()` |
| Tool modules ↔ ChunkStore | Direct import | ChunkStore is a plain class, no Pi dependency |
| Tool modules ↔ Sub-runner | Direct import | Sub-runner imports Pi SDK; keep isolated so it can be mocked in tests |
| Auto-load hook ↔ ChunkStore | Direct import | Hook reads threshold from config, calls `chunker.split()` and `store.add()` |
| Context hook ↔ ChunkStore | Read-only (len check) | Hook only reads chunk count, does not mutate store |
| Orchestration modes ↔ Cache | Direct import | Cache is a plain Map, no Pi dependency |
| Extension entry ↔ Pi `session_start` | `pi.on("session_start")` event | Triggers store rehydration |
| Extension entry ↔ Pi `input` event | `pi.on("input")` | Auto-load hook entry point |
| Extension entry ↔ Pi `context` event | `pi.on("context")` | Context pressure hook entry point |

## Build Order (Phase Dependencies)

The architecture suggests this build sequence, each step unblocking the next:

```
1. ChunkStore + Chunker (pure, no Pi dep)
   → testable immediately, no Pi SDK needed

2. rlm_load + rlm_extract + rlm_search tools
   → depend on ChunkStore; no sub-calls
   → validates store rehydration via details

3. Sub-runner + Cache
   → Pi SDK dependency; validate in-process sessions work for RLM payloads
   → CRITICAL VALIDATION STEP (per PROJECT.md)

4. Orchestration modes (selective, map_reduce, tree)
   → depend on sub-runner; need chunker + store working

5. rlm_query tool
   → wires orchestration modes; depends on everything above

6. rlm_buffer tool
   → simple; can be built in parallel with step 3

7. Hooks (auto-load, context-pressure)
   → depend on ChunkStore + chunker; Pi API only
   → build last, as they enhance UX but are not core to correctness
```

**Key dependency:** Steps 1–2 can proceed without validating the in-process sub-call pattern. Step 3 is the technical risk gate; if Pi's SDK sessions cannot handle RLM-scale prompts reliably, the orchestration design may need adjustment (e.g., fall back to `exec pi -p` subprocess). Validate step 3 before committing to steps 4–5.

## Sources

- Pi extension API: `/Users/marcusmccurdy/code/agent-customization/node_modules/.pnpm/@mariozechner+pi-coding-agent@0.52.12_ws@8.19.0_zod@4.1.8/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md` (HIGH confidence — source package docs)
- Pi SDK: `.../docs/sdk.md` (HIGH confidence — source package docs)
- Pi session format: `.../docs/session.md` (HIGH confidence — source package docs)
- Pi compaction: `.../docs/compaction.md` (HIGH confidence — source package docs)
- Pi subagent example: `.../examples/extensions/subagent/README.md` (HIGH confidence — reference implementation)
- Project context: `/Users/marcusmccurdy/code/agent-customization/.planning/PROJECT.md`

---
*Architecture research for: Pi RLM extension (long-context processing for coding agents)*
*Researched: 2026-02-23*
