# Advisor plans

Implementation plans produced by an `/improve` audit of this repo. Each plan is
**fully self-contained** — an executor with zero context from the audit session
can pick one up, follow it, run its verification gates, and update its status
row here.

- **Audited at**: commit `f73bfca`, 2026-07-16
- **Verification gates** (every plan uses these): `pnpm lint` (oxlint),
  `pnpm format:check` (oxfmt), `pnpm typecheck` (tsc --noEmit),
  `pnpm test:unit` (vitest, excludes e2e/baseline + the two remote suites),
  `pnpm test` (full vitest).

## How to use this directory

1. Pick the highest-priority `TODO` plan whose dependencies are `DONE`.
2. Read it top to bottom. Run its "Drift check" first — plans are stamped
   against `f73bfca`; if the in-scope files moved, reconcile before editing.
3. Do the steps in order, running each step's verification command.
4. Honor the STOP conditions — stop and report rather than improvise.
5. Update this plan's status row below when finished.

## Status

| #   | Plan                                             | Priority | Effort | Risk | Category | Depends on | Status |
|-----|--------------------------------------------------|----------|--------|------|----------|------------|--------|
| 001 | Remote session registry cleanup on socket close  | P1       | S      | LOW  | bug      | none       | TODO   |
| 002 | Harden pairing — atomic allowlist + attempt cap  | P1       | S      | LOW  | security | none       | DONE   |
| 006 | Webfetch SSRF: validate resolved IPs, not string | P1       | M      | MED  | security | none       | TODO   |
| 003 | Accept-loop backoff (no busy-spin)               | P2       | S      | LOW  | bug      | none       | TODO   |
| 004 | Extend lint/format scope to plugins & scripts    | P2       | S      | LOW  | dx       | none       | TODO   |
| 005 | Remove unused GitLab CI, keep full test coverage | P2       | S      | LOW  | dx       | none       | TODO   |

## Recommended execution order

No plan hard-depends on another; the six can be executed independently. Suggested
order by leverage (impact ÷ effort, weighted by confidence and blast radius):

1. **002** and **001** — small, low-risk fixes to the remote-control security
   boundary and session lifecycle. Highest value per line changed.
2. **006** — the webfetch SSRF gap. P1 but M-effort (needs a DNS-resolution seam
   and tests) and MED-risk (touches the fetch path), so it lands after the
   trivial remote fixes.
3. **003** — accept-loop backoff; isolated, low-risk loop guard.
4. **004** then **005** — toolchain/CI hygiene. Do **004 before** any future
   work under `plugins/` or `scripts/` so that code lands under lint/format
   enforcement. **005** is independent but pairs naturally with 004; it deletes
   the dead `.gitlab-ci.yml` after first folding its only unique behavior (the
   full test suite) into the GitHub gate.

Soft note: **004** should precede any *new* feature work in `plugins/pi/scripts/`
so new code is linted/formatted from the start — not a hard dependency for the
other five plans.

## Scope discipline (applies to every plan)

- Each plan lists **in-scope** and **out-of-scope** files. Touch only in-scope
  files. Every changed line should trace to a plan step.
- Do not push, open PRs, or commit to a shared branch unless the operator says
  so. Plans specify a branch name and conventional-commit style only.
- Secrets: none of these plans involve credentials. If you encounter one, do not
  reproduce its value — reference `file:line` + type and recommend rotation.

## Findings considered and rejected

Recorded so a future audit doesn't re-surface them. Each was opened and vetted;
each is **not** worth a plan.

- **Fusion panel concurrency cap** — proposed limiting concurrent model calls in
  the Fusion panel. Rejected: typical panels are 2–4 models; there is no real
  resource-exhaustion risk at that scale, and a cap adds config for a
  non-problem.
- **`atomicWriteJson` temp-name collision** (`plugins/pi/scripts/lib/jobs.mjs`) —
  the `${path}.<pid>.<ts>.tmp` temp name was flagged as collision-prone.
  Rejected: writers are already lock-serialized, so two writers don't race on the
  same temp name in practice. (Note: plan 002 independently adds `randomUUID()`
  to the *allowlist* temp name — a different file, for defense in depth, not
  because a collision was observed.)
- **Local `node_modules` drift** — a subagent flagged installed package versions
  differing from the lockfile. Rejected: that's a local environment artifact, not
  a repo defect; the committed lockfile is correct.
- **Webfetch regex-pass performance** — a suggestion that the HTML-processing
  regex passes are slow. Rejected: LOW confidence, no benchmark; optimizing
  without a measured hot path is speculative. Revisit only with a profile.
- **RTK rewrite-map growth** — the rewrite map in the RTK extension grows
  unbounded in principle. Rejected: the leak is minor and bounded by realistic
  session length; not worth the complexity of eviction now.

Audited and found clean (no action): CI supply-chain posture (SHA-pinned
actions, read-only workflow permissions), remote transport crypto, IPC socket
permissions, and credential hygiene (no secrets committed).

## Not audited / audited lightly

- **iOS Swift remote-control client** — light pass only; not deeply reviewed.
- **OpenWiki pages** (`openwiki/`) — treated as generated documentation, not
  audited as source.
- **No runtime benchmarking** was performed; all performance observations are
  static-analysis level and flagged as such (see rejected list).
