# Persist one durable Headlong actor per workspace

**Status:** accepted

## Context

Pi extensions live only as long as their Pi host. A long-running coding objective needs durable wake
scheduling, bounded unattended turns, and a way to resume the canonical Pi session after that host
exits. Pi already owns the conversation trajectory as a session tree/JSONL, and PRO-LONG already
provides a private active-branch projection for programmatic historical reads. Copying transcript
memory into a second Headlong database would create competing sources of truth.

Unattended work creates a stronger safety boundary than an interactive turn. Concurrent hosts,
stale processes, unbounded retries, missing end-of-turn decisions, inherited broad tools, or a weak
filesystem boundary can turn a scheduler into a credential reader, persistence mechanism, or
accidental deployment system.

## Decision

The `headlong` Pi extension owns one actor identified by the SHA-256-derived identity of the
filesystem-canonical workspace path, so symlink aliases converge. The exact Pi session ID and file
stored in actor state remain the canonical trajectory; a different live session is rejected. The
external supervisor explicitly loads both Headlong and PRO-LONG and preserves repository context
files. It does not invent another transcript store.

Durable state lives at
`$PI_HEADLONG_STATE_ROOT/<actor-id>/actor-state.v1.json`. The root defaults to
`$XDG_STATE_HOME/pi-headlong`, or `~/.local/state/pi-headlong` when `XDG_STATE_HOME` is unset. State
writes use a private temporary file, file fsync, atomic rename, and directory fsync.

`events.v1.jsonl` is an operational health and audit stream, not model memory and not the source of
control truth. Once canonical state commits, runtime state is reconciled even if event append fails;
the failure is surfaced as degraded logging rather than rolling back or wedging the actor. Sequence
allocation reads a bounded tail instead of replaying the complete history. The append lock carries an
unguessable token, PID, process-start identity, and timestamp. It can be recovered only after the
grace period and negative liveness evidence, and release uses an atomic move plus owner revalidation.
A malformed final event record from an interrupted append may be truncated; malformed earlier data
fails closed.

A private directory lease provides single-flight ownership across the live extension and supervisor.
The supervisor remains the primary owner for the complete wake. Its Pi child atomically installs a
same-token delegate record containing the child's PID and process identity, rather than replacing the
primary identity. A contender must observe both primary and delegate as dead before stale takeover.
After the child exits, the supervisor must atomically clear or reclaim the delegate and revalidate the
primary token before reading or mutating actor state. Missing or malformed owner metadata provides no
negative liveness evidence and therefore requires operator recovery. Lease release atomically moves
the directory to a unique tombstone, validates the moved owner token, and only then removes it, so an
old owner cannot pathname-delete a replacement lease.

A live extension schedules in-process wakes. The external `pi-headlong` supervisor is the only
component that wakes after the original Pi process exits. It resumes the stored session through Pi's
pinned RPC CLI, explicitly loads Headlong and PRO-LONG, and requires a matching durable control
transition, accepted RPC settlement, a complete stream, and a clean zero-status child exit for
verified success. A durable `stopped` transition remains stopped after an unclean child exit. A
durable `completed` transition followed by an unclean stream or nonzero exit becomes
`completed-unverified`, preserving completed work while requiring operator review. The CLI returns a
nonzero status for failed one-shot wakes, missing state, exhausted loops, and unverified terminal
outcomes. It never launches while another primary owner is live and revalidates due status only after
acquiring the lease.

Because descendant containment relies on POSIX process groups, the wake-after-exit supervisor fails
closed before spawning an RPC child on Windows. The abort listener is registered before the spawn
window and immediately rechecked so shutdown cannot be missed between the initial check and child
creation. Reopening the canonical live Pi session with a persisted active wake performs the same
bounded interrupted-wake recovery before scheduling new work.

Every wake must end through exactly one sequential tool:

- `headlong_checkpoint`: meaningful progress; reset idle backoff and continue immediately.
- `headlong_sleep`: schedule a bounded explicit or exponentially backed-off delay.
- `headlong_complete`: terminate successfully.
- `headlong_blocked`: stop until a user resumes the actor.

