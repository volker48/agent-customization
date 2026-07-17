# Plan 005: Remove the unused GitLab CI config, keep full-suite test coverage on GitHub, and patch the vitest advisory

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f73bfca..HEAD -- .github/workflows/pr-checks.yml .gitlab-ci.yml vitest.unit.config.mjs package.json pnpm-lock.yaml`
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

This project runs exclusively on GitHub. `.gitlab-ci.yml` is dead
configuration: nothing runs it, it's a second source of truth for the build
contract that silently drifts from the real GitHub gate, and it implies a merge
gate that doesn't exist. Delete it.

Before deleting, fold in the one thing GitLab did that GitHub does **not**: it
ran the **full** `pnpm test` suite. The GitHub gate (`pr-checks.yml`) runs
`pnpm test:unit`, which **excludes** `tests/remote-daemon.test.ts` and
`tests/remote-iroh-transport.test.ts` — two suites covering the highest-churn
remote code (`remote/daemon.ts` has ~10 commits in the last year). So today those
suites are only exercised by the GitLab pipeline nobody runs. If we just delete
`.gitlab-ci.yml`, that coverage vanishes entirely. This plan therefore makes the
GitHub gate cover those two suites **before** removing the GitLab file.

Everything else GitLab did is already equalled or bettered on GitHub, so there is
nothing else to fold in (see "What GitLab did vs GitHub" below).

Separately, `pnpm audit` reports one **critical** advisory
(GHSA-5xrq-8626-4rwp) against `vitest` `>=4.0.0 <4.1.0`; it only bites when the
Vitest UI server is listening (this repo never enables it), so it's
low-reachability but trivially patched with a patch-level bump. That's bundled
here because it also touches the test tooling.

## Current state

### The file to delete — `.gitlab-ci.yml` (whole file)

```yaml
image: node:22-bookworm-slim
stages: [verify]
workflow:
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
    - if: $CI_COMMIT_BRANCH
