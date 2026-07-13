# Coding Standards

Bias toward caution over speed. For trivial tasks, use judgment.

## Core Behavior

- State assumptions explicitly.
- Ask when requirements are unclear, ambiguous, or risky.
- Present tradeoffs when multiple reasonable approaches exist.
- Push back on unnecessary complexity or unsafe changes.
- For non-trivial work, give a short plan with verification steps.

## Simplicity

Build only what was requested.

- No speculative features.
- No one-off abstractions.
- No unnecessary configurability.
- No error handling for impossible scenarios.
- If the solution feels overbuilt, simplify it.

## Surgical Changes

Touch only what is needed.

- Match existing style and conventions.
- Do not refactor unrelated code.
- Do not clean up adjacent code unless asked.
- Remove only unused code created by your change.
- Mention unrelated issues instead of fixing them silently.

Every changed line should trace back to the user’s request.

## Code Quality

Hard limits unless the project explicitly differs:

- ≤ 50 lines per function.
- Cyclomatic complexity ≤ 8.
- ≤ 5 positional params, ≤ 12 branches, ≤ 6 returns.
- 100-character line length.
- No `..` relative imports.
- Google-style docstrings for non-trivial public APIs.
- No scheduled CI without code changes.
- All changed code must pass type checking.
- No ignored type errors without justification.

Follow existing project test conventions. For new projects:

- Python: `tests/`
- Node/TypeScript: colocated `*.test.ts`

## Comments

Prefer clear code over explanatory comments.

Avoid:

- Comments that repeat what code does.
- Commented-out code.
- Comments that compensate for poor naming.
- Historical update notes like “now supports X.”

Use comments for non-obvious intent, tradeoffs, or constraints.

## Error Handling

- Fail fast with clear messages.
- Never swallow exceptions silently.
- Include context: operation, input, and failure cause.

## Error-handling philosophy

Make bad states unrepresentable; don't defensively handle them.

- Enforce invariants in types and schemas, not scattered runtime checks. If a value can't be
  null, don't type it as nullable—then stop null-checking it.
- Don't add fallbacks, defensive guards, or broad error handling for states that correct types
  already make impossible.
- Prefer precise types, discriminated unions, required fields, branded/newtypes, and narrow
  constructors over runtime guards.
- Parse, don't validate: convert untrusted input into a precise type once at the boundary, then
  rely on it everywhere downstream.
- The right fix is never "handle every malformed case." It's to make the malformed case impossible
  to construct.

## Workflow

Before finishing or committing:

1. Run the relevant formatter/linter.
2. Run the relevant type checker.
3. Run focused tests.
4. Inspect the diff.

For bug fixes, add or identify a test that fails before the fix and passes after.

Do not commit rule-breaking code. PRs and issues should be factual, not hyperbolic.

## Testing

- Mock boundaries, not logic.
- Mock only slow, non-deterministic, or external things: network, filesystem, databases, time, randomness, and services you do not control.
- Do not mock the code under test. If a test passes with the implementation removed, it is over-mocked.
- When practical, verify new tests fail before the fix and pass after it. Prefer integration tests when unit tests would miss the real interaction.

## Dependencies, Versions, and Security

- Justify every new dependency.
- Prefer standard library or existing dependencies.
- Do not document, validate, or configure phantom features.
- Do not hardcode local paths; use config or environment variables.
- Verify versions against official sources before specifying them.
- If web access is unavailable, say so instead of guessing.
- Keep lockfiles committed.
- Use exact pins for production where appropriate.
- Audit dependencies before deployment.
- Avoid very new packages unless reviewed.
- Do not enable install scripts without review.
- Never commit secrets, API keys, or credentials.
- Use gitignored `.env` files for local development.
- Reference secrets through environment variables.
- Pin GitHub Actions to full commit SHAs with version comments.
- Use Dependabot/package-manager cooldowns where supported.

## Preferred Tools

Project conventions override these defaults.

### General

- Search: `rg`, `fd`, `ast-grep`
- Shell lint/format: `shellcheck`, `shfmt`
- GitHub Actions: `actionlint`, `zizmor`

### Python

- Dependencies/env: `uv`
- Build: `hatchling`
- Lint/format: `ruff`
- Types: `ty check` or project-configured strict type checking
- Tests: `pytest`

Prefer:

```bash
uv run ruff check --fix
uv run ty check
uv run pytest -q
```

Use `uv`, not `pip` fallbacks. Use `ruff`, not mixed formatter/linter stacks. Update README, Makefile, and CI references when tooling changes.

### Node/TypeScript

- Package manager: `pnpm`
- Lint: `oxlint`
- Format: `oxfmt`
- Tests: `vitest`
- Types: `tsc --noEmit`

Prefer:

```bash
oxlint .
oxfmt --write .
vitest run
tsc --noEmit
```

Before installs:

```bash
pnpm config set minimumReleaseAge 1440
pnpm config set ignore-scripts true
```

Audit before deployment and review package scripts before enabling them.

### Bash

All bash scripts must start with:

```bash
#!/bin/bash
set -euo pipefail
```

Check scripts with:

```bash
shellcheck script.sh
shfmt -d script.sh
```

## Git

- Commit messages: imperative mood, ≤ 72-character subject.
- One logical change per commit.
- Never amend or rebase commits already pushed to shared branches.
