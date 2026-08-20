# ADR-0010: LAV runs require a clean primary worktree and apply one frozen patch

- **Status:** Accepted for V1
- **Date:** 2026-08-19

## Context

`/lav-run` creates several coding candidates concurrently. Each candidate must see the same
repository state, must not overwrite another candidate, and must stop changing before verifier
inference begins. The user's primary worktree may also contain unrelated uncommitted work or may
drift while a long run is active.

Git worktrees isolate tracked working files, but they share repository metadata and are not security
sandboxes. Applying a selected candidate directly without checking the primary worktree could
overwrite unrelated changes or apply evidence different from what the verifier judged.

## Decision

1. V1 refuses to start when the primary worktree has tracked, staged, or untracked changes.
2. The run freezes the current `HEAD` commit and creates one detached Git worktree per candidate
   from that exact commit.
3. Candidate Pi sessions run in process, bound to their own worktree, with extension discovery
   disabled so the LAV extension cannot recurse.
4. Candidate sessions must not commit or move `HEAD`. After a session finishes, the orchestrator
   captures a binary patch, repository status, and deterministic evidence packet. Only completed
   candidates are eligible for the tournament.
5. Candidate sessions are disposed before evidence is frozen. Verification consumes immutable
   evidence strings and reuses the native Probabilistic Pivot Tournament.
6. Immediately before applying a winner, V1 verifies that the primary `HEAD` still equals the
   frozen base and that the primary worktree is still clean.
7. The selected frozen patch is checked with `git apply --check` and then applied without staging.
   No other candidate patch is applied.
8. Candidate worktrees are removed on success, candidate failure, verifier failure, cancellation,
   and unsafe-application failure.

## Consequences

- Pre-existing user changes must be committed or stashed before `/lav-run`.
- A run fails safely rather than attempting a three-way merge when the primary worktree drifts.
- The verifier judges a deterministic bounded projection of the immutable patch, while application
  checks and applies the exact frozen patch bytes identified by the recorded hash.
- Untracked candidate files are represented in the frozen binary patch.
- Worktrees prevent ordinary filesystem collisions, but a candidate with shell access is still not
  sandboxed from shared Git metadata or the wider machine.
- Stronger process or container isolation can be added behind the candidate-runner interface without
  changing the frozen-evidence or winner-application contract.
