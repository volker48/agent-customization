# Working agreements

Explicit task instructions override these defaults; project conventions override tool and style preferences.

## Execution

- Complete authorized work through verification. Make routine, reversible decisions yourself; state assumptions that affect the result. Ask when missing information materially changes scope, correctness, or irreversible consequences.
- For substantial work, give a short plan including verification. Explain consequential tradeoffs and recommend an option; push back on unnecessary complexity.
- Read relevant code and tests before editing. Preserve unrelated work; report unrelated issues without fixing them.
- Finish with the outcome, checks run, and any unresolved limitations. Keep claims factual; distinguish verified results from assumptions.

## Implementation

- Make the smallest complete change. Follow existing patterns; avoid speculative features, configuration, abstractions, and unrelated refactoring. Remove dead code introduced by your change.
- Parse untrusted input into precise types at boundaries; encode internal invariants in types and constructors. Handle real external failures, but do not add guards or fallbacks for impossible internal states.
- Fail fast; preserve error causes and useful operation context without exposing secrets. Never silently swallow failures.
- Changed code must pass type checking; justify any suppression. Document non-obvious public API contracts; use Google-style docstrings for Python unless the project differs.
- Comments explain intent, constraints, or tradeoffs. Omit narration, historical notes, and commented-out code.

## Verification

- Run applicable formatting, lint, type checks, and focused tests; inspect the final diff. Report checks you could not run and why. Do not run unrelated suites for prose-only changes.
- For bug fixes, add or identify a regression test; demonstrate failure before and success after when practical. Test observable behavior, not implementation details; use integration tests when unit tests miss the interaction.
- Mock external or nondeterministic boundaries only, never the logic under test. Follow project test layout; otherwise use Python `tests/` and colocated TypeScript `*.test.ts`.

## Dependencies and security

- Prefer existing dependencies or the standard library; justify additions. Verify new version selections against official sources; disclose when verification is unavailable. Commit lockfile updates and use exact production pins where appropriate.
- Review install scripts before enabling them. Use dependency cooldowns where supported. Audit dependencies before deployment.
- Keep secrets out of source and logs; use environment variables and gitignored `.env` files. Avoid machine-specific paths in code.
- Pin GitHub Actions to full commit SHAs with version comments.

## Tool defaults

Use project scripts and installed tooling; do not replace a project's toolchain to satisfy these defaults. Keep docs and CI aligned when changing tooling.

- Search: `rg`; `fd` for files, `ast-grep` for syntax-aware queries.
- Python: `uv` (no `pip` fallback), `hatchling`, `ruff format`, `ruff check`, `ty check`, `pytest`. Run checks through `uv run`.
- Node/TypeScript: `pnpm`, `oxfmt`, `oxlint`, `tsc --noEmit`, `vitest run`. Before installs, ensure project configuration disables install scripts and sets a minimum release age of 1440 minutes; preserve stricter settings.
- Bash: start scripts with `#!/bin/bash` and `set -euo pipefail`; check with `shellcheck` and `shfmt`.
- GitHub Actions: `actionlint`, `zizmor`.

## Git and coordination

- One logical change per commit; imperative subject, at most 72 characters. Never amend or rebase commits pushed to shared branches.
- When related local Pi sessions need coordination, use `pi-intercom` if available: `send` for notifications, `ask` only when blocked. Skip it when work can proceed independently.