Interactive or RPC input while an actor sleeps is a meaningful event. It creates one serialized wake
and resets idle backoff. A settled turn without a matching transition fails closed to `paused`. Turn
budgets and an independent wall-clock watchdog also abort and pause. `/headlong pause` is the visible
reversible kill switch; `/headlong stop` is terminal. An explicit transition disables every tool
until the current turn settles, then restores the interactive tool set and arms any next wake.
Abort-based kill switches retain the unattended tool boundary through the same settlement cleanup.

Headlong does not implement a filesystem sandbox. Therefore the default unattended active set is
only the four control tools. Model-facing `read`, `grep`, `find`, `ls`, `edit`, and `write` are absent,
which prevents absolute-path access, parent traversal, home expansion, `/proc` access, and symlink
escapes through those tools. Host filesystem tools require the explicit
`--allow-unsandboxed-host-tools` operator flag or equivalent extension option. The CLI emits a
prominent warning. Only after that opt-in may `PI_HEADLONG_TOOLS` choose a subset of
`read,grep,find,ls,edit,write`; it still cannot add shell, network, publication, GitHub mutation,
release, deployment, messaging, or arbitrary extension tools. `PI_HEADLONG_TOOLS` alone cannot
enable host filesystem access without the explicit unsandboxed-mode opt-in.

Operators who enable host filesystem tools must supply the isolation boundary outside Headlong, such
as a container with the workspace mounted read/write, required Pi session and PRO-LONG paths mounted
read-only, Headlong state hidden from model-facing tools, and dedicated credentials. Unsandboxed host
mode intentionally retains Pi's normal absolute-path and symlink semantics and is not recommended on
a credential-bearing user account.

## Consequences

- Pi's session tree remains the only durable conversation history; Headlong state is operational.
- PRO-LONG can recover older active-branch evidence without duplicating the transcript.
- The primary-plus-delegate lease preserves ownership across child execution and post-child cleanup.
- Corrupt ownership records are quarantined for operator recovery instead of guessed from age.
- Operational logging can degrade without blocking canonical state progress.
- Event append work remains bounded as the operational log grows.
- Extension reload and shutdown invalidate timers, restore the previous tool set, and release only an
  owned primary or delegate record.
- Interrupted wakes receive bounded recovery backoff and eventually pause at the consecutive-failure
  limit.
- The supervisor must run as an external process or service if wake-after-exit is required. Merely
  enabling the extension does not survive host exit.
- Useful unattended filesystem work requires an operator-provided sandbox and explicit opt-in.
- Public and destructive effects remain out of scope. Users must pause and authorize them
  interactively.
- Same-user compromise remains outside the boundary. The state owner can inspect process
  environments, alter owned files, or bypass the extension entirely.

## Recovery

Use `/headlong status` to locate actor state. Stop the supervisor before manual repair. A corrupt state,
lease owner, event lock, or unsafe symlink/ownership boundary is rejected rather than guessed.
Preserve the actor directory for forensics, move it aside, restart Pi, and use `/headlong start` to
create fresh state against the current canonical session. Use `/headlong resume` after resolving a
`blocked` or `paused` condition. Treat `completed-unverified` as terminal until an operator inspects
the canonical Pi session and actor state.

## Rejected alternatives

- **Extension-only persistence:** cannot wake after the Pi host exits.
- **A supervisor that transfers its sole owner identity to the child:** loses ownership during child
  exit and post-child cleanup.
- **A supervisor and child with independent leases:** self-deadlocks.
- **PID-only stale recovery:** can confuse PID reuse with the original owner.
- **Elapsed-time-only lock eviction:** can steal a lock from a live writer during a slow append.
- **Automatic recovery of corrupt owner metadata:** cannot prove the prior owner is dead.
- **Default unsandboxed host filesystem tools:** exposes credentials, neighboring repositories, and
  persistence surfaces to unattended prompts.
- **A second transcript or vector-memory database:** duplicates Pi and PRO-LONG ownership.
- **Arbitrary thinker executables, dashboards, actor messaging, or provider adapters:** expand the
  execution and trust surface without being necessary for one persistent workspace actor.
