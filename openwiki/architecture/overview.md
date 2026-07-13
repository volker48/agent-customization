# Architecture overview

## Runtime shape

This repository is a customization bundle for multiple AI coding-agent harnesses:

- **Pi** (`@earendil-works/pi-coding-agent`) is the primary target. Pi customizations are **extensions**: TypeScript modules that receive an `ExtensionAPI` and register tools, commands, renderers, flags, or event handlers.
- **Claude Code** customizations are **hooks** and slash-command plugin files.
- **OpenCode** customizations are **plugins** that return hook handlers.

`CONTEXT.md` is the vocabulary authority. It explicitly distinguishes harness, Pi extension, OpenCode plugin, and Claude Code hook. Follow that terminology in code and docs.

## Top-level layout

| Path | Purpose |
| --- | --- |
| `pi-extensions/` | Pi extensions and shared TypeScript cores. Main domains: Fusion, remote control, web tools, Claude review, RTK, autoname, learn, sound notifications. |
| `pi-extensions/lib/` | Shared deep modules such as Exa search and webfetch cores. Extension files own registration and schemas; cores own reusable behavior. |
| `pi-subagents/` | Repo-owned overrides for builtin Pi subagent role prompts, installed as user-scope symlinks. |
| `opencode-plugins/` | OpenCode plugin implementations, currently including sound notifications. |
| `claude-hooks/` | Claude Code hook config and scripts, especially sound playback. |
| `plugins/pi/` | Claude Code plugin commands and Node companion scripts that delegate implementation/review workflows to Pi. |
| `skills/` | Agent skills shipped with the Pi package, including `fusion` and `claude-review`. |
| `prompts/` | Reusable prompt files included in the Pi package. |
| `docs/adr/` | Accepted architecture decisions. These are primary source material for future changes. |
| `tests/` | Vitest tests for extensions, cores, remote control, Fusion, Claude/Pi companion, and fixtures. |

## Package and module conventions

`package.json` marks the workspace as ESM (`"type": "module"`) and private. TypeScript source imports local modules using `.js` specifiers, matching the existing style in `pi-extensions/fusion/*.ts` and `pi-extensions/remote/*.ts`.

The Pi package block points Pi at:

- `./pi-extensions`
- `./skills`
- `./prompts`

The remote CLI is exposed as `pi-remote` via `pi-extensions/remote/cli.ts`.

## Shared-core pattern

Several tools split registration from behavior:

- `pi-extensions/exa-search.ts` registers standalone `exa_search`; `pi-extensions/lib/exa-search-core.ts` performs the API request, formatting, limits, and truncation.
- `pi-extensions/webfetch.ts` registers standalone `webfetch`; `pi-extensions/lib/webfetch-core.ts` owns URL normalization, private-host protections, redirects, HTML-to-markdown conversion, GitHub and GitLab handling, truncation, and temp-file spill behavior.
- `pi-extensions/fusion/tools.ts` reuses those cores while presenting a narrower inner-model schema.

This split is intentional: public/standalone tool schemas can differ from restricted inner schemas while sharing audited low-level behavior.

## Extension idioms

Representative Pi extension patterns:

- Register slash commands with `pi.registerCommand`, validate args, and report invalid usage through `ctx.ui.notify` (`pi-extensions/fusion/index.ts`, `pi-extensions/remote/index.ts`, `pi-extensions/claude-review/index.ts`).
- Use `AbortController` and cancellable `BorderedLoader` widgets for long-running commands (`fusion`, `claude-review`).
- Use `pi.sendMessage` for structured extension messages that should be rendered specially and may optionally trigger a turn.
- Use `pi.sendUserMessage` when a command should enqueue normal Pi work (`learn`, Claude review auto-fix, remote prompt injection through `deliverAs: "steer"`).
- Register renderers for custom message types when a transcript card should be compact but expandable (`fusion-panel`, `claude-review`).

## Tests and evidence paths

Most behavior is covered by targeted Vitest files:

- Fusion: `tests/fusion*.test.ts`, `tests/fusion.e2e.test.ts`.
- Webfetch: `tests/webfetch.test.ts`, `tests/webfetch.baseline.test.ts`.
- Remote control: `tests/remote-*.test.ts`, `tests/remote.e2e.test.ts`, `tests/ios-remote-fixtures.test.ts`.
- Claude review and companion workflows: `tests/claude-review.test.ts`, `tests/claude-pi-*.test.ts`.
- RTK: `tests/rtk.test.ts`, `tests/rtk.e2e.test.ts`.

When changing a domain, start with the page for that domain, then inspect the source and matching tests before editing.
