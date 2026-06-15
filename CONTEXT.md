# Agent Customization

Personal customizations — extensions, plugins, hooks, themes — for three AI coding-agent harnesses. The bulk of the domain weight lives in Fusion, a Pi extension that runs a multi-model panel-and-judge workflow.

## Harnesses & customization units

**Harness**:
An AI coding-agent runtime that this repo customizes. The three supported harnesses are Claude Code, OpenCode, and Pi.
_Avoid_: agent (ambiguous — see Pi), runtime, host

**Pi**:
The Pi coding agent (`@earendil-works/pi-coding-agent`), the harness most of this repo targets. Customized via extensions.
_Avoid_: pi-mono, the agent

**Extension** (Pi):
A Pi customization unit that registers tools, commands, and message renderers through Pi's `ExtensionAPI`.
_Avoid_: plugin, hook (those are the other harnesses' terms)

**Plugin** (OpenCode):
An OpenCode customization unit — a function that receives the OpenCode client and returns a hooks object mapping events to handlers.
_Avoid_: extension, hook

**Hook** (Claude Code):
A Claude Code customization unit — an event→shell-command mapping declared in `settings.json` that fires on harness events (`SessionStart`, `PreToolUse`, etc.).
_Avoid_: extension, plugin

## RTK

**RTK** (Rust Token Killer):
An external token-optimizing CLI proxy binary that produces terser equivalents of shell commands to cut token cost. Invoked as `rtk rewrite <cmd>`.
_Avoid_: rust type kit (a different, unrelated `rtk`)

**Intercept**:
The canonical verb for what an RTK integration does — it catches a `bash` command before execution and swaps in RTK's terser version. Reserve "rewrite" for the literal `rtk rewrite` subcommand, not for the integration's behavior.
_Avoid_: rewrite (as a verb for the integration), hook, proxy

**RTK integration**:
The per-harness glue that intercepts bash commands and routes them through RTK — a Pi extension (`pi-extensions/rtk.ts`) and a parallel Claude Code hook.

## Fusion

**Fusion**:
The panel-and-judge synthesis workflow: send one prompt to several models in parallel, then have a separate model synthesize their answers. Modeled on OpenRouter Fusion. The canonical sense is the workflow; the Pi implementation is "the Fusion extension," and one `/fusion` invocation is "a fusion run."
_Avoid_: ensemble, mixture-of-experts

**Panel**:
The set of models that independently answer the prompt in parallel during a fusion run.
_Avoid_: ensemble, committee

**Panel model**:
One member of the panel.

**Panel response**:
One panel model's typed outcome. A successful one carries its content; a "failed panel response" carries a typed error. A fusion run proceeds to the judge as long as at least one panel response succeeds.

**Judge**:
The single model that compares the panel responses and authors the final answer. It synthesizes — it does not vote on or average them.
_Avoid_: synthesizer (as a separate role), writer, aggregator

**Synthesize**:
The canonical verb for what the judge does: compare panel responses and produce one final answer that preserves unique insights and surfaces contradictions.
_Avoid_: vote, average, merge, aggregate, fuse

**Inner model**:
A panel model or the judge — any model a fusion run drives directly through the AI completion API, outside Pi's agent loop, with no access to coding tools.
_Avoid_: sub-model, child agent, nested session

**Inner tools**:
The exactly-two web tools an inner model is given: `web_search` and `webfetch`. The hand-written two-tool list is the allowlist — its explicitness is the security control.
_Avoid_: tools (unqualified, when the restriction is the point)

**Restricted projection**:
ADR-0001's characterization of why the inner tools deliberately narrow the standalone tools' interface (renamed, reduced parameters, operator-injected policy) while sharing their implementation. A property of the inner tools, not a separate component.

**Model ref**:
A `provider/model-id` string identifying an inner model or the judge, parsed on the *first* slash only so OpenRouter-style ids whose model portion contains more slashes survive (e.g. `openrouter/deepseek/deepseek-v4-pro`).
_Avoid_: model name, model string

**Model registry**:
Pi's registry that resolves a model ref to a runnable model plus its credentials (API keys, headers, auto-refreshed OAuth/subscription tokens). Fusion resolves models only through it, never through provider-specific code.

**Fusion result**:
The output of a fusion run — the judge's final answer plus structured metadata (panel models, analysis, raw responses, elapsed time). Persisted as a custom `fusion-result` message that renders like a normal assistant answer collapsed, exposes metadata when expanded, and labels itself as Fusion-generated for future model context.
_Avoid_: fusion output, answer (unqualified)

**Degraded**:
The fusion run status when the judge synthesized an answer but at least one panel model failed. Distinct from `ok` (all panels succeeded) and `error` (all panels failed, no judge run).
_Avoid_: partial, warning

**DRACO**:
The evaluation stance baked into the judge prompt: strict factual accuracy, no rewarding verbosity, distinguish supported from unsupported claims, prefer primary sources. A borrowed posture, not a scorer — Fusion implements no DRACO rubric.

## Web tools

**Core**:
The reusable deep implementation of a web tool, in `pi-extensions/lib/*-core.ts`. Shared verbatim by both the standalone tool and Fusion's inner tool; only the interface around it differs.
_Avoid_: helper, util, shared module

**web_search** (inner) / **exa_search** (standalone):
The Exa-backed search tool. Exposed to inner models as `web_search` but registered as `exa_search` for standalone Pi use. Same core, two names — the inner rename is intentional, not drift.

**webfetch**:
The direct (no-JS) HTTP page-fetch tool. Same name standalone and inner, both over `webfetch-core.ts`.
_Avoid_: web fetch (two words), crawler, scraper

**Exa**:
The third-party search API (`exa.ai`) backing search. Requires `EXA_API_KEY`.

## Sounds, naming & themes

**Sound event**:
A harness event that triggers audio feedback by playing a random file from `~/Documents/sounds/<event>/`. Pi's snake_case names (`agent_end`, `tool_call`, …) are the canonical source; OpenCode dot.notation and Claude Code PascalCase names are symlinks onto the Pi folders.
_Avoid_: notification (reserved for the harness's own notify events)

**Autoname**:
The Pi extension that titles a session by feeding its transcript to a small LLM (default Haiku), so sessions are retrievable later.
_Avoid_: rename, session title (as a verb)

**Theme**:
A Pi TUI color scheme (`obsec-dark`, `obsec-light`) in `pi-themes/`.