# ...pnpm cache + corepack setup...
lint:       { script: [pnpm run lint] }
format:     { script: [pnpm run format:check] }
typecheck:  { script: [pnpm run typecheck] }
test:       { script: [pnpm run test] }   # <-- FULL suite; the one thing to preserve
```

### What GitLab did vs GitHub (so you can confirm nothing else is lost)

| Concern                | GitLab (`.gitlab-ci.yml`)        | GitHub (`pr-checks.yml`)                          | Action |
|------------------------|----------------------------------|---------------------------------------------------|--------|
| lint / format / typecheck | yes                           | yes (`node-unit` job)                             | already covered |
| test suite             | `pnpm test` (**full**)           | `pnpm test:unit` (**excludes 2 remote suites**)   | **fold in** (Step 2) |
| install hardening      | `--ignore-scripts` only          | `minimumReleaseAge 1440` + `ignore-scripts true`  | GitHub is stricter — nothing to fold |
| Swift / iOS build      | none                             | `swift-remote-control` job                        | GitHub-only — nothing to fold |

So the ONLY substantive GitLab-only behavior is running the full test suite.

### The exclusion to remove — `vitest.unit.config.mjs` (whole file)

```js
export default {
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: [
      "tests/*.e2e.test.ts",
      "tests/*.baseline.test.ts",
      "tests/remote-daemon.test.ts",
      "tests/remote-iroh-transport.test.ts",
    ],
  },
};
```

`.github/workflows/pr-checks.yml` runs `pnpm test:unit` (`pr-checks.yml:48-49`).
`package.json`: `"test": "vitest run"`,
`"test:unit": "vitest run --config vitest.unit.config.mjs"`.

### The advisory

`pnpm audit` (dev-only critical): `vitest 4.0.18` is in the vulnerable range
`>=4.0.0 <4.1.0`; the fix is `>=4.1.0`. No `@vitest/ui` / `--ui` usage exists in
`package.json` or the config (grep confirms), so the vulnerable path is not
reachable here — but the bump is cheap and removes the audit finding.

### GitLab references elsewhere — do NOT touch these

`rg -il gitlab` finds other files, but they are unrelated to CI and must be left
alone:
- `pi-extensions/webfetch.ts`, `pi-extensions/lib/webfetch-core.ts`,
  `tests/webfetch.test.ts`, and several `openwiki/*` pages reference GitLab as a
  **webfetch target** (fetching gitlab.com repo/blob URLs) — a product feature,
  not CI.
- `docs/adr/0006-*.md`, `docs/adr/0008-*.md` reference GitLab as a **pr-watch
  forge provider** — product, not CI.
- `README.md:213` mentions "GitLab CI" in the context of the **external
  `babysit` repo**, not this repo. Leave it.

Only `.gitlab-ci.yml` is CI config for *this* repo. Deleting it leaves no
dangling references in hand-maintained files.

## Commands you will need

| Purpose        | Command                                                  | Expected on success |
|----------------|----------------------------------------------------------|---------------------|
| Install        | `pnpm install --frozen-lockfile`                         | exit 0              |
| Audit          | `pnpm audit`                                             | no critical advisories |
| The 2 suites   | `pnpm test -- tests/remote-daemon.test.ts tests/remote-iroh-transport.test.ts` | all pass, no flakiness |
| Unit suite     | `pnpm test:unit`                                         | all pass            |
| Full suite     | `pnpm test`                                              | all pass            |

## Scope

**In scope** (the only files you should modify or delete):
- `.gitlab-ci.yml` — **delete** (Step 3, only after Step 2 preserves its coverage).
- `vitest.unit.config.mjs` — remove the two `remote-*` excludes (Step 2, only if
  the suites prove stable).
- `package.json` — bump `vitest`.
- `pnpm-lock.yaml` — regenerated by the install after the bump.

**Out of scope** (do NOT touch):
- `.github/workflows/pr-checks.yml` — no edit needed; folding coverage in at the
  `vitest.unit.config.mjs` level makes `pnpm test:unit` cover the two suites
  without changing the workflow. (See Step 2's alternative if that path is
  blocked.)
- The `swift-remote-control` job — GitHub-only, keep it.
- The e2e/baseline excludes in `vitest.unit.config.mjs` — env-gated deliberately;
  leave them.
- Every GitLab reference listed under "do NOT touch these" above (webfetch,
  pr-watch ADRs, README babysit note) — product/external, not this repo's CI.
- Any test file's assertions — if a suite is flaky, this plan does not fix the
  flakiness (that's a STOP → separate plan), it only decides gate membership.

## Git workflow

- Branch: `advisor/005-remove-gitlab-ci`
- Commit style: conventional commits. Consider three commits:
  `chore(deps): bump vitest past GHSA-5xrq-8626-4rwp`,
  `test: run remote daemon/transport suites in the unit gate`,
  `ci: remove unused GitLab CI config`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Bump vitest past the advisory

Edit `package.json` devDependencies: change `"vitest": "4.0.18"` to the latest
`4.1.x` (or newer within major 4). To find the exact latest 4.x without guessing:
`pnpm view vitest versions --json | tail` (read-only) and pick the highest 4.x.
Then run `pnpm install` to update `pnpm-lock.yaml`.

Note: this repo's `.npmrc` sets `minimumReleaseAge` (a cooldown). If `pnpm
install` refuses the chosen version because it's too new, pick the highest 4.x
that satisfies the cooldown, or report that no 4.x ≥ 4.1.0 is old enough yet
(STOP condition).

**Verify**: `pnpm audit` → the `vitest` critical advisory is gone (no critical
advisories, or only unrelated ones you must report). `pnpm test:unit` → all pass
on the new vitest.

### Step 2: Fold in GitLab's full-suite coverage BEFORE deleting anything

This is the "fold in anything useful" step. The two remote suites must run under
the GitHub gate before `.gitlab-ci.yml` is removed, or coverage is lost.

Run the two suites directly, several times, to check for flakiness:

```
pnpm test -- tests/remote-daemon.test.ts tests/remote-iroh-transport.test.ts
```

Run it at least 3 times.

- **If they pass reliably every run**: remove the two `remote-*` lines from the
  `exclude` array in `vitest.unit.config.mjs` so `pnpm test:unit` now includes
  them. The GitHub gate (`pnpm test:unit`) now covers everything the deleted
  GitLab `test` job covered. No workflow-file edit needed.
- **If they are flaky (any run fails non-deterministically)**: STOP. Do NOT
  delete `.gitlab-ci.yml` yet and do NOT force a flaky suite into the primary
  gate — that would just move the pain. Report the flaky behavior with the
  failing output. De-flaking (fake timers / ephemeral sockets) is a separate
  plan; only after it lands can these suites join the gate and the GitLab file be
  removed. (Rationale: deleting the GitLab file while the suites are flaky-and-
  excluded would drop their coverage to zero.)

**Verify** (stable path): `pnpm test:unit` now runs the two suites (its output
lists them) and passes; `pnpm test` still passes.

### Step 3: Delete the GitLab CI config

Only after Step 2's stable path succeeded (the two suites now run in
`pnpm test:unit`): delete `.gitlab-ci.yml`.

```
git rm .gitlab-ci.yml
```

Do not create any replacement file. GitHub Actions (`pr-checks.yml`) is the sole
CI.

**Verify**: `.gitlab-ci.yml` no longer exists (`ls .gitlab-ci.yml` → not found);
`git status` shows it staged for deletion.

### Step 4: Confirm the gate is complete and self-consistent

Confirm the unit config no longer excludes the two remote suites and that both
`pnpm test:unit` and `pnpm test` pass. The only remaining `test:unit` exclusions
should be the env-gated `*.e2e.test.ts` and `*.baseline.test.ts`.

**Verify**: `grep -n "remote-daemon\|remote-iroh" vitest.unit.config.mjs`
returns nothing; `pnpm test:unit` and `pnpm test` both pass.

## Test plan

- No new tests. Verification is: the two previously-excluded suites now run under
  `pnpm test:unit` and pass, `.gitlab-ci.yml` is gone, `pnpm audit` is clean of
  the vitest critical, and the full suite still passes.

## Done criteria

ALL must hold:

- [ ] `.gitlab-ci.yml` is deleted (`git status` shows the deletion)
- [ ] EITHER `vitest.unit.config.mjs` no longer excludes the two `remote-*`
      suites and `pnpm test:unit` passes including them, OR you STOPPED at Step 2
      and reported flakiness (in which case `.gitlab-ci.yml` is NOT deleted)
- [ ] `pnpm audit` reports no critical advisory for `vitest`
- [ ] `package.json` pins `vitest` `>=4.1.0` (within major 4) and `pnpm-lock.yaml`
      is updated
- [ ] `pnpm test` exits 0
- [ ] No GitLab reference outside `.gitlab-ci.yml` was touched (webfetch,
      pr-watch ADRs, README babysit note, openwiki all unchanged)
- [ ] `git status` shows only in-scope files changed/deleted
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Either remote suite fails non-deterministically across the Step 2 runs — report
  the flakiness; do NOT delete `.gitlab-ci.yml` and do NOT add a flaky suite to
  the primary gate. Deleting GitLab while these suites are excluded would drop
  their coverage to zero, so the deletion waits on a separate de-flake plan.
- No `vitest` 4.x version ≥ 4.1.0 satisfies the `.npmrc` `minimumReleaseAge`
  cooldown — report and stop (the operator may lower the cooldown or wait). You
  may still proceed with Steps 2–3 independently if asked, but flag it.
- The vitest bump breaks the existing suite (API changes within 4.x) in a way
  that isn't a trivial fix.
- `.gitlab-ci.yml` turns out to contain a job with no GitHub equivalent that
  isn't in the "What GitLab did vs GitHub" table above (i.e. the file drifted
  since this plan was written) — report it so its coverage can be folded in
  before deletion, rather than silently dropped.
- A verification fails twice after a reasonable fix attempt.

## Maintenance notes

- After this lands, GitHub Actions (`pr-checks.yml`) is the single CI source of
  truth, and `pnpm test:unit` (the gate) covers the same tests as the full
  `pnpm test`. If someone later adds a new exclude to `vitest.unit.config.mjs`,
  they are re-opening the coverage gap this plan closed — call it out in review.
- If a GitLab pipeline is ever genuinely wanted again, it should `extends`/reuse
  the same `package.json` scripts rather than re-encode the build contract, so
  the two can't drift.
- The `swift-remote-control` (macOS/iOS) job runs only on GitHub and had no
  GitLab equivalent — nothing changes for it here.
- Reviewer should confirm the two remote suites actually appear in the
  `test:unit` run output (not silently still excluded by another pattern) and
  that `pnpm audit` is clean.
