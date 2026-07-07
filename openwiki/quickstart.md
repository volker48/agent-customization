# OpenWiki quickstart

## What this repository is

`agent-customization` is a private TypeScript/Node workspace for customizing AI coding-agent harnesses, primarily the Pi coding agent, with smaller Claude Code and OpenCode customizations. The root README describes the supported harnesses and shared sound-notification convention; `CONTEXT.md` defines the project vocabulary and is the canonical domain glossary.

The repository is not a product server. It is a collection of installable/customizable artifacts:

- **Pi extensions** in `pi-extensions/` that register tools, slash commands, renderers, and event handlers through Pi's `ExtensionAPI`.
- **Claude Code hooks and plugin commands** in `claude-hooks/` and `plugins/pi/`.
- **OpenCode plugins** in `opencode-plugins/`.
- **Shared skills and prompts** in `skills/` and `prompts/`.
- **Tests** in `tests/`, using Vitest.

Recent git history is concentrated on two high-signal areas: webfetch token efficiency/GitHub repository orientation (`pi-extensions/lib/webfetch-core.ts`, `tests/webfetch.test.ts`, ADR-0004) and hardening of the Claude/Pi companion background job lifecycle (`plugins/pi/scripts/lib/*`, `tests/claude-pi-*.test.ts`).

## Where to go next

- [Architecture overview](architecture/overview.md) — repository layout, harness terminology, shared-core patterns, and source map.
- [Fusion workflow](fusion/workflow.md) — `/fusion` panel/judge/calling-model execution.
- [Fusion inner tools](fusion/inner-tools.md) — why Fusion exposes only restricted `web_search` and `webfetch` to inner models.
- [Remote control architecture](remote-control/architecture.md) — `/remote`, daemon, iroh transport, pairing, IPC, and transcript projection.
- [Extensions overview](extensions/overview.md) — non-Fusion Pi extensions, Claude review, RTK, autoname, learn, sound hooks/plugins, skills, and prompts.
- [Development operations](operations/development.md) — setup, scripts, tests, and change guidance.
- [Architecture decisions](operations/decisions.md) — ADR map and decisions future agents should preserve.

## First commands

This workspace expects Node 22+ and pnpm 11.9.0 (`package.json`).

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm lint
```

Useful targeted scripts from `package.json`:

```bash
pnpm test:unit
pnpm test:fusion
pnpm test:fusion:e2e      # requires FUSION_E2E=1 via script
pnpm test:remote:e2e      # requires REMOTE_E2E=1 via script
pnpm test:rtk
pnpm verify:rtk
pnpm baseline:webfetch
```

## Main domains at a glance

### Pi extension package

`package.json` declares the Pi package metadata:

```json
"pi": {
  "extensions": ["./pi-extensions"],
  "skills": ["./skills"],
  "prompts": ["./prompts"]
}
```

The `bin` entry exposes `pi-remote` at `pi-extensions/remote/cli.ts`.

### Fusion

Fusion is the heaviest domain. `/fusion` reads `~/.pi/agent/fusion.json` by default (or `PI_FUSION_CONFIG`), runs a panel of configured models, has a judge analyze the panel, then injects a compact `fusion-panel` message that triggers the current Pi model to write the final answer. See [Fusion workflow](fusion/workflow.md).

### Web access tools

Standalone Pi tools `exa_search` and `webfetch` are registered in `pi-extensions/exa-search.ts` and `pi-extensions/webfetch.ts`. Their deep implementations live in `pi-extensions/lib/exa-search-core.ts` and `pi-extensions/lib/webfetch-core.ts`. Fusion reuses those cores but intentionally exposes a narrower inner-model interface; see [Fusion inner tools](fusion/inner-tools.md).

### Remote control

`/remote` registers a running Pi session with a local daemon. The daemon owns a stable iroh endpoint, authorizes remote clients through coded pairing plus node-id allowlisting, and relays transcript events/prompts between remote clients and Pi sessions. See [Remote control architecture](remote-control/architecture.md).

### Claude/Pi companion workflows

`plugins/pi/scripts/pi-companion.mjs` implements a Claude Code plugin bridge for delegating implementation/review/continuation/status/cancel/result workflows to Pi over RPC. Job records and logs are stored per workspace under `~/.local/state/claude-pi-companion` by default. See [Extensions overview](extensions/overview.md) and [Development operations](operations/development.md).

## Agent change guidance

Before changing code, read `CONTEXT.md` for vocabulary and the relevant page above. Preserve these repository-specific boundaries:

- Do not call a Pi **extension** a plugin or hook; `CONTEXT.md` reserves those words for OpenCode and Claude Code.
- Keep Fusion inner tools restricted. The standalone web tools may expose richer parameters, but inner panel/judge models should keep the deliberately narrow two-tool allowlist.
- In remote control, remember the laptop remains the execution host. Remote clients view and steer; they do not run tools.
- Prefer adding tests under `tests/` for any new parser, prompt builder, command behavior, transport rule, or extension helper.
- For webfetch changes, inspect ADR-0004 and the webfetch tests. Recent history shows token-efficiency behavior is deliberate, not incidental.
