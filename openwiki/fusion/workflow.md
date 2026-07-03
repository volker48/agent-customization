# Fusion Workflow

Fusion is a panel–judge–synthesis workflow: send one prompt to several models in parallel, have a judge produce a structured analysis of their responses, then have the calling model (the active Pi model) write the final answer grounded in that analysis. Modeled on OpenRouter Fusion.

## End-to-End Flow

```
User: /fusion <prompt>  or  /fusion --file <bundle-path> [prompt]
                    │
                    ▼
            ┌───────────────┐
            │  Load config  │  ~/.pi/agent/fusion.json
            │  Resolve args │  parseFusionArgs() → text or --file bundle
            └───────┬───────┘
                    │
                    ▼
            ┌───────────────────┐
            │  Resolve models   │  resolveModelRef() via Pi's ModelRegistry
            │  (panel + judge)  │  → ResolvedModel { model, apiKey, headers }
            └───────┬───────────┘
                    │
          ┌─────────┴─────────┐
          ▼                   ▼
┌─────────────────┐  ┌────────────────────┐
│  Meta-prompt     │  │  Panel models      │
│  (judge model)   │  │  (parallel)        │
│                  │  │                    │
│  Decompose task  │  │  Each answers the  │
│  into binary     │  │  prompt with       │
│  evaluation      │  │  web_search +      │
│  questions       │  │  webfetch tools    │
└────────┬────────┘  └─────────┬──────────┘
         │                      │
         └──────────┬───────────┘
                    ▼
            ┌───────────────────┐
            │  Judge            │  Uses binary questions to score
            │  (same model as   │  each panel response, then produces
            │   meta-prompt)    │  structured analysis
            └───────┬───────────┘
                    │
                    ▼
            ┌───────────────────┐
            │  Inject           │  pi.sendMessage(toFusionPanelMessage(result),
            │  fusion-panel     │    { triggerTurn: true })
            │  message          │
            └───────┬───────────┘
                    │
                    ▼
            ┌───────────────────┐
            │  Calling model    │  Active Pi model reads synthesis
            │  synthesizes      │  prompt, writes final answer as a
            │  final answer     │  normal assistant message
            └───────────────────┘
```

### Key Insight: Three Distinct Model Roles

1. **Panel models** — Independent inner models that answer the prompt in parallel with restricted web tools. They have no session context, no filesystem, no coding tools.
2. **Judge** — The model that generates binary evaluation questions (meta-prompt phase) and then scores panel responses + produces structured analysis. It does **not** write the final answer.
3. **Calling model** — The active Pi model at `/fusion` invocation time. It runs inside Pi's agent loop with full session context and tools. It reads the synthesis prompt and writes the final answer as a normal assistant message (so `/copy` works).

Per [ADR-0002](../../docs/adr/0002-the-calling-model-synthesizes-the-final-answer.md), the judge produces only analysis; the calling model synthesizes. This is a deliberate architecture decision — the calling model has session context the inner models lack.

## Orchestrator (`orchestrator.ts`)

`runFusion()` is the core function. It:

1. Resolves the judge and all panel models through `resolveModelRef()` → `ModelRegistryLike`
2. Creates the restricted inner tool set via `createFusionTools(config)`
3. Runs the **meta-prompt** (binary question generation) and **panel responses** in parallel via `Promise.all`
4. If all panel models fail → returns `status: "error"`
5. Runs the **judge** via `completeWithTools()` with the binary questions and successful panel responses
6. Parses judge output → `FusionJudgeOutput` with `questions`, `panelScores`, `analysis`
7. Computes confidence from pass rate → `"high" | "medium" | "low"`
8. Returns `FusionResult` with `status: "ok" | "degraded" | "error"`

**Degraded** means at least one panel model failed but the judge still ran. **Error** means all panels failed or the judge failed.

### Recovery on Judge Failure

If the judge fails but at least one panel succeeded, the orchestrator returns `status: "error"` but the command handler in `index.ts` still injects a synthesis prompt with a recovery warning. The calling model writes a best-effort answer from the raw panel responses.

## Configuration (`config.ts`)

Config is loaded from `~/.pi/agent/fusion.json` (override with `PI_FUSION_CONFIG`):

