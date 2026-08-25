# Persist one durable Headlong actor per workspace

**Status:** accepted

## Context

Pi extensions live only as long as their Pi host. A long-running coding objective needs durable wake
scheduling, bounded unattended turns, and a way to resume the canonical Pi session after that host
exits. Pi already owns the conversation trajectory as a session tree/JSONL, and PRO-LONG already
provides a private active-branch projection for programmatic historical reads. Copying transcript
memory into a second Headlong database would create competing sources of truth.

Unattended work also creates a stronger safety boundary than an interactive turn: concurrent hosts,
stale processes, unbounded retries, missing end-of-turn decisions, or inherited broad tools can turn
a scheduler into an accidental deployment or message-sending system.

## Decision

The `headlong` Pi extension owns one actor identified by the SHA-256-derived identity of the
filesystem-canonical workspace path, so symlink aliases converge. The exact Pi session ID and file
stored in actor state remain the canonical trajectory; a different live session is rejected. The
external supervisor explicitly loads both Headlong and PRO-LONG and preserves repository context
files; it does not invent another transcript store.

Durable state lives at
`$PI_HEADLONG_STATE_ROOT/<actor-id>/actor-state.v1.json`. The root defaults to
`$XDG_STATE_HOME/pi-headlong`, or `~/.local/state/pi-headlong` when `XDG_STATE_HOME` is unset. State
writes use a private temporary file, fsync, atomic rename, and directory fsync. A small
`events.v1.jsonl` records operational transitions only. It is not model memory and tolerates only a
malformed final record left by an interrupted append.

A private directory lease provides single-flight ownership across the live extension and supervisor.
The supervisor creates one unguessable lease token, and its Pi child atomically adopts that same token
while transferring liveness evidence to the child's PID/process identity. The child does not acquire a
second lease, avoiding self-deadlock; the waiting supervisor retains token-based cleanup authority.
Stale recovery requires both an expired grace period and negative process-identity evidence. On Linux
the identity combines boot ID and process start ticks, so PID reuse does not authorize takeover.

A live extension schedules in-process wakes. The external `pi-headlong` supervisor is the only
component that wakes after the original Pi process exits. It resumes the stored session through Pi's
pinned RPC CLI, explicitly loads Headlong and PRO-LONG, and waits for the matching durable control
transition and a clean zero-status child exit. It never launches while another owner is live and
revalidates due status only after acquiring the lease.

Every wake must end through exactly one sequential tool:

- `headlong_checkpoint` — meaningful progress; reset idle backoff and continue immediately.
- `headlong_sleep` — schedule a bounded explicit or exponentially backed-off delay.
- `headlong_complete` — terminate successfully.
- `headlong_blocked` — stop until a user resumes the actor.

Interactive or RPC input while an actor sleeps is a meaningful event: it creates one serialized wake
and resets idle backoff. A settled turn without a matching transition fails closed to `paused`.
Turn budgets and an independent wall-clock watchdog also abort and pause. `/headlong pause` is the
visible reversible kill switch; `/headlong stop` is terminal, as is successful completion.
An explicit transition disables every tool until the current turn settles, then restores the
interactive tool set and arms any next wake. Abort-based kill switches retain the unattended tool
boundary through the same settlement cleanup.

Unattended wakes narrow active tools to the four control tools plus a fixed safe built-in allowlist:
`read,grep,find,ls,edit,write`. `PI_HEADLONG_TOOLS` may select a subset but cannot add `bash` or
arbitrary extension tools. This excludes direct network, shell, publication, GitHub mutation,
release, merge, deployment, and messaging tools. It is not a filesystem sandbox: `edit` and `write`
still permit local workspace changes.

## Consequences

- Pi's session tree remains the only durable conversation history; Headlong state is operational.
- PRO-LONG can recover older active-branch evidence without duplicating the transcript.
- Extension reload/shutdown invalidates timers, restores the previous tool set, and releases only a
  lease the process itself owns.
- Interrupted wakes receive bounded recovery backoff and eventually pause at the consecutive-failure
  limit.
- The supervisor must run as an external process or service if wake-after-exit is required. Merely
  enabling the extension does not survive host exit.
- Public/destructive effects are intentionally out of scope. Users must pause and authorize them
  interactively.
- Same-user compromise remains outside the boundary: the state owner can inspect process
environments, alter its own files, or bypass the extension entirely.

## Recovery

Use `/headlong status` to locate actor state. Stop the supervisor before manual repair. A corrupt state
or unsafe symlink/ownership boundary is rejected rather than guessed. Preserve the actor directory for
forensics, move it aside, restart Pi, and use `/headlong start` to create fresh state against the
current canonical session. Use `/headlong resume` after resolving a `blocked` or `paused` condition.

## Rejected alternatives

- **Extension-only persistence:** cannot wake after the Pi host exits.
- **A supervisor that holds a separate lease while the child acquires one:** self-deadlocks.
- **PID-only stale recovery:** can confuse PID reuse with the original owner.
- **A second transcript or vector-memory database:** duplicates Pi and PRO-LONG ownership.
- **Arbitrary thinker executables, dashboards, actor messaging, or provider adapters:** expand the
  execution and trust surface without being necessary for one persistent workspace actor.
