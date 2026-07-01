# Fusion inner tools are a restricted projection, not a shared interface

**Status:** accepted

Fusion's inner `web_search` and `webfetch` tools (`pi-extensions/fusion/tools.ts`) share their *implementation* with the standalone `exa_search` and `webfetch` extensions — both call the deep cores in `pi-extensions/lib/exa-search-core.ts` and `pi-extensions/lib/webfetch-core.ts`. They deliberately do **not** share their *interface*. The standalone tools expose a rich, model-controlled parameter surface; the Fusion tools expose a narrowed surface, rename `exa_search` → `web_search`, and inject operator policy (blocked domains, search type, text limits) from `fusion.json`. This divergence is intentional and security-bearing, not drift.

## Why

Fusion runs untrusted **inner** models — the panel models and judge — directly via the AI completion API, outside Pi's agent loop, with an explicit allowlist of exactly two tools: `web_search` and `webfetch`. The narrow schema, the rename, and the hand-written `createFusionTools` list are part of that restriction: the operator — not the inner model — decides search type, fetch strategy, domain policy, and result caps. The hand-written tool list *is* the allowlist; its explicitness is the control.

The calling model is intentionally different: ADR-0002 records that it synthesizes the final answer inside Pi's normal agent loop after the `fusion-panel` message is injected. ADR-0001's restricted-tool claim applies only to the inner panel and judge calls.

## Considered options

- **Collapse into one shared "web-tool definition" mounted by both hosts.** Rejected. The deletion test shows almost no complexity reappears: name, description, schema, result type, and arg-trust boundary all differ on purpose, so the "shared" definition would be a near-empty shell over the already-shared core. Worse, a derived/shared tool registry would erode the explicit two-tool allowlist that Fusion's safety posture depends on. The duplication is the point.

## Consequences

- A future architecture review should **not** re-suggest unifying these tool interfaces. The implementation seam (`lib/*-core.ts`) is already the correct shared, deep module; the interface split stays.
- Bound constants the cores own (e.g. `MIN_NUM_RESULTS`/`MAX_NUM_RESULTS`) should be imported into Fusion's schemas rather than re-typed as literals, so the two surfaces can diverge in shape without silently desyncing on shared limits.
