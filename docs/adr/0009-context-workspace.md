# Context Workspace starts observe-only pending a compaction API

**Status:** accepted

## Context

Context Workspace needs to remove archived blocks from model context without deleting the
persisted session entries needed for exact recovery. The decision gate in issue #112 probes
`@earendil-works/pi-coding-agent@0.80.8`; prose-only API inspection is insufficient because
provider request ordering, usage accounting, and compaction operate at different layers.

The executable evidence is `tests/context-workspace-spike.test.ts`. It uses Pi's public SDK,
extension, faux-provider, session, compaction, reload, fork, and tree APIs against the pinned
package version.

## Decision

Ship the initial Context Workspace as an **observe-only MVP**. Pi 0.80.8 supports provider-bound
projection, but its public extension contract cannot preserve all native compaction behavior while
excluding archived blocks.

Observe-only means the extension may identify blocks, estimate pressure, render a dashboard, and
report what could be archived. It must not remove or replace persisted messages in provider context,
record an archive state that claims those messages are hidden, or override native compaction.

Full archive/restore mutation is blocked on an upstream Pi API described below. No dependency change
is made by this spike; a future Pi version that exposes the missing contract will be required before
enabling mutation.

## Proven contracts

### Provider projection and usage

`context` runs before the provider request. Removing an archived roughly 30k-token completed tool
exchange removes it from the actual faux-provider payload.

Inside the `context` callback, `ctx.getContextUsage()` still reports the incoming persisted-context
estimate; it is not recomputed from the handler's return value. The probe observes the archived
roughly 30k tokens at that point. Context Workspace must not treat this callback-time value as a
measurement of its just-produced projection.

After a successful provider response with non-zero usage, `getContextUsage()` derives its token
count from that provider's usage, so it reflects the projected payload. The matching probe shows
that archived token pressure alone does not trigger automatic compaction, while sufficient visible
pressure does. Error and zero-usage paths may fall back to estimating the unprojected agent state;
the spike does not establish projected accounting for those paths.

Immediately after compaction, token usage can be unknown until the next provider response. Callers
must preserve Pi's nullable usage semantics rather than inventing a replacement estimate.

### Stable session identity

`ReadonlySessionManager.buildContextEntries()` and the public
`sessionEntryToContextMessages()` helper associate an untouched Pi context list with stable session
entry IDs. Ordered occurrences distinguish duplicate persisted messages in that constrained case.

The `context` event itself carries bare `AgentMessage[]`, however. If an earlier extension inserts
an indistinguishable message, occurrence positions shift: the probe retains the archived duplicate
and removes the active one. There is no public identity field with which to fail open. A future
mutating adapter still must:

- fingerprint canonical role/content rather than display metadata;
- disambiguate duplicate content by ordered occurrence;
- preserve unmatched messages from other extensions (fail open);
- remove completed tool calls and their tool results atomically as one workspace block.

Content equality alone is not an identity mechanism, so Pi 0.80.8 does not provide the stable
provider-message identity required for safe mutation in a multi-extension pipeline.

### Compaction blocks safe mutation

Pi's native compaction preparation is built from the persisted session branch, not from the
`context` event's projected messages. The executable probes show archived payload in native manual
and threshold preparations. A deterministic faux summarizer echoes that payload into an unhooked
native compaction summary, proving that unchanged preparation can reintroduce archived content.

A `session_before_compact` handler can project `messagesToSummarize` and
`turnPrefixMessages`, resolve model authentication, and call Pi's exported `compact()`. That is not
enough. `CompactionPreparation.fileOps` has already been derived from the unprojected session. Pi's
`compact()` appends those operations after model summarization, so an archived file path is
reintroduced in both manual and threshold summaries even when the raw archived payload is absent
from the summarizer request.

Pi's package root exports `compact()` and the `FileOperations` type, but not the canonical
`createFileOps()` or `extractFileOpsFromMessage()` helpers used internally. Recomputing `fileOps`
would duplicate private behavior for tool parsing, previous-compaction carry-forward, and future
changes. Deep-importing an unexported module is equally unstable. Both approaches are rejected.

### Exact recovery

Compaction appends a compaction entry; it does not erase earlier session entries. `getEntry()`
continues to return the original serialized entry byte-for-byte after manual and threshold
compaction, session reload, fork, and tree navigation. Future recovery must reference original
session entry IDs instead of storing a lossy copy of message content.

## Required upstream Pi contract

Before Context Workspace can mutate visibility, a supported Pi release must expose stable session
entry identity on provider-bound context messages and one of these public compaction contracts:

1. a post-`context` compaction hook whose preparation, token accounting, and derived file-operation
   state all use the projected provider messages; or
2. a public preparation API that accepts projected messages and canonically rebuilds every derived
   compaction field, including previous-compaction file-operation carry-forward.

Exporting only low-level file-operation helpers would be weaker because extensions could still drift
from native preparation ordering and future derived fields. A post-projection compaction hook is the
preferred API.

The spike remains pinned to 0.80.8 and acts as an upgrade gate. When a candidate Pi version provides
this contract, change the dependency in a dedicated follow-up and invert the compaction leak probes
before enabling archive behavior.

## Shadow compactor prohibition

Context Workspace must not duplicate Pi's cut-point selection, summary prompt, iterative-summary,
split-turn, file-operation, authentication, model, or provider-stream behavior. A hand-maintained
"equivalent" compactor would drift and is explicitly prohibited.

It also must not cancel native compaction or return a partial hook result that filters message
arrays while retaining unprojected derived metadata. If the required public contract is
unavailable, the correct behavior is observe-only.

## Consequences

- The observe-only dashboard slice can proceed against Pi 0.80.8.
- Archive, restore, and provider-context mutation remain disabled until the upstream contract lands.
- Native compaction remains untouched and authoritative in observe-only mode.
- Stable mapping, pressure reporting, and exact recovery findings can be reused by later slices.
- Pi upgrades must run this architecture spike before changing the pinned dependency.
- Final blockization policy, commands, and user-facing status remain out of scope for this ADR.
