# pr-watch awaits and distills PR state deterministically

**Status:** accepted; superseded in part by ADR-0007 and ADR-0008 for implementation
location and CLI name.

`pr-watch` is a CLI that answers two questions an orchestrating agent asks about a pull request,
without spending model tokens to answer them: **"is this PR settled?"** (CI terminal, review bots
done with the current head) and **"what do the bots actually want changed?"** (review threads
distilled to a few plain-text lines each). It exists because session mining showed the same ritual
hand-rolled around every PR: poll `gh pr view` in bespoke bash loops, wait for CodeRabbit/Codex,
then paste their HTML-laden comment blobs into an implementor brief.

## Why

The consumer is an agent, never a human. The orchestrator (Claude Code) delegates fixes to an
implementor (Pi) and needs a deterministic primitive it can run in the background: block until the
PR is ready for the next decision, then read a token-efficient findings list. Today each wait is a
rewritten polling script, and each findings pass drags raw bot comments — badges, collapsed
`<details>`, committable suggestions, fingerprinting comments — through the orchestrator's context.
One CodeRabbit comment is ~2,000 tokens of which ~100 matter.

Deterministic code, not agent prompting: parsing bot comment formats and evaluating check rollups
is mechanical. Every token spent on it inside a model context is waste, and every hand-rolled
polling loop is a chance to get settledness subtly wrong.

## Decisions

**Form.** A standalone CLI (`pr-watch`), callable from any harness through the shell. Not a Pi
extension tool and not a Claude plugin command: both agents already have bash, and a
schema-bearing tool would tax every turn of every session for a per-PR activity (same reasoning as
ADR-0004). All GitHub access goes through the `gh` CLI — auth, base URLs, and pagination are its
problem. ADR-0007 superseded the original TypeScript path and tsx execution details; ADR-0008 moves
the renamed `babysit` CLI out to a standalone repository.

**Subcommands.**

- `pr-watch status [<pr>]` — one-shot snapshot: header, check rollup, bot-review state, unresolved
  finding count. Semantic exit code.
- `pr-watch findings [<pr>]` — distilled unresolved bot findings, ready to paste into an
  implementor brief. Exit 0 on successful listing (it is a data query, not a judgment).
- `pr-watch wait [<pr>]` — poll quietly until settled or `--timeout` (default 1800s, interval 30s),
  then print the `status` block and exit with its code. Designed to run under `run_in_background`:
  one notification, no heartbeat noise.

`<pr>` defaults to the current branch's PR (delegated to `gh`). `--repo`, `--bots`, `--all`,
`--nitpicks`, `--no-reviews`, `--timeout`, `--interval` are the only knobs.

**Settled semantics.** A PR is settled when both hold:

1. Every check in `statusCheckRollup` is terminal (no PENDING/QUEUED/IN_PROGRESS/EXPECTED).
   CodeRabbit's own `StatusContext` participates here, which makes "CodeRabbit is still reviewing"
   a first-class pending state.
2. At least one configured bot has reviewed the current head: a review whose `commit` is the head
   OID or whose `submittedAt` is at or after the head commit's `committedDate`, or a terminal
   status check on the head named after a configured bot (CodeRabbit posts no review when a
   re-review finds nothing, but still flips its per-commit `StatusContext` to SUCCESS).
   `--no-reviews` drops condition 2 (CI-only wait). Bots that stay silent when satisfied (Codex
   posts nothing on a clean re-review) are why condition 2 is satisfied by _any_ configured bot
   rather than all.

A merged or closed PR is settled unconditionally — nothing new can land on it, so `wait` returns
immediately instead of hanging until timeout.

**Distillation contract.** Findings come from unresolved, non-outdated review threads authored by
configured bots (resolution state via GraphQL `reviewThreads`; there is no REST equivalent).
`reviewThreads` is paginated until exhausted before findings are computed; the bot-review landed
signal reads the latest 50 reviews. Each finding renders as `path:line [bot severity]`, a title
line, and a detail block:

- **CodeRabbit** — severity from the `_🟠 Major_`-style header, title from the first bold line,
  detail from the `🤖 Prompt for AI Agents` fenced block (it is CodeRabbit's own distillation —
  use it). Fallback to prose with all `<details>`, suggestion markers, and HTML comments stripped.
- **Codex** — severity from the `P1/P2/P3` badge, title from the badge line, detail is the prose
  minus the reaction footer.
- **Shared preamble hoisting** — when every finding's detail opens with the same first paragraph
  (CodeRabbit repeats the user's configured reviewer instruction in each prompt block), print it
  once as a header instead of N times.
- CodeRabbit's review-body nitpicks (inside `🧹 Nitpick comments`) are excluded by default and
  included with `--nitpicks`; they cannot be resolved like threads and are low-severity by
  construction. `--all` includes resolved and outdated threads, marked as such.

**Output shape.** Plain text, `gh`-CLI aesthetic, backbone-first: header → checks → reviews →
findings. The final line is always machine-stable
(`SETTLED findings=<n> checks=<passed>/<total>` or `PENDING …`/`TIMEOUT …`) so a caller can grep
one line instead of parsing the block.

**Exit codes.** For `status` and `wait`, `0` means settled-clean, `1` settled with unresolved
findings, `2` checks failed, `3` not settled / timed out, and `4` usage or `gh` error. `findings`
returns `0` for a successful listing. An agent can branch on the code without reading output at
all.

## Considered options

- **A Pi extension tool + Claude plugin command.** Rejected for v1: pays schema tax on every turn
  for a per-PR activity; bash reaches the same binary. Either wrapper can be added later without
  touching the core.
- **GitHub webhooks / subscriptions instead of polling.** Rejected: requires server state; the
  30s×30min poll against `gh` is well inside rate limits and matches how the waits are run today.
- **LLM-based comment summarization.** Rejected: the formats are stable enough to parse, the whole
  point is to stop spending tokens here, and CodeRabbit already ships an AI-ready prompt block per
  finding.
