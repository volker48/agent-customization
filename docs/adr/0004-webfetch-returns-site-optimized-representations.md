# webfetch returns site-optimized representations, not raw bytes

**Status:** accepted

`webfetch` is a deep module. Its interface is a plain URL; its job is to hand an agent the most token-efficient useful representation of what lives at that URL. When `webfetch` recognizes a site type it can do something smarter with — today GitHub — it does so **internally, deterministically, without the agent opting in or knowing**. The agent never learns a mode flag, a strategy name, or a second tool. It fetches a URL and gets back something good.

The first instance beyond raw-file and issue/PR handling is **GitHub repository orientation**. Pointing `webfetch` at a bare repo root (`github.com/{owner}/{repo}`) previously returned only `HEAD/README.md`. It now returns an orientation representation designed for an agent that needs to plan follow-up reads without chasing ghosts.

## Why

The consumer is an agent (Pi/Fusion), never a human, and the only goals are **token efficiency** and **agent ergonomics**. An agent handed a repo URL used to burn turns: fetch the README, guess `main` vs `master`, guess `src/` vs `lib/`, 404, retry. Two facts kill almost all of that waste — the **default branch** and the **real top-level paths** — so orientation leads with them, adds cheap high-signal metadata, and appends the README.

Keeping this inside `webfetch` rather than a `github_project` tool is itself a token decision: every tool definition costs context on every turn, including turns that never touch GitHub. A deep module taxes nothing at rest and costs the agent zero discovery — it already reaches for `webfetch` with a repo URL.

## Decisions

**Form.** A `webfetch` behavior triggered by auto-detecting a bare repo root. Not a separate tool, not an agent-visible mode. Orientation **replaces** the old README-on-root behavior.

**Output shape.** Plain text, `gh`-CLI aesthetic (sparse labels, terminal-friendly, no JSON — braces and quotes are pure token overhead). Emitted **backbone-first**:

1. `owner/name`
2. description (one line)
3. `default_branch`
4. primary language, topics
5. `homepage` — only when the metadata sets it (non-derivable; the one link worth including)
6. top-level tree, **depth 1 only** (directories marked so the agent knows what it can drill into)
7. README, appended last

- **Depth-1 tree, not recursive.** A recursive tree is a token bomb; depth-1 gives real paths and the agent recurses on demand.
- **No stars/forks/license boilerplate** — zero orientation value.
- **No suggested/ranked-files section.** The depth-1 tree already lists root entry points (`package.json`, `pyproject.toml`, `CONTRIBUTING.md`) by name; a ranking heuristic would add tokens, brittle per-ecosystem code, and a guess that misleads when wrong. The tree *is* the suggestion.
- **No issues/PRs/releases links** — fully derivable from `owner/repo`, and `webfetch` already resolves those URLs.

**Token budget / truncation.** No new knobs. Backbone-first ordering means the cheap structural facts effectively always survive; the README is the only part that can truncate, and the existing machinery (`DEFAULT_MAX_LINES` / `DEFAULT_MAX_BYTES`, then `maxChars`, full copy spilled to a temp file) applies to the combined output. The full README stays recoverable from the temp file.

**Auth.** Keep the existing opportunistic behavior in `githubApiHeaders()` — `GITHUB_TOKEN`/`GH_TOKEN` if present (5,000 req/hr), anonymous otherwise (60 req/hr, ~20 orientations). No required config. A 403 rate-limit response must produce a clear error ("GitHub API rate limit hit; set GITHUB_TOKEN"), not a bare status.

## Considered options

- **A separate `github_project` tool.** Rejected. Self-documenting, but every agent turn pays for its schema whether or not GitHub is involved, and it overlaps confusingly with `webfetch`, which already takes `github.com` URLs. The deep module wins on the token north star.
- **An agent-visible `orient` param / mode.** Rejected. Pushes an implementation detail into the interface. A deep module decides internally; the agent shouldn't have to know a repo root is special.
- **README as outline or excerpt instead of full.** Rejected. Strips too much orientation signal for the token savings and adds a summarizer to build and maintain. Full README with backbone-first ordering matches the `gh` gold standard and reuses existing truncation.

## Consequences

- Future site-specific smarts (npm, PyPI, docs hosts) follow this pattern: recognized internally, returned as an optimized plain-text representation, no new agent-facing interface. A future architecture review should **not** re-suggest promoting GitHub orientation into its own tool or exposing a mode flag.
- Orientation on a repo root is a behavior change: callers that relied on `webfetch` returning raw `README.md` for a bare repo root now get orientation (which still contains the README).
- Implementation is deliberately out of scope here (issue #2 is decision-only) and lands as a separate follow-up issue referencing this ADR.
