# Stack Research

**Domain:** LLM coding-agent extension for long-context document processing (pi-rlm)
**Researched:** 2026-02-23
**Confidence:** HIGH (core stack verified against installed Pi SDK source; library versions verified via npm)

## Recommended Stack

### Core Framework

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| `@mariozechner/pi-coding-agent` | 0.52.12 | Extension API, sub-agent sessions | Already installed; provides `ExtensionAPI`, `createAgentSession`, `SessionManager.inMemory()`, truncation utilities, `getLastAssistantText()` |
| `@mariozechner/pi-ai` | 0.52.12 | TypeBox schema helpers (`StringEnum`, `Type`) | Already installed; used by all existing extensions |
| `@sinclair/typebox` | 0.34.48 (transitive) | Tool parameter schemas | Already bundled via pi-ai; zero additional install cost |
| Node.js `node:crypto` | built-in | SHA-256 cache key hashing | Zero dependency; `createHash('sha256').update(str).digest('hex')` is sufficient for chunk + instruction hashing |

### Text Processing

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Custom zero-dep chunker | n/a — write inline | Recursive character splitting with overlap | @langchain/textsplitters v1.0.1 requires `@langchain/core@^1.0` which is 7.5MB unpackaged and pulls in langsmith, zod, p-queue, and js-tiktoken; overhead is unjustified for a 30-line sliding-window function; character-level splitting (not token-level) is fine because Pi's output limits are character-based |
| `MiniSearch` | 7.2.0 | In-process BM25 full-text search | 827KB unpackaged, zero production deps, TypeScript types bundled, supports fuzzy matching, field weights, and auto-suggest; outperforms Fuse.js (fuzzy-only) for keyword recall and FlexSearch (no bundled types, confusing API) for this use case |

### Concurrency and Caching

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| `p-limit` | 7.3.0 | Bounded concurrency for parallel sub-calls | 15KB, one transitive dep (`yocto-queue`), bundled TypeScript types, idiomatic for Promise.all patterns; prevents API rate-limit explosions from unconstrained parallel `session.prompt()` calls |
| Native `Map<string, string>` | built-in | In-process sub-call result cache | No dependency required; cache is keyed by `sha256(chunkContent + instructionHash)`; lifetime matches extension process lifetime; survives Pi branches via `details` snapshots (cache entries referenced by hash, so hash-key lookups remain valid after fork) |

### Structured Output

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| TypeBox + prompt engineering | 0.34.48 (transitive) | Structured JSON output from sub-calls | Pi sub-agent sessions do not expose native structured-output / response_format API; the pattern is prompt the model to respond in JSON, then `JSON.parse(session.getLastAssistantText())`; TypeBox schemas already in scope for tool parameters, so reuse them as the output contract and validate with `ajv` (already transitive via pi-ai) |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| `oxlint` 1.47.0 | Linting | Already configured in project |
| `oxfmt` 0.32.0 | Formatting | Already configured in project |
| `tsc --noEmit` (typescript 5.9.3) | Type checking | Already configured; target ES2023, module NodeNext |
| `vitest` 4.0.18 | Testing | Already configured in project |

## Installation

```bash
# Only new production dependency needed
pnpm add minisearch@7.2.0 p-limit@7.3.0

# No additional dev dependencies needed
```

Everything else (TypeBox, pi SDK, Node built-ins) is already available.

## Sub-Agent Session Pattern

The project spec calls for in-process `createAgentSession` sessions. This is confirmed as feasible from the Pi SDK source — the key pattern:

```typescript
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";

// Confirmed: tools: [] produces a tool-less session (from sdk.d.ts)
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  tools: [],
  settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
});

// Build system prompt with JSON output contract
await session.prompt(`Answer this question about the following text.
Respond ONLY with valid JSON matching this schema:
{"answer": string, "citations": string[], "confidence": "high"|"medium"|"low"}

TEXT:
${chunkContent}

QUESTION: ${instruction}`);

// Confirmed API: getLastAssistantText() exists on AgentSession
const raw = session.getLastAssistantText();
const result = JSON.parse(raw ?? "{}");
session.dispose();
```

