# Architecture decisions

This repository keeps accepted decisions in `docs/adr/`. Treat them as primary source material when making design changes.

## ADR-0001: Fusion inner tools are a restricted projection

Source: `docs/adr/0001-fusion-inner-tools-are-a-restricted-projection.md`

Decision:

- Fusion panel and judge calls get exactly two inner tools, `web_search` and `webfetch`, defined in `pi-extensions/fusion/tools.ts`.
- These tools share implementation cores with standalone `exa_search` and `webfetch`, but they intentionally do not share the standalone interface.
- The hand-written two-tool list is a security control and should not be replaced by a broad shared registry.

Why it matters:

- Inner models run outside Pi's normal agent loop and should not receive general coding tools.
- Operator policy from `fusion.json` controls limits and domain restrictions.

## ADR-0002: The calling model synthesizes Fusion final answers

Source: `docs/adr/0002-the-calling-model-synthesizes-the-final-answer.md`

Decision:

- The judge analyzes panel responses and emits structured analysis/confidence.
- The active Pi model writes the final answer after `fusion-panel` is injected with `triggerTurn: true`.
- The final answer is a normal assistant message, not a judge-authored custom result.

Why it matters:

- `/copy` works on the final answer.
- The final synthesis has full Pi session/repository/tool context.
- Tests should assert on panel/judge analysis and triggered synthesis rather than expecting a judge-authored answer.

## ADR-0003: Remote control authorization is node-id allowlist after coded pairing

Source: `docs/adr/0003-remote-control-authorization-is-nodeid-allowlist-after-coded-pairing.md`

Decision:

- iroh secures transport identity but does not authorize remote control.
- A first-time client must present a short pairing code during a fresh pairing window.
- On success, the daemon persists the client's iroh node id under `~/.pi/agent/remote/`.
- Later connections authorize by node id.

Why it matters:

- Remote clients can steer an agent that runs tools unattended on the laptop.
- Bearer-token-only or trust-on-first-connect approaches were rejected.
- Revocation is currently manual by editing/removing allowlist entries.

## ADR-0004: webfetch returns site-optimized representations

Source: `docs/adr/0004-webfetch-returns-site-optimized-representations.md`

Decision:

- `webfetch` should return the most token-efficient useful representation of a URL, not raw bytes by default.
- Site-specific smarts are internal and deterministic; callers should not need a new mode flag or separate tool.
- Bare GitHub repository roots return an orientation view with owner/name, description, default branch, language/topics, optional homepage, depth-1 tree, and README.
- GitLab repository roots and tree URLs receive the analogous REST-backed orientation view; GitLab blob URLs use the raw-file endpoint.
- HTML conversion and URL-fragment extraction are applied consistently enough to handle useful non-2xx HTML pages as well as successful pages.
- Auth for GitHub API calls is opportunistic via `GITHUB_TOKEN`/`GH_TOKEN`; anonymous remains supported until rate-limited.

Why it matters:

- Recent commits implemented GitHub repository orientation, authenticated README fetching through REST endpoints, GitLab repository/blob/tree handling, and HTML error/fragment conversion.
- Future site optimizations should follow this pattern instead of adding one-off tools or exposing implementation modes to agents.

## ADR-0005–0008: PR/MR watcher ownership and extraction

The former in-repository `crates/pr-watch/` Rust CLI was extracted to the standalone [`babysit`](https://github.com/volker48/babysit) project. ADR-0007's Rust location is superseded by ADR-0008; ADR-0005 and ADR-0006 remain historical rationale for the watcher’s settledness contract, bot adapters, and forge providers. This repository no longer owns the Rust workspace, watcher implementation/tests, Rust CI, releases, or installation docs. Current watcher work belongs in `babysit`.

Sources: `docs/adr/0005-pr-watch-awaits-and-distills-pr-state.md`, `docs/adr/0006-pr-watch-bot-adapters-and-forge-providers.md`, `docs/adr/0007-pr-watch-rust-cli-location.md`, and `docs/adr/0008-pr-watch-moved-to-babysit.md`.

## Decision-aware change guidance

- If a proposed refactor conflicts with an ADR, either do not make it or add a new explicit decision that supersedes the old one.
- Do not collapse Fusion inner and standalone web tool schemas merely to reduce duplication; ADR-0001 says the duplication is load-bearing.
- Do not move Fusion final answer authoring back into the judge; ADR-0002 says the active Pi model synthesizes.
- Do not weaken remote pairing/allowlisting for convenience; ADR-0003 treats remote control as a high-power surface.
- Do not add a `github_project` tool or `webfetch` orientation mode without revisiting ADR-0004.
