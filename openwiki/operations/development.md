# Development operations

## Environment

`package.json` requires:

- Node `>=22`
- pnpm `11.9.0`

Install dependencies from the repository root:

```bash
pnpm install
```

The project is ESM (`"type": "module"`) and TypeScript. Local TypeScript imports use `.js` specifiers.

## Common scripts

From `package.json`:

```bash
pnpm lint              # oxlint pi-extensions opencode-plugins
pnpm format            # oxfmt write
pnpm format:check      # oxfmt check
pnpm typecheck         # tsc --noEmit
pnpm test              # all Vitest tests
pnpm test:unit         # vitest.unit.config.mjs
```

Targeted scripts:

```bash
pnpm baseline:webfetch # WEBFETCH_BASELINE=1 vitest run tests/webfetch.baseline.test.ts
pnpm test:rtk
pnpm test:rtk:e2e     # RTK_E2E=1
pnpm test:remote:e2e  # REMOTE_E2E=1
pnpm test:fusion
pnpm test:fusion:e2e  # FUSION_E2E=1
pnpm verify:rtk
pnpm validate:rtk
```

Run the narrowest relevant tests while iterating, then broaden to `pnpm typecheck` and `pnpm test` for cross-domain changes.

## OpenWiki maintenance

`.github/workflows/openwiki-update.yml` runs `openwiki code --update --print` on demand or on its daily schedule, then opens/updates a pull request containing generated `openwiki/` content and the OpenWiki instruction-reference files. The workflow supplies the model/tracing configuration through repository secrets; do not put credentials in source or generated pages. For repository changes, start with `openwiki/quickstart.md` and let the scheduled workflow refresh generated pages rather than hand-editing them unless a documentation update is explicitly requested.

## Test map by domain

| Domain | Tests |
| --- | --- |
| Fusion | `tests/fusion.test.ts`, `tests/fusion-args.test.ts`, `tests/fusion-bundle-cli.test.ts`, `tests/fusion-index.test.ts`, `tests/fusion-tools.test.ts`, `tests/fusion.e2e.test.ts` |
| Webfetch | `tests/webfetch.test.ts`, `tests/webfetch.baseline.test.ts` |
| Exa search | `tests/exa-search.test.ts` |
| Autoname | `tests/autoname.test.ts` |
| Learn | `tests/learn.test.ts` |
| Misc Pi extensions | `tests/autoname.test.ts`, `tests/learn.test.ts`, `tests/bundle-core.test.ts` |
| Remote control | `tests/remote-authorization.test.ts`, `tests/remote-cli.test.ts`, `tests/remote-daemon*.test.ts`, `tests/remote-extension.test.ts`, `tests/remote-ipc.test.ts`, `tests/remote-iroh-transport.test.ts`, `tests/remote-protocol.test.ts`, `tests/remote-transcript-projection.test.ts`, `tests/remote.e2e.test.ts`, `tests/ios-remote-fixtures.test.ts` |
| Claude review | `tests/claude-review.test.ts`, `tests/claude-pi-review.test.ts` |
| Claude/Pi companion | `tests/claude-pi-background-cancel.test.ts`, `tests/claude-pi-continue.test.ts`, `tests/claude-pi-implement.test.ts`, `tests/claude-pi-jobs.test.ts`, `tests/claude-pi-setup.test.ts` |
| RTK | `tests/rtk.test.ts`, `tests/rtk.e2e.test.ts` |

## Configuration and local state

Do not read or document live secrets. Source-level config names are safe to mention:

- `EXA_API_KEY` for Exa search.
- `GITHUB_TOKEN` or `GH_TOKEN` for authenticated GitHub API calls inside webfetch GitHub orientation.
- `WEBFETCH_ALLOW_PRIVATE_HOSTS` to override private-host protection.
- `PI_FUSION_CONFIG` for Fusion config path.
- `PI_RTK_BIN`, `PI_RTK_DEBUG` for RTK.
- `PI_AUTONAME_MODEL`, `PI_AUTONAME_FALLBACK_MODEL`, `PI_AUTONAME_PROMPT_FILE` for autoname.
- `PI_CLAUDE_REVIEW_BIN` for Claude review.
- `PI_COMPANION_DATA_DIR` for Claude/Pi companion state.

Important local state paths from source:

- Fusion config default: `~/.pi/agent/fusion.json`.
- Remote root: `~/.pi/agent/remote`.
- Claude/Pi companion default state: `~/.local/state/claude-pi-companion`.
- Shared sounds: `~/Documents/sounds/<event>/`.

## Change playbooks

### Changing Fusion

1. Read [Fusion workflow](../fusion/workflow.md) and ADR-0002.
2. Inspect `pi-extensions/fusion/orchestrator.ts`, `index.ts`, `prompts.ts`, and the relevant tests.
3. Preserve the judge-analysis/calling-model-synthesis boundary.
4. Run `pnpm test:fusion`; add `pnpm test:fusion:e2e` only when e2e credentials/runtime are available and relevant.

### Changing webfetch/search

1. Read [Fusion inner tools](../fusion/inner-tools.md), ADR-0001, and ADR-0004.
2. For standalone schemas inspect `pi-extensions/webfetch.ts` or `exa-search.ts`; for behavior inspect `pi-extensions/lib/*-core.ts`.
3. Keep site-specific webfetch optimizations internal unless a new decision says otherwise; preserve GitHub/GitLab orientation and fragment-after-conversion behavior when changing HTML handling.
4. Run `pnpm test -- tests/webfetch.test.ts` or the relevant Exa/Fusion tests, then broader checks.

### Changing autoname or learn

1. Inspect `pi-extensions/autoname.ts` or `pi-extensions/learn.ts` and the matching Vitest file before changing prompt contracts.
2. For autoname, preserve bounded transcript construction, narrow resource evidence, secret/credential filtering, compaction selection, and JSON encoding of untrusted session history.
3. For learn, preserve the skill artifact contract: one focused `SKILL.md` under `skills/<skill-name>/`, with optional supporting directories rather than a new Pi extension.
4. Run `pnpm test -- tests/autoname.test.ts` or `pnpm test -- tests/learn.test.ts`.

### Changing remote control

1. Read [Remote control architecture](../remote-control/architecture.md), `REMOTE_CONTROL_PRD.md`, and ADR-0003.
2. Decide whether the change touches extension, daemon, IPC, iroh transport, protocol, authorization, or transcript projection.
3. Preserve JSONL frame compatibility and node-id allowlist authorization unless intentionally versioning/replacing the protocol.
4. Run the relevant `tests/remote-*.test.ts`; e2e requires `REMOTE_E2E=1` through the package script.

### Changing Claude/Pi companion

1. Inspect `plugins/pi/scripts/pi-companion.mjs` and the specific library module under `plugins/pi/scripts/lib/`.
2. Job state changes usually require tests for status/result/cancel/background behavior.
3. Recent commits focused on stale/dead worker handling and locked job updates; avoid reintroducing unlocked status races.
4. Run `tests/claude-pi-*.test.ts` relevant to the workflow.

## Git hygiene notes

The current initialization was done while old `openwiki/` files were deleted in the working tree. Treat the recreated wiki as generated documentation. Source code outside `openwiki/` should not be modified during OpenWiki runs except for top-level `AGENTS.md`/`CLAUDE.md` OpenWiki reference sections.