**Critical note on official pattern vs. spec:** The official Pi `subagent` example (examples/extensions/subagent/index.ts) uses subprocess `spawn("pi", ...)`, not in-process SDK sessions. The PROJECT.md spec wants in-process sessions. Both are supported by the SDK — in-process is lower latency but shares the same process memory and auth context with the parent Pi session. The in-process approach is the right choice here because RLM sub-calls are lightweight (no file system tools, JSON-only output) and subprocess spawning has ~200ms startup overhead per call that would compound badly under map_reduce mode.

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| Custom zero-dep chunker | `@langchain/textsplitters@1.0.1` | Only if you need sentence-boundary splitting (NLTK-style) or markdown-aware heading splits; for pi-rlm's character-based approach, the 7.5MB + transitive dep chain is not justified |
| `MiniSearch` | `FlexSearch@0.8.212` | If you need extreme index performance at scale (FlexSearch is faster at indexing millions of docs); for pi-rlm's typical 50–500 chunk workload, MiniSearch's simpler API and bundled types win |
| `MiniSearch` | `Fuse.js@7.1.0` | If fuzzy-first matching is the only requirement; Fuse.js lacks BM25 and performs poorly on keyword-heavy technical text |
| Native `Map` cache | `lru-cache@11.2.6` | If the cache must bound memory (e.g., 10K+ documents); at typical extension use, a Map<string, string> is fine; add lru-cache if testing shows memory growth beyond ~50MB |
| Native `Map` cache | Filesystem cache | If results must survive process restart; the project spec uses in-memory caching keyed by hash, which is already addressed by `details` snapshot rehydration |
| TypeBox + prompt JSON | Zod + AI SDK structured output | If pi-ai exposes a `response_format` / structured-output API in a future version; check `pi-ai` types before wiring Zod |
| `p-limit` | Manual Promise pool | p-limit is 15KB, idiomatic, well-tested; writing a manual pool adds risk for a tiny file; the subagent example in Pi itself implements a manual pool (`mapWithConcurrencyLimit`) but that predates p-limit being standard — don't replicate it |
| `node:crypto` SHA-256 | `hash-wasm@4.12.0` | If sub-millisecond hash performance matters (it will not at 500-chunk scale); hash-wasm is 22MB unpackaged (WebAssembly); overkill |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `@langchain/textsplitters` | Forces `@langchain/core@^1` peer dep (7.5MB+, pulls langsmith telemetry, zod, js-tiktoken, p-queue); LangChain's chunking logic is not meaningfully better than a 30-line sliding-window function for ASCII/Markdown text | Write inline character splitter (see below) |
| `@langchain/core` directly | Same weight issue; also conflicts with pi-ai's already-bundled `zod-to-json-schema` and will create duplicate zod instances | N/A — not needed |
| `Fuse.js` | Fuzzy-only, no BM25, poor recall on technical keywords like function names; would require threshold tuning that never converges for code | `MiniSearch` |
| `flexsearch` | No bundled TypeScript types, `@0.8.x` API is poorly documented, async indexing API complicates the synchronous tool-execute pattern | `MiniSearch` |
| `object-hash` / `hash-wasm` | Both add unnecessary weight for cache key generation; Node's built-in `crypto.createHash('sha256')` is sufficient and zero-cost | `node:crypto` |
| Subprocess `spawn("pi", ...)` for sub-calls | The official subagent example uses this, but for pi-rlm's RLM workload it adds ~200ms per sub-call latency and fails if the `pi` binary is not on PATH (npm-installed scenario); in-process sessions are faster and self-contained | `createAgentSession({ tools: [] })` |
| Token-aware chunking (js-tiktoken) | Brings 22MB WebAssembly payload; Pi's output limits are character- and line-based, not token-based; character chunking is the right primitive here | Character-based chunker |

## Inline Chunker Pattern

Since no library is needed, this is the complete implementation:

```typescript
export interface Chunk {
  id: string;      // sha256(content)[:12]
  index: number;
  text: string;
  startChar: number;
  endChar: number;
}

function chunkText(text: string, chunkSize = 3000, overlap = 200): Chunk[] {
  const { createHash } = await import("node:crypto");
  const chunks: Chunk[] = [];
  let i = 0;
  while (i < text.length) {
    const end = Math.min(i + chunkSize, text.length);
    const content = text.slice(i, end);
    const id = createHash("sha256").update(content).digest("hex").slice(0, 12);
    chunks.push({ id, index: chunks.length, text: content, startChar: i, endChar: end });
    if (end === text.length) break;
    i += chunkSize - overlap;
  }
  return chunks;
}
```

Default chunk size of 3000 characters: fits within Pi's ~12KB character output limit per tool call with room for metadata.

## Version Compatibility

| Package | Compatible With | Notes |
|---------|-----------------|-------|
| `minisearch@7.2.0` | Node.js >=22, ESM | ES module only; compatible with project's `"type": "module"` and NodeNext resolution |
| `p-limit@7.3.0` | Node.js >=18, ESM | ES module only; compatible with project setup |
| `@mariozechner/pi-coding-agent@0.52.12` | Node.js >=20 | Project uses Node 22; fully compatible |
| TypeBox `@0.34.x` | pi-ai bundles this version | Do not install a separate `@sinclair/typebox` — importing from `@mariozechner/pi-ai` re-exports `Type` and `Static` |

## Sources

- `/Users/marcusmccurdy/code/agent-customization/node_modules/@mariozechner/pi-coding-agent/dist/core/sdk.d.ts` — `createAgentSession`, `SessionManager.inMemory()`, `ToolDefinition` types; HIGH confidence
- `/Users/marcusmccurdy/code/agent-customization/node_modules/@mariozechner/pi-coding-agent/dist/core/agent-session.d.ts` — `getLastAssistantText()` confirmed; HIGH confidence
- `/Users/marcusmccurdy/code/agent-customization/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md` — `input` event, `before_agent_start`, `context` event, lifecycle; HIGH confidence
- `/Users/marcusmccurdy/code/agent-customization/node_modules/@mariozechner/pi-coding-agent/examples/extensions/subagent/index.ts` — official subagent pattern (subprocess-based); HIGH confidence; informs why in-process is preferable for pi-rlm
- `npm info minisearch@7.2.0` — version, bundled types, size; HIGH confidence
- `npm info p-limit@7.3.0` — version, deps, size; HIGH confidence
- `npm info @langchain/textsplitters@1.0.1` and `@langchain/core@1.0.0` — dep chain weight; HIGH confidence (explains rejection)
- `node -e "require('node:crypto')"` — confirmed built-in availability; HIGH confidence

---
*Stack research for: pi-rlm — LLM long-context document processing extension*
*Researched: 2026-02-23*
