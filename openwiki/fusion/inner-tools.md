# Fusion Inner Tools & Bundling

## Restricted Projection (ADR-0001)

Fusion runs untrusted **inner models** (panel models and judge) directly via the AI completion API, outside Pi's agent loop. These models get exactly two tools: `web_search` and `webfetch`. The hand-written two-tool list in `createFusionTools()` is the allowlist — its explicitness is the security control.

The inner tools share their **implementation** with the standalone extensions (both call the deep cores in `pi-extensions/lib/`), but deliberately do **not** share their **interface**:

| Aspect | Standalone (`exa_search` / `webfetch`) | Fusion inner (`web_search` / `webfetch`) |
|---|---|---|
| Exa search name | `exa_search` | `web_search` (renamed) |
| Parameters | Full model-controlled surface | Narrowed surface |
| Search type | Model chooses | Operator-controlled via config |
| Fetch strategy | Model chooses | Operator-controlled via config |
| Domain blocking | Not enforced | `blockedDomains` from config |
| Result/text limits | Model-controlled | Operator-controlled via config |

This divergence is intentional and security-bearing. The operator — not the inner model — decides search type, fetch strategy, domain policy, and result caps. A future architecture review should **not** re-suggest unifying these interfaces. See [ADR-0001](../../docs/adr/0001-fusion-inner-tools-are-a-restricted-projection.md).

## Inner Tool Implementation (`tools.ts`)

`createFusionTools(config)` returns exactly two `FusionTool` objects:

### `web_search` (inner)

Wraps `executeWebSearch()` from `exa-search-core.ts`. Parameters:
- `query` (required string, minLength 1)
- `numResults` (optional integer, clamped to core limits)

Operator policy injected from config:
- `numResults` default (from `config.webSearch.numResults`)
- `textMaxCharacters` (from `config.webSearch.textMaxCharacters`)
- `excludedDomains` (from `config.webSearch.excludedDomains`)

### `webfetch` (inner)

Wraps `executeWebfetch()` from `webfetch-core.ts`. Parameters:
- `url` (required string, minLength 1)
- `maxChars` (optional integer, clamped to core limits)

Operator policy injected from config:
- `strategy` (from `config.webfetch.strategy`)
- `maxChars` default (from `config.webfetch.maxChars`)
- `blockedDomains` (from `config.webfetch.blockedDomains`) — checked via `isBlockedDomain()` which matches hostname or subdomain

### Tool Result Conversion

Inner tool results are converted to `ToolResultMessage` objects with `toolCallId`, `toolName`, text content, and `isError` flag. The inner model never sees raw HTTP responses — only text content.

## Model Runner Tool Budget (`model-runner.ts`)

The `completeWithTools()` loop enforces the tool budget:

1. Each iteration, if the model returns tool calls and `stopReason === "toolUse"`:
2. Check `callsUsed + calls.length > maxToolCalls`
3. If exceeded: inject `toolBudgetExceededResult` for each call (tells the model the budget was exhausted), set `toolBudgetExceeded = true`, continue loop with empty tools array
4. If within budget: execute all calls in parallel via `executeAllowedTool()`, append results

The `executeAllowedTool()` function only executes tools whose names match the allowed set. Unknown tool names produce an error result.

## Bundle CLI (`bundle-cli.ts`)

The Fusion panel and judge have **no filesystem access**. To ask them about real code, the `fusion` skill bundles curated on-disk files into a single self-contained prompt. The bundle CLI materializes this:

```bash
# Invoked by the fusion skill's bundle.sh script
tsx pi-extensions/fusion/bundle-cli.ts \
  --question "Does this refactor plan cohere?" \
  "src/data/**/*.ts" "!**/*.test.ts" "docs/adr/0003-schema.md"
```

### What It Does

