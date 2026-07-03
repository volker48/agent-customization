# Development & Operations

## Prerequisites

- **Node.js ≥ 22** (enforced in `package.json` `engines`)
- **pnpm 11.9.0** (declared via `packageManager`)
- **TypeScript 5.9.3** (dev dependency)
- **oxlint 1.47.0** and **oxfmt 0.32.0** for linting/formatting
- **vitest 4.0.18** for testing

## Setup

```bash
pnpm install
```

The repo uses a pnpm workspace (`pnpm-workspace.yaml` includes `.`). The `.opencode/` directory has its own mini-workspace for OpenCode plugin development.

## Common Commands

```bash
pnpm typecheck     # tsc --noEmit
pnpm lint          # oxlint pi-extensions opencode-plugins
pnpm format        # oxfmt --write (format files in place)
pnpm format:check  # oxfmt --check (verify formatting without writing)
pnpm test          # vitest run (all unit tests)
```

### Targeted Test Suites

| Command | Tests | Notes |
|---|---|---|
| `pnpm test:fusion` | `tests/fusion.test.ts` | Fusion unit tests |
| `FUSION_E2E=1 pnpm test:fusion:e2e` | `tests/fusion.e2e.test.ts` | Real model calls (costs money) |
| `pnpm test:rtk` | `tests/rtk.test.ts` | RTK extension regression |
| `RTK_E2E=1 pnpm test:rtk:e2e` | `tests/rtk.e2e.test.ts` | Real RTK binary integration |
| `REMOTE_E2E=1 pnpm test:remote:e2e` | `tests/remote.e2e.test.ts` | Real daemon + iroh |
| `pnpm baseline:webfetch` | `tests/webfetch.baseline.test.ts` | `WEBFETCH_BASELINE=1` — records baseline snapshots |
| `pnpm verify:rtk` | `scripts/verify-rtk-extension.mjs` | Standalone Pi CLI verification |

E2E tests are opt-in via environment variables to avoid unexpected API costs or binary dependencies during normal CI.

## Test Coverage by Domain

| Test file | Domain | What it covers |
|---|---|---|
| `tests/fusion.test.ts` | Fusion | Orchestrator, config validation, prompts, tools, render, progress, args |
| `tests/fusion-index.test.ts` | Fusion | Command index/registration |
| `tests/fusion-args.test.ts` | Fusion | `/fusion` argument parsing |
| `tests/fusion-bundle-cli.test.ts` | Fusion | Bundle CLI argument parsing and output |
| `tests/fusion.e2e.test.ts` | Fusion | End-to-end with real models |
| `tests/bundle-core.test.ts` | Fusion | `lib/bundle-core.ts` file collection and formatting |
| `tests/rtk.test.ts` | RTK | Command rewriting, flag parsing, debug logging |
| `tests/rtk.e2e.test.ts` | RTK | Real `rtk` binary integration |
| `tests/remote-daemon.test.ts` | Remote | Daemon startup, connections, session registry |
| `tests/remote-extension.test.ts` | Remote | `/remote` extension, event forwarding, backfill |
| `tests/remote-protocol.test.ts` | Remote | Envelope encoding/decoding, routing |
| `tests/remote-ipc.test.ts` | Remote | IPC between extension and daemon |
| `tests/remote-iroh-transport.test.ts` | Remote | iroh endpoint binding and envelope I/O |
| `tests/remote-authorization.test.ts` | Remote | Pairing codes, allowlist, authorization logic |
| `tests/remote-transcript-projection.test.ts` | Remote | Transcript event projection |
| `tests/remote-cli.test.ts` | Remote | `pi-remote` CLI |
| `tests/remote-spawn.test.ts` | Remote | Daemon auto-spawn |
| `tests/remote-daemon-readiness.test.ts` | Remote | Daemon startup readiness |
| `tests/remote-daemon-entry.test.ts` | Remote | Daemon entry point |
| `tests/remote.e2e.test.ts` | Remote | End-to-end with real daemon |
| `tests/ios-remote-fixtures.test.ts` | Remote | iOS fixture generation |
| `tests/webfetch.test.ts` | WebFetch | URL handling, markdown conversion, GitHub links |
| `tests/webfetch.baseline.test.ts` | WebFetch | Baseline snapshots |
| `tests/exa-search.test.ts` | Exa | Search parameter handling |
| `tests/autoname.test.ts` | Autoname | Session naming, model fallback, transcript truncation |
| `tests/claude-review.test.ts` | Claude Review | Argument parsing, prompt building, result handling |

## CI Pipeline (`.gitlab-ci.yml`)

GitLab CI runs on `node:22-bookworm-slim` with four parallel jobs in the `verify` stage:

| Job | Command | Purpose |
|---|---|---|
| `lint` | `pnpm run lint` | oxlint on `pi-extensions` and `opencode-plugins` |
| `format` | `pnpm run format:check` | Verify formatting without writing |
| `typecheck` | `pnpm run typecheck` | `tsc --noEmit` |
| `test` | `pnpm run test` | vitest unit tests |

All jobs use `pnpm install --frozen-lockfile --ignore-scripts`, cache the pnpm store by `pnpm-lock.yaml`, and are interruptible. Runs on both merge request events and branch pushes.

## TypeScript Configuration (`tsconfig.json`)

- ESM modules (`"type": "module"` in `package.json`)
- `tsc --noEmit` for type checking only (no build output)
- Path alias: `*.js` imports resolve to `*.ts` source (standard ESM TypeScript pattern)

## Coding Standards (`MY_AGENTS.md`)

Key rules for agents and humans working in this repo:

- **≤ 50 lines per function**, cyclomatic complexity ≤ 8
- **≤ 5 positional params**, ≤ 12 branches, ≤ 6 returns
- **100-character line length**
- No `..` relative imports
- Build only what was requested — no speculative features, one-off abstractions, or unnecessary configurability
- Touch only what is needed — match existing style, don't refactor unrelated code
- Parse, don't validate — convert untrusted input to precise types once at the boundary
- Make bad states unrepresentable via types and schemas, not scattered runtime checks
- Before committing: run formatter, type checker, focused tests, inspect the diff
- For bug fixes: add a test that fails before the fix and passes after

## Utility Scripts

| Script | Purpose |
|---|---|
| `scripts/verify-rtk-extension.mjs` | Standalone Pi CLI verification using `--session` and `--extension` flags |
| `scripts/generate-ios-remote-fixtures.ts` | Generates protocol fixtures for iOS client tests |

## Agent Workflow Documentation (`docs/agents/`)

- [`docs/agents/domain.md`](../../docs/agents/domain.md) — How to consume `CONTEXT.md` and `docs/adr/` when exploring the codebase
- [`docs/agents/issue-tracker.md`](../../docs/agents/issue-tracker.md) — Issues tracked as GitHub issues via `gh` CLI
- [`docs/agents/triage-labels.md`](../../docs/agents/triage-labels.md) — Default label vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`

## Source Map

- [`package.json`](../../package.json) — Scripts, dependencies, Pi config
- [`.gitlab-ci.yml`](../../.gitlab-ci.yml) — CI pipeline
- [`tsconfig.json`](../../tsconfig.json) — TypeScript configuration
- [`pnpm-workspace.yaml`](../../pnpm-workspace.yaml) — Workspace config
- [`MY_AGENTS.md`](../../MY_AGENTS.md) — Coding standards
- [`tests/`](../../tests/) — Test suite
- [`scripts/`](../../scripts/) — Utility scripts
- [`docs/agents/`](../../docs/agents/) — Agent workflow docs
