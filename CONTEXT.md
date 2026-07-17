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

## Claude review

**Claude review**:
A Pi-initiated review workflow that delegates current-diff review to Claude Code, returns
Claude Code's findings to the Pi session, and normally asks the Pi implementer to fix
actionable issues. The review agent is Claude Code; the implementer remains the current Pi
session.
_Avoid_: code review (ambiguous), reviewer agent (when the harness boundary matters)

**Review level**:
The Claude Code review effort selected for a Claude review run. Supported scripted levels are
`low`, `medium`, `high`, and `max`; `medium` is the default.
_Avoid_: effort (unless quoting Claude Code), depth

**Review context message**:
Optional free-form text appended after the review level in Claude Code's `/code-review`
invocation. It tells Claude Code what task or issue the diff is meant to implement, but a
Claude review run may omit it and let Claude Code review the branch or unstaged changes
without extra task context.
_Avoid_: implementer message (confuses who consumes it)

**Auto-fix**:
The default Claude review outcome where Pi receives Claude Code's review and immediately acts
on actionable findings. The opposite is review-only mode, where Pi surfaces the findings
without starting implementation.
_Avoid_: --fix (that means Claude Code mutates the tree itself)

**Review subprocess**:
The `claude` CLI process Pi starts for a Claude review run. It is read-only by policy: it may
inspect the repository and produce findings, but it must not modify files, create tasks, spawn
agents, or trigger remote/cloud work.
_Avoid_: nested agent (too broad), Claude fixer

**Review tool allowlist**:
The Claude Code tools permitted in the review subprocess: `Bash`, `Read`, `Glob`, `Grep`,
`LSP`, `WebFetch`, `WebSearch`, and `Skill`. The allowlist deliberately excludes mutating
tools such as `Edit`, `Write`, `NotebookEdit`, and `TodoWrite`, and orchestration/remote
tools such as `Agent`, `Task*`, `Cron*`, `RemoteTrigger`, and `Workflow`.
_Avoid_: read-only tools (because `Bash` and web tools are broad; the policy is the explicit
allowlist)

**Review-only mode**:
The Claude review outcome selected by `--no-fix`: Pi records Claude Code's findings in the
transcript but does not trigger the implementer to act on them.
_Avoid_: dry run (the review still runs), no-op

## Fusion

**Fusion**:
The panel–judge–synthesis workflow: send one prompt to several models in parallel, have a judge produce a structured analysis of their responses, then have the calling model write the final answer grounded in that analysis. Modeled on OpenRouter Fusion. The canonical sense is the workflow; the Pi implementation is "the Fusion extension," and one `/fusion` invocation is "a fusion run."
_Avoid_: ensemble, mixture-of-experts

**Panel**:
The set of models that independently answer the prompt in parallel during a fusion run.
_Avoid_: ensemble, committee

**Panel model**:
One member of the panel.

**Panel response**:
One panel model's typed outcome. A successful one carries its content; a "failed panel response" carries a typed error. A fusion run proceeds to the judge as long as at least one panel response succeeds.

**Judge**:
The single model that compares the panel responses and produces a structured analysis (consensus, contradictions, partial coverage, unique insights, blind spots, source quality, risks) plus a confidence rating. It does **not** author the final answer — the calling model does. It analyzes; it does not vote on or average the panel.
_Avoid_: synthesizer (the judge no longer synthesizes), writer, aggregator

**Calling model**:
The active Pi model at the time of a `/fusion` invocation — whatever model `/model` currently selects, which may differ from the judge. It writes the final answer grounded in the judge's analysis and the panel responses, running inside Pi's agent loop with full session context and tools. It is *not* an inner model.
_Avoid_: active model (when the Fusion role is the point), host model

**Synthesize**:
The canonical verb for what the calling model does: read the judge's analysis and the panel responses and write one final answer that preserves unique insights and resolves contradictions. The judge *analyzes*; the calling model *synthesizes*.
_Avoid_: vote, average, merge, aggregate, fuse

**Inner model**:
A panel model or the judge — any model a fusion run drives directly through the AI completion API, outside Pi's agent loop, with no access to coding tools. The calling model is not an inner model: it runs inside Pi's loop with full tools.
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

**Fusion panel message**:
The custom `fusion-panel` message a fusion run injects once the judge finishes. Its `content` is the synthesis prompt (task + judge analysis + panel responses) that the calling model reads; in the LLM context it is a user-role message. The TUI renders it as a compact card (panel size, judge, confidence) that exposes panel and analysis metadata when expanded. Injected with `triggerTurn`, so the calling model immediately produces the final answer.
_Avoid_: fusion result, fusion-result (renamed)