1. `parseArgs()` — parses `--question`/`-q` (required), `--root`, `--out`, and file patterns
2. `collectFiles()` (from `bundle-core.ts`) — expands globs and literal paths, prunes ignored dirs, respects `.gitignore`
3. `formatBundle()` — renders files as markdown with line numbers and language-tagged code blocks
4. `buildPanelPrompt()` — concatenates question + "# Attached files" + bundle
5. Writes to a temp file (or `--out` path) and prints the path to stdout

### Security Properties

- Absolute paths and `..` traversal are rejected
- `node_modules`, `dist`, `.git`, `build`, `coverage`, `.turbo`, `.next` are pruned automatically
- Files ignored by `.gitignore` are dropped from glob matches — secrets/artifacts can't leak
- A git-ignored file named explicitly (as a literal path) is **rejected with an error**, not silently bundled
- Per-file size cap: 1 MB default (`DEFAULT_MAX_FILE_SIZE_BYTES`)

## Bundle Core (`lib/bundle-core.ts`)

The reusable file-bundling engine:

- `collectFiles(patterns, options)` — Returns `BundleFile[]` with `displayPath` and `content`
  - Partitions patterns into includes and `!excludes`
  - Expands globs via Node's `fs.glob`
  - Checks `.gitignore` via `git check-ignore` subprocess
  - Enforces per-file size cap
- `formatBundle(files, options)` — Renders files as markdown code blocks with optional line numbers
  - Maps file extensions to language tags (`.ts` → `ts`, `.py` → `python`, etc.)

## Fusion Skill (`skills/fusion/`)

The `fusion` skill ships as a portable Agent Skill:

- [`skills/fusion/SKILL.md`](../../skills/fusion/SKILL.md) — Skill description and workflow instructions
- [`skills/fusion/scripts/bundle.sh`](../../skills/fusion/scripts/bundle.sh) — Shell wrapper that invokes the bundle CLI

The skill's workflow:
1. The agent explores the repo with its normal tools and decides which files the panel needs
2. The agent runs `./scripts/bundle.sh --question "..." <patterns>` from the skill directory
3. The script prints a temp file path containing the finished panel prompt
4. The agent tells the user to run `/fusion --file <printed-path>`

The agent **cannot** invoke `/fusion` itself — Pi commands are user-only. The agent's job ends at producing the bundle path and telling the user the command to run.

## Argument Parsing (`args.ts`)

`parseFusionArgs()` supports two forms:

- `/fusion <prompt text>` — plain text prompt
- `/fusion --file <path> [optional prompt text]` — reads bundle file, optionally prepended with text

Both `--file <path>` and `--file=<path>` syntaxes are supported. When both `--file` and text are given, the text is prepended to the bundle content with a separator.

## Source Map

- [`pi-extensions/fusion/tools.ts`](../../pi-extensions/fusion/tools.ts) — `createFusionTools()`, inner `web_search` and `webfetch`
- [`pi-extensions/fusion/bundle-cli.ts`](../../pi-extensions/fusion/bundle-cli.ts) — Bundle CLI entry point
- [`pi-extensions/fusion/args.ts`](../../pi-extensions/fusion/args.ts) — `/fusion` argument parsing
- [`pi-extensions/fusion/model-runner.ts`](../../pi-extensions/fusion/model-runner.ts) — Tool budget enforcement
- [`pi-extensions/lib/bundle-core.ts`](../../pi-extensions/lib/bundle-core.ts) — File collection and formatting
- [`pi-extensions/lib/exa-search-core.ts`](../../pi-extensions/lib/exa-search-core.ts) — Exa search implementation
- [`pi-extensions/lib/webfetch-core.ts`](../../pi-extensions/lib/webfetch-core.ts) — Web fetch implementation
- [`skills/fusion/SKILL.md`](../../skills/fusion/SKILL.md) — Fusion bundle skill
- [`docs/adr/0001-fusion-inner-tools-are-a-restricted-projection.md`](../../docs/adr/0001-fusion-inner-tools-are-a-restricted-projection.md) — Restricted projection decision
