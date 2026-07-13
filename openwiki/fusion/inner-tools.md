# Fusion inner tools

## Why this page matters

Fusion drives **inner models** — panel models and the judge — directly through the AI completion API, outside Pi's normal agent loop. Those inner models are intentionally given only two web tools: `web_search` and `webfetch`.

ADR-0001 states the key rule: Fusion inner tools are a **restricted projection**, not a shared interface with the standalone Pi tools.

## Implementation

`pi-extensions/fusion/tools.ts` exports `createFusionTools(config)`, which returns exactly:

1. `createWebSearchTool(config)` as `web_search`.
2. `createWebfetchTool(config)` as `webfetch`.

The implementation reuses shared cores:

- `executeWebSearch` from `pi-extensions/lib/exa-search-core.ts`.
- `executeWebfetch` from `pi-extensions/lib/webfetch-core.ts`.

The schemas are deliberately narrower than standalone Pi tools:

- Fusion `web_search` accepts `query` and optional `numResults`. Operator policy from config controls default result count, text max, and excluded domains.
- Fusion `webfetch` accepts `url` and optional `maxChars`. Operator policy controls blocked domains and fetch strategy.

The standalone `exa_search` and `webfetch` tools expose richer agent-controlled parameters in `pi-extensions/exa-search.ts` and `pi-extensions/webfetch.ts`.

## Security and policy boundary

The hand-written two-tool list in `createFusionTools` is the allowlist. Do not replace it with a dynamic registry or shared public tool definition unless the security model is intentionally redesigned.

Policy injected from `fusion.json` belongs to the operator, not the inner model:

- Search limits and excluded domains.
- Webfetch blocked domains.
- Webfetch strategy and size caps.
- Maximum tool calls.

## Webfetch behavior inherited by Fusion

`pi-extensions/lib/webfetch-core.ts` is a deep module shared by standalone and Fusion tools. It owns:

- URL normalization, including assuming `https://` when a scheme is omitted.
- SSRF/private-host protection, with `WEBFETCH_ALLOW_PRIVATE_HOSTS` as an explicit override.
- Redirect handling.
- Sensitive/header filtering and redaction.
- Text-like content filtering.
- HTML-to-markdown conversion through Readability/Turndown when appropriate.
- URL fragment extraction from converted pages.
- Truncation by Pi defaults and `maxChars`, with full output spilled to a temp file when truncated.
- GitHub-specific behavior for repository roots, blobs, issues, and pull requests.
- GitLab-specific behavior for repository roots, tree URLs, and blob URLs through the GitLab REST API, including metadata, a bounded tree, and README/raw-file retrieval.
- HTML-to-markdown conversion for successful and useful non-2xx HTML responses, with fragment extraction applied after conversion.

ADR-0004 records the current design direction: `webfetch` returns site-optimized, token-efficient representations rather than raw bytes. Bare GitHub repository roots now return an orientation view with default branch, depth-1 tree, metadata, and README, using GitHub auth opportunistically from `GITHUB_TOKEN`/`GH_TOKEN` when available. GitLab roots and tree URLs receive the analogous REST-backed orientation treatment; blob URLs use the raw-file endpoint.

## Exa search behavior inherited by Fusion

`pi-extensions/lib/exa-search-core.ts` owns Exa request formatting, search type handling, result limits, text snippets, truncation, and response formatting. The standalone tool requires `EXA_API_KEY`; Fusion uses the same core but may enforce different operator limits through config.

## Change guidance

- If changing fetch/search semantics, update shared core tests (`tests/webfetch.test.ts`, `tests/exa-search.test.ts`) and Fusion tool tests (`tests/fusion-tools.test.ts`).
- If changing Fusion schemas, revisit ADR-0001 because schema shape is part of the restriction.
- If adding site-specific webfetch optimizations, follow ADR-0004: keep detection internal and do not add an agent-visible mode flag by default.
- Be careful with docs or prompts that imply inner models can use normal Pi tools. They cannot; only these two restricted tools are available.