**Fusion result**:
The calling model's synthesized final answer — a normal assistant message, so `/copy` works on it. It follows the fusion panel message in the transcript and is grounded in the judge's analysis and the panel responses.
_Avoid_: fusion output, answer (unqualified)

**Degraded**:
The fusion run status when the judge analyzed the panel but at least one panel model failed. Distinct from `ok` (all panels succeeded) and `error` (all panels failed, no judge run).
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

## Context Capsules

**Context Capsule**:
A bounded, redacted, versioned context snapshot derived from one Pi session. It carries the session's objective, constraints, key decisions, relevant resources, observed changed paths, validation evidence, blockers, risks, and next action so a related session or workflow can continue without receiving the full transcript. A Context Capsule is portable context, not a session transcript or a claim that Pi caused every observed repository change. After the full term is introduced, **capsule** is the preferred shorthand.
_Avoid_: memory (implies mutable long-term recall), session export (implies a transcript copy), handoff brief (only one use of a capsule), bundle (a file-content container that a capsule may reference or include)

## Remote control

**Remote control**:
The capability to view and steer a running Pi session from a second device (the phone) while the session keeps executing on the laptop. Delivered as a Pi extension exposing `/remote`. The phone never executes tools — it is a control surface, not a relocated session.
_Avoid_: remote session (the session does not move), mirror (the phone can also steer, not just watch), handoff/takeover (control is not transferred away from the laptop)

**Execution host**:
The laptop running the Pi process and its agent loop. It owns the working directory, runs all tools, and remains the sole place the session executes — regardless of how many remote clients attach.
_Avoid_: server, host (unqualified)

**Remote client**:
A view-and-steer surface attached over the wire (initially the phone). It streams the transcript out and sends prompts/steering messages in; it holds no working directory and runs no tools.
_Avoid_: thin client (acceptable informally), viewer (it can steer, not only view)

**Remote daemon**:
The single long-lived process on the execution host that owns the one persistent iroh endpoint (and thus the stable node identity the phone pairs with once) and the session registry. It is a multiplexing relay between remote clients and Pi sessions — it does not run the agent loop itself. Extensions connect to it over a local Unix-domain socket.
_Avoid_: server (reserved sense; the daemon is local and p2p), backend (too vague — name the daemon)

**Session registry**:
The daemon's table of Pi sessions currently exposed for remote control — each entry keyed by session id with its display name and working directory. A session enters the registry when its extension runs `/remote`. Lets one paired phone attach to any one of several sessions.
_Avoid_: session list, session pool

**Pairing**:
The one-time exchange that authorizes a remote client. The daemon shows a ticket (as a terminal QR code) and a short pairing code; the client connects, presents the code, and on success the daemon records the client's iroh node id in the allowlist. Done once per device — afterward the device reconnects with no code.
_Avoid_: login, auth (unqualified), handshake (reserved for the per-connection protocol handshake)

**Pairing code**:
The short, human-transcribable secret shown on the execution host during pairing. It guards only the pairing window; it is not a long-lived credential and is not reused for later connections.
_Avoid_: token, password, PIN (acceptable informally)

**Allowlist**:
The persisted set of iroh node ids permitted to drive sessions, written under `~/.pi/agent/remote/`. Authorization after pairing is by node id — cryptographic and unforgeable. Revocation in the POC is "delete the entry by hand."
_Avoid_: whitelist, keyring, trust store

**Ticket**:
The iroh `EndpointTicket` (node id + addressing/relay info) the daemon publishes so a client can reach it. Possession of the ticket grants reachability, not authorization — an unpaired node that dials is rejected before any session data flows.
_Avoid_: invite, link

**Attach**:
The act of a paired remote client binding to one session in the registry to view and steer it. A client attaches to at most one session at a time; attaching is idempotent — each attach triggers a fresh backfill. Detaching leaves the session running untouched.
_Avoid_: connect (reserved for the iroh-level connection), open, join

**Backfill**:
The full current transcript the daemon replays to a client on attach, so the phone shows real history before live deltas resume. Re-sent in full on every (re)attach; there is no missed-event replay buffer.
_Avoid_: history sync, catch-up, replay (replay implies a delta buffer, which there is none)

**Transcript projection**:
The compact form each transcript entry is reduced to before it crosses the wire — role, text, tool name, status, and *truncated* tool output — so the remote client stays a chat surface rather than a log viewer. Applies identically to backfill and live event frames.
_Avoid_: serialization, transform
