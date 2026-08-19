# Hermes PRO-LONG is a reconciled persisted-trajectory projection

**Status:** accepted

## Context

PRO-LONG describes an agent pattern in which old interaction history remains
available outside the active model context and the model retrieves it with
ordinary programmatic tools. PR 123 implemented that pattern for Pi's append-only
session JSONL. Hermes persists sessions in SQLite and supports both rotation-based
and in-place context compression, so the Pi lifecycle cannot be copied directly.

Hermes v0.20.1 exposes plugin hooks around turns and session boundaries, but it
does not expose a supported post-commit compression hook or a public session-store
facade. Its in-place `archive_and_compact` primitive is shared by batch compression,
proactive pruning, and micro-compaction. Persisted message rows have `active` and
`compacted` flags but no compression generation, rewrite reason, timestamp, or link
to the summary that replaced them.

## Decision

Add a standalone, repository-local Hermes plugin under
`hermes-plugins/prolong/`. It materializes a private JSONL projection from the
canonical Hermes `state.db` without modifying Hermes core, persisted conversation
roles, or tool schemas. It registers one cache-safe system-prompt section that names
the projection and may inject a stale-projection warning after synchronization failure.

The plugin:

1. Captures the profile-scoped plugin data directory during `register()` and resolves
   one cache-safe system-prompt path keyed by a stable lineage anchor. A linear
   compression continuation keeps the root anchor; divergent live continuations
   receive distinct anchors so they cannot overwrite or disclose one another.
2. Lazily opens the profile's `state.db` read-only through Hermes `SessionDB`.
3. Uses `get_compression_lineage()` for explicit rotation lineage and
   `get_messages(..., include_inactive=True)` for raw persisted rows.
4. Includes rows where `active=1` or `compacted=1`; abandoned rewound rows are not
   part of the active logical trajectory.
5. Treats lifecycle hooks only as idempotent reconciliation signals. The primary
   normal checkpoint is `on_session_end`, which Hermes fires after final SQLite
   persistence on normal turns.
6. Also reconciles on session start, before model/tool calls, and after model calls
   so resume, early-return, and crash recovery converge on the next reachable hook.
   Reset/finalization are terminal cleanup boundaries rather than extra sync passes.
7. Uses SQLite `data_version` as a conservative invalidator. Every canonical commit
   causes a complete lineage reread, after which an exact serialized suffix may
   append; mutation, compaction, rewind, divergence, restart, or integrity changes
   rebuild atomically.
8. Holds the validated process lock across lineage-anchor selection, canonical
   snapshot acquisition, and projection mutation so a delayed stale reader or a
   divergent sibling cannot overwrite another lineage.
9. Holds a kernel-managed shared lease for each advertised lineage anchor. Finalize,
   orphan cleanup, and plugin unload remove a projection only after releasing the
   local lease and acquiring the anchor's exclusive lease, so one Hermes process
   cannot invalidate a sibling's frozen prompt path. Unload also discovers valid
   projections inherited from a crashed predecessor and read-only adopts their
   descriptor-bound JSONL before deletion; it never rebuilds merely to establish a
   cleanup baseline. A final lease holder may refresh stale local state only from a
   canonical, structurally valid append-only extension published by a sibling.
   Adoption also checks typed session metadata, safe parent IDs, and embedded
   message/session identity. Cleanup prevalidates residual directory artifacts and
   restores a captured log if the directory changes before unlink. Process death
   releases shared leases automatically.
10. Startup sweeping reconciles direct canonical deletion: surviving continuations
    keep the frozen path anchor and are rewritten; the projection is removed only
    when none of its represented sessions remains and no sibling lease is live.

The path lives under the public `ctx.state.data_dir` namespace rather than inside
the quota-bounded `ctx.state` JSON document:

```text
$HERMES_HOME/plugin-data/<prolong-namespace>/sessions/<lineage-anchor-id>/trajectory.jsonl
```

## Fidelity contract

“Complete” means every message row Hermes currently persists for the selected
logical lineage, including soft-archived compacted rows and persisted tool activity.
It does not mean:

- provider-hidden chain of thought or data Hermes never stored;
- abandoned reset/fork/rewind branches;
- an exact event ledger for in-place compression, pruning, or micro-compaction;
- immediate convergence after an abrupt path that bypasses all plugin hooks.

The JSONL is therefore an eventually reconciled, content-complete materialized
view—not an authoritative compression event log. The system-prompt wording and
documentation must preserve that distinction.

Each canonical message remains present as a lossless `message` record. Long message
content also produces bounded, overlapping `message_content_chunk` records. This
deliberate duplication prevents line-oriented file tools from truncating the middle
of a large JSON record and making preserved evidence practically unrecoverable.

## Security decision

The initial backend supports POSIX systems with `O_NOFOLLOW` and fails closed on
unsupported platforms. It uses owner-only directories, a read-only idle log,
regular-file/owner/link/mode checks, descriptor identity checks for append,
full-write loops, `fsync`, same-directory atomic replacement, a validated POSIX
advisory lock that serializes sibling Hermes processes, and per-anchor shared/exclusive
`flock` leases that make lifecycle deletion safe across processes. Lease files are
private empty coordination artifacts; the kernel releases ownership on process death.

These measures are change detection and accidental-disclosure controls. They are
not cryptographic integrity, a sandbox, secure erasure, or protection from root,
same-UID adversaries, compromised process code, backups, or already-authorized
model tools. Cleanup is best effort because crashes and `SIGKILL` bypass hooks.
Windows requires a separate reparse-point, file-ID, owner-SID, and protected-DACL
backend before support can be claimed.

## Compatibility consequence

The plugin imports Hermes's internal `SessionDB` because `PluginContext` has no
public session-store facade. Runtime contract tests are pinned to the installed
Hermes checkout and must fail loudly when this compatibility layer changes. A
future Hermes core API should provide a public read-only session facade plus a
post-commit compression observer carrying mode, generation, archived IDs, inserted
IDs, and committed time.

## Alternatives rejected

- **Patch Hermes core now:** gives the strongest event contract but violates the
  repository-local plugin constraint and makes local deployment harder.
- **Inject old history back into every prompt:** defeats PRO-LONG's context and
  latency objective and harms prompt caching.
- **Add a custom retrieval tool:** unnecessary; ordinary file/search tools are the
  behavior being tested.
- **Append only above a message-ID watermark:** incorrect because compaction mutates
  existing rows' active/compacted status in place.
- **Treat `on_session_end` as durable session close:** incorrect; Hermes normally
  fires it at the end of every user turn.
- **Claim exact in-place compression lineage:** unsupported by the persisted schema.

## Consequences

- Old persisted evidence remains accessible after active-context compression.
- The static prompt prefix and OpenAI role alternation remain unchanged.
- Normal unchanged checks can reuse immutable snapshots without reserializing a
  large trajectory; a 50,000-record no-op remains sub-millisecond on the tested Pi.
- Cold reconstruction is linear in persisted trajectory size.
- Search chunks increase projection size for long content in exchange for reliable
  retrieval through line-oriented tools.
- Projection files duplicate sensitive transcript data and require explicit privacy
  documentation.
- Hermes internal storage changes require updating the compatibility tests.
