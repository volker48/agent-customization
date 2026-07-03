# Architecture Overview

## Repository Layout

```
agent-customization/
├── pi-extensions/           # Pi agent extensions (TypeScript)
│   ├── fusion/              # Multi-model panel-judge-synthesis workflow
│   ├── remote/              # Remote control daemon + extension
│   ├── claude-review/       # Delegates review to Claude Code CLI
│   ├── lib/                 # Shared deep implementations (cores)
│   │   ├── webfetch-core.ts #   Web fetch logic (standalone + fusion)
│   │   ├── exa-search-core.ts #  Exa search logic (standalone + fusion)
│   │   └── bundle-core.ts   #   File bundling for panel prompts
│   ├── sound-notifications.ts
│   ├── exa-search.ts        # Standalone Exa search tool
│   ├── webfetch.ts          # Standalone web fetch tool
│   ├── rtk.ts               # RTK bash command rewrite interceptor
│   └── autoname.ts          # Auto-titles sessions via small LLM
├── claude-hooks/            # Claude Code hooks (Python)
│   ├── hooks.json           # Event → command mappings
│   └── play-sound.py        # Sound player script
├── opencode-plugins/        # OpenCode plugins (TypeScript)
│   └── sound-notifications.ts
├── skills/                  # Agent Skills (shared, harness-agnostic)
│   ├── fusion/              # Bundle curated files for the Fusion panel
│   └── claude-review/       # Run Claude Code /code-review
├── pi-themes/               # Pi TUI color themes
├── ios-remote-client/       # iOS Swift app for remote control
├── prompts/                 # Reusable prompt templates
├── tests/                   # Vitest test suite
├── docs/                    # ADRs, agent workflow docs, plans
├── scripts/                 # Utility scripts
├── CONTEXT.md               # Domain glossary (canonical vocabulary)
├── AGENTS.md                # Agent skill pointers
└── MY_AGENTS.md             # Coding standards
```

## Harness Model

The repo customizes three harnesses, each with its own customization unit:

| Harness | Customization unit | Mechanism | Location |
|---|---|---|---|
| **Pi** | Extension | TypeScript default-export function receiving `ExtensionAPI` | `pi-extensions/` |
| **OpenCode** | Plugin | Function receiving OpenCode client, returns hooks object | `opencode-plugins/` |
| **Claude Code** | Hook | Event→shell-command mapping in `settings.json` | `claude-hooks/` |

Pi is the primary target — most extensions and all of the complex workflows (Fusion, Remote Control) target it. The `package.json` `pi` key declares extension, skill, and prompt directories:

```json
{
  "pi": {
    "extensions": ["./pi-extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"]
  }
}
```

## Shared Libraries (`pi-extensions/lib/`)

The `lib/` directory contains deep implementations shared between standalone tools and Fusion's inner tools:

- **`webfetch-core.ts`** (~60 KB) — The full HTTP fetch implementation: probing, smart fallback, GitHub blob/repo handling, HTML-to-markdown conversion (via `@mozilla/readability`, `linkedom`, `turndown`). Used by both the standalone `webfetch` extension and Fusion's inner `webfetch` tool.
- **`exa-search-core.ts`** — Exa API search implementation with result/text limits and search types. Used by both the standalone `exa_search` extension and Fusion's inner `web_search` tool.
- **`bundle-core.ts`** — File collection and markdown bundling for panel prompts. Collects files by glob/literal patterns, prunes ignored directories, respects `.gitignore`, enforces per-file size caps.

Per [ADR-0001](../../docs/adr/0001-fusion-inner-tools-are-a-restricted-projection.md), the **implementation** is shared but the **interface** is deliberately split: standalone tools expose a rich model-controlled parameter surface, while Fusion's inner tools expose a narrowed surface with operator-injected policy. This divergence is a security control, not drift.

## Pi Extension Pattern

Every Pi extension is a TypeScript file with a default-export function:

```typescript
export default function myExtension(pi: ExtensionAPI) {
  pi.registerTool({ name, description, parameters, execute });
  pi.registerCommand("my-command", { description, handler });
  pi.registerMessageRenderer<MyDetails>(messageType, renderer);
  pi.on("event_name", async (event, ctx) => { /* ... */ });
}
```

Key `ExtensionAPI` surfaces used across extensions:
- `registerTool` — Add a tool the agent can call
- `registerCommand` — Add a `/command` the user can invoke
- `registerMessageRenderer` — Custom TUI rendering for a message type
- `registerFlag` — Declare a CLI flag
- `on(event, handler)` — Subscribe to harness events
- `sendMessage(msg, { triggerTurn })` — Inject a message into the session
- `sendUserMessage(text, { deliverAs })` — Inject a user-role message
- `exec(bin, args, opts)` — Spawn a subprocess
- `ctx.modelRegistry` — Resolve model refs to runnable models + credentials

## Configuration

- **Fusion config**: `~/.pi/agent/fusion.json` (or `PI_FUSION_CONFIG` env var) — defines panel models, judge, tool budgets, web policies
- **Remote control**: `~/.pi/agent/remote/` — iroh secret key, allowed node IDs, daemon socket
- **Sound notifications**: `~/Documents/sounds/<event>/` — audio files per event, shared across harnesses via symlinks
- **Autoname**: `PI_AUTONAME_MODEL`, `PI_AUTONAME_FALLBACK_MODEL` env vars

## Source Map

- [`README.md`](../../README.md) — Repository structure, setup, extension descriptions
- [`CONTEXT.md`](../../CONTEXT.md) — Domain glossary defining harness, extension, plugin, hook
- [`package.json`](../../package.json) — Pi extension/skill/prompt config, scripts, dependencies
- [`pi-extensions/lib/`](../../pi-extensions/lib/) — Shared core implementations
- [`docs/adr/0001-fusion-inner-tools-are-a-restricted-projection.md`](../../docs/adr/0001-fusion-inner-tools-are-a-restricted-projection.md) — Inner tools design decision
