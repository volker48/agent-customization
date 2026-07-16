# Plan 004: Bring `plugins/` and `scripts/` under lint and format enforcement

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f73bfca..HEAD -- package.json plugins/ scripts/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `f73bfca`, 2026-07-16

## Why this matters

The `lint` and `format` scripts only cover `pi-extensions` and
`opencode-plugins`. The busiest logic-dense JS in the repo —
`plugins/pi/scripts/**` (the Claude↔Pi RPC bridge and job runner: `implement.mjs`
15 commits/yr, `jobs.mjs` 14, `pi-companion.mjs` 13) and `scripts/**` — gets no
lint and no format enforcement. CI is green while these files are unchecked;
expanding the scope today surfaces one real lint warning and three unformatted
files. Enforcing the same gates on this code stops style drift and catches the
class of bug oxlint already flags.

## Current state

`package.json` scripts (`package.json:11-15`):

```json
"lint": "oxlint pi-extensions opencode-plugins",
"format": "oxfmt --write pi-extensions opencode-plugins package.json tsconfig.json",
"format:check": "oxfmt --check pi-extensions opencode-plugins package.json tsconfig.json",
```

Running the tools over the excluded dirs today shows a bounded backlog:

- `pnpm exec oxlint plugins scripts` → **1 warning**:
  `eslint-plugin-unicorn(no-useless-fallback-in-spread)` at
  `plugins/pi/scripts/lib/review.mjs:51` — `{ ...DEFAULT_CONTEXT_LIMITS, ...(options.limits ?? {}) }`.
- `pnpm exec oxfmt --check plugins scripts` → **3 files need formatting**:
  `plugins/pi/hooks/hooks.json`, `plugins/pi/scripts/pi-companion.mjs`,
  `scripts/verify-rtk-extension.mjs`.

Important: **do NOT add `claude-hooks` to the oxfmt scope.** `oxfmt --check
claude-hooks` fails hard on `claude-hooks/hooks.json` ("Failed to format file
with external formatter"). Keep the new scope to `plugins scripts` only.

`scripts/` contents: `generate-ios-remote-fixtures.ts`, `verify-rtk-extension.mjs`.
`plugins/pi/scripts/` contains the `.mjs` bridge/lib files plus command markdown
and JSON.

## Commands you will need

| Purpose        | Command                              | Expected on success |
|----------------|--------------------------------------|---------------------|
| Install        | `pnpm install --frozen-lockfile`     | exit 0              |
| Lint (new)     | `pnpm lint`                          | exit 0, no warnings |
| Format check   | `pnpm format:check`                  | exit 0              |
| Format write   | `pnpm format`                        | exit 0              |
| Typecheck      | `pnpm typecheck`                     | exit 0, no errors   |
| Full unit      | `pnpm test:unit`                     | all pass            |

## Scope

**In scope** (the only files you should modify):
- `package.json` — the `lint`, `format`, and `format:check` script args.
- `plugins/pi/scripts/lib/review.mjs` — fix the one lint warning.
- The 3 files oxfmt reformats: `plugins/pi/hooks/hooks.json`,
  `plugins/pi/scripts/pi-companion.mjs`, `scripts/verify-rtk-extension.mjs`
  (their changes come from running `pnpm format`, not hand edits).

**Out of scope** (do NOT touch):
- `tsconfig.json` `include` / the `typecheck` script — expanding typecheck to
  the untyped `.mjs` files surfaces an unbounded backlog and is a separate,
  deferred effort (see plan 004's Maintenance notes and the README). This plan
  is lint + format only.
- `claude-hooks/` — oxfmt errors on its `hooks.json`; leave it out of scope.
- Any behavioral change to the `.mjs` logic beyond the single lint fix.

## Git workflow

- Branch: `advisor/004-expand-lint-format-scope`
- Commit style: conventional commits. Consider two commits: one
  `chore(lint): fix no-useless-fallback-in-spread in review.mjs`, one
  `chore(tooling): extend lint/format scope to plugins and scripts`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Fix the existing lint warning first (before widening scope)

In `plugins/pi/scripts/lib/review.mjs:51`, remove the useless empty-object
fallback in the spread. Current:

```js
const limits = { ...DEFAULT_CONTEXT_LIMITS, ...(options.limits ?? {}) };
```

Change to:

```js
const limits = { ...DEFAULT_CONTEXT_LIMITS, ...options.limits };
```

Spreading `undefined`/`null` in an object literal is a no-op, so `?? {}` is
unnecessary — this is exactly what the rule flags. Confirm `options.limits` is
only ever an object or undefined here (read the function signature and callers in
the same file to be sure; if any caller passes a non-object truthy value for
`limits`, STOP and report).

**Verify**: `pnpm exec oxlint plugins scripts` → "Found 0 warnings and 0 errors".

### Step 2: Widen the lint scope

Edit `package.json` `lint`:

```json
"lint": "oxlint pi-extensions opencode-plugins plugins scripts",
```

**Verify**: `pnpm lint` → exit 0, no warnings.

### Step 3: Widen the format scope and apply it

Edit `package.json` `format` and `format:check` to add `plugins scripts`:

```json
"format": "oxfmt --write pi-extensions opencode-plugins plugins scripts package.json tsconfig.json",
"format:check": "oxfmt --check pi-extensions opencode-plugins plugins scripts package.json tsconfig.json",
```

Then run `pnpm format` to reformat the 3 files. Review the diff — it should be
whitespace/style only, no semantic change.

**Verify**: `pnpm format:check` → exit 0. `git diff --stat` shows only the 3
reformatted files plus `package.json`.

### Step 4: Full gate pass

**Verify**: `pnpm lint` → exit 0; `pnpm format:check` → exit 0;
`pnpm typecheck` → exit 0; `pnpm test:unit` → all pass.

## Test plan

- No new tests (tooling-scope change). The gates themselves are the verification.
- Confirm the reformatted `.mjs`/`.json` files still parse and tests that import
  them (`tests/claude-pi-*.test.ts`) still pass via `pnpm test:unit`.

## Done criteria

ALL must hold:

- [ ] `pnpm lint` exits 0 with zero warnings, and its args include `plugins scripts`
- [ ] `pnpm format:check` exits 0, and its args include `plugins scripts`
- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test:unit` exits 0
- [ ] `grep -n "no-useless-fallback" ` is no longer triggered (the review.mjs fix landed)
- [ ] `git status` shows only in-scope files changed
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Widening the scope surfaces MORE than the one documented lint warning or the
  three documented format files — the backlog is larger than expected; report
  the full list so the operator can decide whether to expand this plan.
- Fixing `review.mjs:51` would change behavior because `options.limits` can be a
  non-object truthy value at some call site.
- `pnpm format` rewrites files outside `plugins`/`scripts`/`package.json`.
- A verification fails twice after a reasonable fix attempt.

## Maintenance notes

- **Deferred, separate effort**: bringing `plugins/pi/scripts/**.mjs` under
  `pnpm typecheck` (via `allowJs`+`checkJs` or a `.ts` migration). It surfaces an
  unknown, likely large error backlog and needs its own triage plan — do not
  attempt it here.
- Reviewer should confirm the format diff is style-only and that CI (`pnpm lint`,
  `pnpm format:check`) now exercises the new paths.
- When new top-level JS/TS dirs are added later, remember lint/format scope is an
  explicit allowlist in `package.json`, not a glob over the repo.
