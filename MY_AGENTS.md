# Working agreements

Explicit task instructions override these defaults; project conventions override tool and style preferences.

## Execution

- Carry authorized work all the way through verification. Make routine, reversible decisions yourself by choosing whatever you would have recommended to the user; state assumptions that affect the result. Ask when missing information materially changes scope, correctness, or irreversible consequences.
- For substantial work, give a short plan including verification. Explain consequential tradeoffs and recommend an option; push back on unnecessary complexity.
- Read relevant code and tests before editing. Preserve unrelated work; report unrelated issues without fixing them.
- Finish with the outcome, checks run, and any unresolved limitations. Keep claims factual; distinguish verified results from assumptions.
- Treat a review finding as one case of a class: find the other cases by their cause before pushing. When a later round finds more of the same class, stop patching instances: zoom out, look for the one fix or redesign that removes the whole class, and put it and its alternatives to the user, even when the individual fixes are pre-authorized.
- On long tasks, commit after each verified step rather than at the end, on whichever branch you are working on (main or a worktree branch alike), and update any task notes; assume the session can be cut off at any point.

## Implementation

- When asked to remove a language from a project, remove its application code only. Config files that the project's tools require in that language (such as `cloudflare.config.ts` in a Rust project) stay, and so do those tools; ask before replacing one.
- Parse untrusted input into precise types at boundaries; encode internal invariants in types and constructors. Handle real external failures, but do not add guards or fallbacks for impossible internal states.
- Fail fast and fail loud; preserve error causes and useful operation context without exposing secrets. Never silently swallow failures.
- Changed code must pass type checking; justify any suppression. Document non-obvious public API contracts; use Google-style docstrings for Python unless the project differs.
- Comments explain intent, constraints, or tradeoffs. Omit narration, historical notes, and commented-out code.

## Verification

- Run applicable formatting, lint, type checks, and focused tests; inspect the final diff. Report checks you could not run and why. Do not run unrelated suites for prose-only changes.
- For bug fixes, add or identify a regression test; demonstrate failure before and success after when practical. Test observable behavior, not implementation details; use integration tests when unit tests miss the interaction.
- Mock external or nondeterministic boundaries only, never the logic under test. Follow project test layout; otherwise use Python `tests/` and colocated TypeScript `*.test.ts`.
- After a failed build, treat every later run, render, perf or test result as stale until a clean build succeeds. After running a formatter, re-read a file before editing it.
- If GitHub Actions fails on a billing or spending-limit error, don't change code for it: run the repo's local gate, state in the PR that CI was blocked externally and only local checks ran, and continue.

## Dependencies and security

These rules govern what you add or change, and apply in full to repos I own. In someone else's repo, follow its conventions and keep working: report gaps (such as unpinned Actions) instead of fixing them or refusing.

- Prefer existing dependencies or the standard library; justify additions. Verify new version selections against official sources; disclose when verification is unavailable. Commit lockfile updates; pin exact versions for deployed applications, and keep ranges for published libraries.
- Review install scripts before enabling them. Use dependency cooldowns where supported. Audit dependencies before deployment with the project's audit tooling or the ecosystem's standard auditor (such as `cargo audit` or `pnpm audit`).
- Keep secrets out of source and logs; use environment variables and gitignored `.env` files. Avoid machine-specific paths in code.
- Pin GitHub Actions to full commit SHAs with version comments.

## Tool defaults

Use project scripts and installed tooling; do not replace a project's toolchain to satisfy these defaults. Keep docs and CI aligned when changing tooling.

- Search: `rg`; `fd` for files, `ast-grep` for syntax-aware queries.
- Python: `uv` (no `pip` fallback), `hatchling`, `ruff format`, `ruff check`, `ty check`, `pytest`. Run checks through `uv run`.
- Node/TypeScript: `pnpm`, `oxfmt`, `oxlint`, `tsc --noEmit`, `vitest run`. In repos I own, before installs ensure project configuration disables install scripts and sets a minimum release age of 1440 minutes; preserve stricter settings.
- Bash: start scripts with `#!/bin/bash` and `set -euo pipefail`; check with `shellcheck` and `shfmt`.
- Cloudflare: the `cf` CLI with `cloudflare.config.ts`, which replaces Wrangler for dev, migrations and deploys. Never move a project from `cf` to Wrangler; `cf` may still hand builds to Wrangler through `wrangler.config.ts`.
- GitHub Actions: `actionlint`, `zizmor`.

## Git and coordination

- One logical change per commit; imperative subject, at most 72 characters. Never amend or rebase commits pushed to shared branches.
- File issues about mcstack skills (bde-mode, principle-*, reflect and the rest, including copies vendored into other repos under `.agents/skills/`) against `volker48/mcstack`, whose checkout is `~/code/mcstack`, not against the repo that vendors them.
- Config or skills asked for "in the repo" go under the repo (such as `.claude/` or `.agents/`) and get committed, never in the global `~/.claude`.