```json
{
  "judge": "anthropic/claude-sonnet-4-20250514",
  "models": [
    "openai/gpt-4o",
    "anthropic/claude-sonnet-4-20250514",
    "google/gemini-2.0-flash"
  ],
  "maxToolCalls": 8,
  "maxCompletionTokens": 4096,
  "reasoning": { "effort": "medium" },
  "webSearch": {
    "numResults": 5,
    "textMaxCharacters": 1000,
    "excludedDomains": ["pinterest.com"]
  },
  "webfetch": {
    "strategy": "smart",
    "maxChars": 20000,
    "blockedDomains": ["internal.company.com"]
  },
  "maxBinaryQuestions": 15,
  "debugLogPath": "/tmp/fusion-debug.jsonl"
}
```

### Validation

`validateFusionConfig()` enforces:
- `judge` — required string, must be `provider/model` format
- `models` — required non-empty array, max 8, no duplicates
- `maxToolCalls` — integer 0–64, default 8
- `maxBinaryQuestions` — integer 1–64, default 15
- `maxCompletionTokens` — positive integer
- `reasoning.effort` — one of `minimal`, `low`, `medium`, `high`, `xhigh`
- Unknown keys are rejected (strict validation)

## Model Resolution (`model-ref.ts`)

Model refs are `provider/model-id` strings, parsed on the **first** slash only so OpenRouter-style IDs like `openrouter/deepseek/deepseek-v4-pro` survive. Resolution goes through `ModelRegistryLike` — Pi's registry that handles API keys, headers, and auto-refreshed OAuth/subscription tokens.

## Model Runner (`model-runner.ts`)

`completeWithTools()` is the inner-model completion loop:

1. Sends system prompt + user prompt to the model via `CompletionClient.complete()`
2. If the model returns tool calls and `stopReason === "toolUse"`:
   - Checks tool budget (`maxToolCalls`)
   - If budget exceeded: injects `toolBudgetExceeded` results, continues with empty tools
   - Otherwise: executes allowed tools in parallel, appends results, loops
3. When the model returns text (no tool calls), extracts and returns content

The default `CompletionClient` uses `@earendil-works/pi-ai/compat`'s `completeSimple()`.

### Tool Budget Soft Cap

When a model exceeds `maxToolCalls`, the runner doesn't hard-fail. It injects a tool result saying the budget was exceeded, then continues the loop with an empty tools array so the model produces a final text answer.

## Prompts (`prompts.ts`)

### Panel System Prompt (`PANEL_SYSTEM_PROMPT`)

Instructs panel models to:
- Answer independently — no referencing other models, judges, or fusion
- Treat only the prompt and tool results as evidence (no hidden context)
- Use web tools for current/version-specific/safety-critical claims
- Prefer primary sources
- Be concise, put direct answer first

### Meta-Prompt (`buildMetaPrompt`)

Asks the judge model to decompose the task into at most `maxBinaryQuestions` atomic yes/no evaluation questions, grouped by named dimensions. Returns JSON: `{ "dimensions": [{ "name", "questions" }] }`.

### Judge System Prompt (`JUDGE_SYSTEM_PROMPT`)

Instructs the judge to:
- Answer each binary question independently for each panel response
- Store scores in `panelScores` as `Record<modelRef, Record<dimensionName, boolean[]>>`
- Ground contradiction detection in binary question disagreements
- Produce structured analysis: consensus, contradictions, partialCoverage, uniqueInsights, blindSpots, sourceQuality, risks
- **Not** write the final answer
- Penalize unsupported claims, hallucinated file access, fake citations, stale APIs

The DRACO evaluation stance (strict factual accuracy, no verbosity reward, prefer primary sources) is baked into the judge prompt. Fusion implements no DRACO rubric — it's a posture, not a scorer.

### Synthesis Prompt (`buildSynthesisPrompt`)

Read by the calling model. Contains:
- `SYNTHESIS_INSTRUCTIONS` — how to synthesize (ground claims, resolve contradictions, preserve unique insights)
- The user's original task
- Optional recovery warning (if judge failed)
- Judge analysis (JSON)
- Panel responses

### BinEval Binary Decomposition

