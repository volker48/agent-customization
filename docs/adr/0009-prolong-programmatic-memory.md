# Reuse Pi's session tree for PRO-LONG programmatic memory

**Status:** accepted

## Context

PRO-LONG shows that a coding agent can recover long-horizon evidence by appending its complete
trajectory to an external log and searching that log with ordinary programs. Pi already persists
its interaction trajectory as an append-only session tree, including messages, tool calls and
results, compaction entries, model/settings changes, and extension state.

Creating a second memory database, deciding which observations deserve a write, or replacing Pi's
compaction would duplicate ownership and weaken the paper's core append-all/programmatic-read
mechanism. Exposing Pi's complete session file directly would include abandoned sibling branches
rather than only the branch supplying the current model context.

## Decision

The opt-in `prolong` Pi extension treats `ReadonlySessionManager.getBranch()` as the canonical
source and derives one private JSONL active-branch projection. Every returned `SessionEntry` is
serialized unchanged as one line in root-to-leaf order.

During normal forward progress, synchronization verifies the existing file identity and appends
only entries whose IDs extend the previous sequence. An unchanged branch performs no write.
Divergence, rewind, resume, forced refresh, missing files, or detected filesystem mutation causes
an atomic rebuild.

The projection is stored under `$XDG_RUNTIME_DIR/pi-prolong/<session-id>/`, with an owner-private
OS-temporary fallback. The directory is mode `0700`; the idle JSONL is mode `0400`. Pre-created
symlinked or foreign-owned projection directories are refused. The derived directory is removed
on `/prolong off` and `session_shutdown`.

Enablement is branch-local extension state persisted as `prolong-state` custom entries. New
sessions may opt in with `--prolong` or `PI_PROLONG=1`; `/prolong on|off|status|refresh` controls the
current session. The latest state entry on the active branch overrides process defaults.

The extension synchronizes before agent start and each provider-bound context event. Only after the
provider-bound sync succeeds does it append a short transient custom context instruction containing
the read-only path and ordinary programmatic-read guidance. It does not persist that instruction,
mutate durable session history or provider request payloads, intercept native compaction, or retain
the instruction for later turns. Sync failures fail open for the
coding session, warn once, and omit the hint until synchronization succeeds again.

## Consequences

- Pi's persisted session tree remains the only durable source of truth.
- Programmatic memory is complete relative to Pi-persisted active-branch entries, not
  provider-hidden reasoning or data Pi never stored.
- Logs can duplicate sensitive source, terminal output, or credentials already present in a Pi
  session; opt-in, restrictive permissions, runtime storage, and lifecycle cleanup limit but do
  not remove that privacy risk.
- Normal synchronization cost is proportional to the new suffix, while branch changes pay one
  full rebuild.
- Native Pi compaction can evolve independently because the extension records compaction entries
  rather than replacing the mechanism.
- Verification must include unit/integration gates, a large model-free branch benchmark, and a real
  Pi RPC session where manual compaction omits an earlier random identifier, a recorded read-only
  tool call targets the projection, and the model recovers the exact identifier.

## Rejected alternatives

- **A second append-only memory database:** duplicates Pi's trajectory and introduces consistency
  and migration obligations.
- **Whole canonical session-file access:** leaks abandoned sibling branches into the model's search
  space.
- **Summaries, embeddings, vector search, or note heuristics:** pre-decide relevance and are outside
  the PRO-LONG append-all/programmatic-read mechanism.
- **Compaction interception or provider-history mutation:** couples the extension to context-window
  policy and risks changing model-visible history.
- **Copying the companion implementation:** its license was not established during design; this
  implementation is clean-room against the paper's mechanism and Pi's public APIs.
