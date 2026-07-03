# Agent Customization — Quick Start

Extensions, hooks, plugins, skills, and themes for AI coding agents — currently supporting [Claude Code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview), [OpenCode](https://opencode.ai), and the [Pi agent](https://github.com/badlogic/pi-mono). The bulk of the domain weight lives in **Fusion**, a Pi extension that runs a multi-model panel-and-judge workflow, and **Remote Control**, a Pi extension that lets a phone view and steer a running session.

## What This Repo Contains

| Directory | What it is | Harness |
|---|---|---|
| `pi-extensions/` | Pi agent extensions (TypeScript) — Fusion, Remote, Exa Search, WebFetch, RTK, Autoname, Claude Review, Sound | Pi |
| `claude-hooks/` | Claude Code hooks (Python) — sound notifications | Claude Code |
| `opencode-plugins/` | OpenCode plugins (TypeScript) — sound notifications | OpenCode |
| `skills/` | Agent Skills shared across harnesses — Fusion bundle, Claude Review | Pi + compatible |
| `pi-themes/` | Pi TUI color themes (obsec-dark, obsec-light) | Pi |
| `ios-remote-client/` | iOS Swift app for remote session control | Remote Control |
| `prompts/` | Reusable prompt templates | Pi |
| `tests/` | Vitest test suite | All |
| `docs/` | ADRs, agent workflow docs, plans | All |

## Key Concepts

- **Harness**: An AI coding-agent runtime this repo customizes (Claude Code, OpenCode, or Pi).
- **Extension** (Pi): Registers tools, commands, and message renderers through Pi's `ExtensionAPI`.
- **Plugin** (OpenCode): A function receiving the OpenCode client, returning event→handler mappings.
- **Hook** (Claude Code): An event→shell-command mapping in `settings.json`.
- **Fusion**: Panel→judge→synthesis workflow — send one prompt to several models in parallel, have a judge analyze responses, then the calling model writes the final answer.
- **Remote Control**: View and steer a running Pi session from a phone via P2P (iroh) — the phone never executes tools.

The full glossary lives in [`CONTEXT.md`](../CONTEXT.md).

## Getting Started

### Prerequisites

- **Node.js ≥ 22**
- **pnpm 11.9.0** (declared in `package.json` via `packageManager`)
- For Pi extensions: `@earendil-works/pi-coding-agent`, `pi-ai`, and `pi-tui` (dev dependencies)
- For Exa search: `EXA_API_KEY` environment variable
- For RTK: the `rtk` binary on `PATH` (or `PI_RTK_BIN`)
- For Claude Review: the `claude` CLI on `PATH` (or `PI_CLAUDE_REVIEW_BIN`)

### Install & Develop

```bash
pnpm install
pnpm typecheck     # TypeScript type checking (tsc --noEmit)
pnpm lint          # Linting with oxlint
pnpm format        # Format with oxfmt
pnpm test          # Run tests with vitest
```

### Run Specific Test Suites

```bash
pnpm test:fusion          # Fusion unit tests
FUSION_E2E=1 pnpm test:fusion:e2e   # Fusion end-to-end (real model calls)
pnpm test:rtk             # RTK extension tests
RTK_E2E=1 pnpm test:rtk:e2e         # RTK integration tests
REMOTE_E2E=1 pnpm test:remote:e2e   # Remote control integration tests
pnpm baseline:webfetch    # WebFetch baseline tests (WEBFETCH_BASELINE=1)
```

### Install Extensions for Pi

Pi reads extensions from the `pi.extensions` array in `package.json`:

```json
{
  "pi": {
    "extensions": ["./pi-extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"]
  }
}
```

Copy or symlink individual extension files into `~/.pi/agent/extensions/` for standalone use.

## Section Guide

- [Architecture Overview](architecture/overview.md) — Repository structure, harness model, shared libraries
- [Fusion Workflow](fusion/workflow.md) — Panel→judge→synthesis pipeline, config, orchestrator, prompts
- [Fusion Inner Tools & Bundling](fusion/inner-tools.md) — Restricted tool projection, bundle CLI, fusion skill
- [Remote Control Architecture](remote-control/architecture.md) — Daemon, iroh P2P transport, pairing, protocol, iOS client
- [Extensions Overview](extensions/overview.md) — Sound notifications, Exa search, WebFetch, RTK, Autoname, Claude Review, themes
- [Development & Operations](operations/development.md) — Dev setup, testing, CI pipeline, coding standards
- [Architecture Decisions](operations/decisions.md) — ADRs and agent workflow documentation

## Source Map

- [`README.md`](../README.md) — Primary project documentation, setup instructions, extension descriptions
- [`CONTEXT.md`](../CONTEXT.md) — Domain glossary with canonical vocabulary for all major concepts
- [`package.json`](../package.json) — Scripts, dependencies, Pi configuration
- [`AGENTS.md`](../AGENTS.md) — Agent skill pointers (issue tracker, triage, domain docs, fusion bundle)
- [`MY_AGENTS.md`](../MY_AGENTS.md) — Coding standards and engineering behavior rules