The binary question approach is inspired by ["Ask, Don't Judge: Systematic Evaluation via Binary Decomposition"](https://arxiv.org/abs/2606.27226) (arXiv:2606.27226). The judge decomposes the task into yes/no questions, then answers them per panel response. This produces structured, comparable scores rather than holistic subjective judgments.

### Confidence Calculation

```typescript
passRate = total correct answers / total answers
high:   passRate > 0.8
medium: passRate ≥ 0.5
low:    passRate < 0.5
```

## Rendering (`render.ts`)

The `fusion-panel` custom message has two faces:
- **`content`** — The synthesis prompt (read by the calling model in LLM context as a user-role message)
- **`details`** — Metadata for TUI rendering as a compact card

The TUI card shows: panel size, judge model, confidence, and when expanded: per-model status, binary scores, and full analysis sections.

## Progress & Debug Logging

### Progress (`progress.ts`)

`ProgressState` tracks panel and judge status through phases: `loading config` → `resolving models` → `running panel` → `waiting for judge` → `running judge` → `complete`. Rendered as a `BorderedLoader` widget with per-model status icons (✓ ✗ … •).

### Debug Logging (`debug-log.ts`)

JSONL debug log at `config.debugLogPath` or `PI_FUSION_LOG` or `~/.pi/agent/fusion-debug.jsonl` (when `PI_FUSION_DEBUG=1`). Logs: `command-started`, `progress` events, `result`, `synthesis-triggered`, `cancelled`/`failed`.

## Command Entry Point (`index.ts`)

The `/fusion` command handler:

1. Parses args (`parseFusionArgs`) — plain text or `--file <path>` bundle
2. Loads config (`loadFusionConfig`)
3. Resolves prompt (reads bundle file if `--file` was given, concatenates with optional text)
4. Creates debug logger if configured
5. Runs `runFusion()` with progress callbacks
6. If all panels failed → notifies error, returns
7. If judge failed but panels succeeded → notifies error, continues to synthesis with recovery
8. Injects `fusion-panel` message via `pi.sendMessage(..., { triggerTurn: true })`
9. The calling model immediately produces the final answer

The `triggerTurn: true` flag is critical — it tells Pi to run the agent loop immediately so the calling model synthesizes the answer right away.

## Types (`types.ts`)

Key types:

| Type | Purpose |
|---|---|
| `FusionConfig` | Config shape loaded from `fusion.json` |
| `PanelResponse` / `FailedPanelResponse` | Typed panel outcomes (success carries content, failure carries error) |
| `FusionAnalysis` | 7 analysis arrays: consensus, contradictions, partialCoverage, uniqueInsights, blindSpots, sourceQuality, risks |
| `BinaryDimension` | Named group of yes/no questions |
| `FusionJudgeOutput` | questions + panelScores + analysis |
| `FusionResult` | Final result: status, responses, judgeOutput, confidence, elapsed |
| `FusionProgressEvent` | Discriminated union for progress events |
| `ResolvedModel` | Model + API key + headers from registry |
| `ModelRegistryLike` | Subset of Pi's ModelRegistry that Fusion depends on |
| `CompletionClient` | Abstraction over model completion calls (injectable for testing) |
| `FusionTool` | Inner tool interface: name, description, parameters, execute |

## Source Map

- [`pi-extensions/fusion/orchestrator.ts`](../../pi-extensions/fusion/orchestrator.ts) — `runFusion()` main flow
- [`pi-extensions/fusion/index.ts`](../../pi-extensions/fusion/index.ts) — `/fusion` command registration and handler
- [`pi-extensions/fusion/config.ts`](../../pi-extensions/fusion/config.ts) — Config loading and validation
- [`pi-extensions/fusion/types.ts`](../../pi-extensions/fusion/types.ts) — All TypeScript types
- [`pi-extensions/fusion/prompts.ts`](../../pi-extensions/fusion/prompts.ts) — System prompts, meta-prompt, judge prompt, synthesis prompt
- [`pi-extensions/fusion/model-runner.ts`](../../pi-extensions/fusion/model-runner.ts) — `completeWithTools()` completion loop
- [`pi-extensions/fusion/model-ref.ts`](../../pi-extensions/fusion/model-ref.ts) — Model ref parsing and resolution
- [`pi-extensions/fusion/render.ts`](../../pi-extensions/fusion/render.ts) — TUI rendering and synthesis message construction
- [`pi-extensions/fusion/progress.ts`](../../pi-extensions/fusion/progress.ts) — Progress state machine
- [`pi-extensions/fusion/debug-log.ts`](../../pi-extensions/fusion/debug-log.ts) — JSONL debug logger
- [`pi-extensions/fusion/args.ts`](../../pi-extensions/fusion/args.ts) — Argument parsing (`--file` support)
- [`docs/adr/0002-the-calling-model-synthesizes-the-final-answer.md`](../../docs/adr/0002-the-calling-model-synthesizes-the-final-answer.md) — Calling model decision
