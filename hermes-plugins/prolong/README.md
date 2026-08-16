# Hermes PRO-LONG

A standalone Hermes Agent plugin that exposes old, persisted session evidence as a
private JSONL projection the model can inspect with ordinary file and search tools.
It adapts the programmatic-memory idea from
[PRO-LONG](https://arxiv.org/abs/2607.20064) and the repository's earlier
[Pi implementation](https://github.com/volker48/agent-customization/pull/123)
to Hermes's plugin and SQLite session contracts.

## What it does

For each active Hermes session, the plugin reconciles:

- every persisted message row in the current rotation-based compression lineage;
- both active rows and soft-archived `compacted=1` rows;
- persisted user, assistant, tool, reasoning, and tool-call fields returned by
  Hermes's raw `SessionDB.get_messages(..., include_inactive=True)` API.

The projection is written beneath Hermes's profile-scoped plugin data directory:

```text
$HERMES_HOME/plugin-data/<prolong-namespace>/sessions/<lineage-anchor-id>/trajectory.jsonl
```

The namespace is assigned by Hermes and may contain a hash. The plugin's static
system-prompt section gives the model the exact absolute path; callers should not
construct it themselves.

The directory key is normally the root of the active compression lineage, not its
current tip, so it remains identical when rotation-based compression creates a
linear child. If two live lineages diverge from the same root, anchor selection and
publication occur under the shared process lock: the first lineage keeps the root
anchor and each divergent lineage receives a distinct stable anchor. One branch can
therefore never overwrite or disclose another branch's projection. If an ancestor is
resumed while a descendant still advertises that root anchor, the resumed ancestor
receives a deterministic synthetic anchor instead of replacing the descendant's
projection.

The plugin synchronizes on session start, before model and tool calls, after the
model call, and at the end of each turn. It uses the canonical database as the
source of truth rather than hook payloads. Reset/finalization are terminal cleanup
boundaries: finalization waits for in-flight projection work, removes the derived
lineage, and retires that session ID from further publication until an explicit
session-start hook. Path resolution fails open for Hermes availability, but it never
advertises a real projection without a shared lease: if synchronization and fallback
lease reservation both fail, the prompt receives a deliberately nonexistent
`.unavailable/<session>/trajectory.jsonl` sentinel instead.

## Install

This repository is a multi-agent customization checkout, so install the plugin by
linking its directory into the active Hermes profile:

```bash
mkdir -p "${HERMES_HOME:-$HOME/.hermes}/plugins"
ln -s "$PWD/hermes-plugins/prolong" \
  "${HERMES_HOME:-$HOME/.hermes}/plugins/prolong"
hermes plugins doctor "$PWD/hermes-plugins/prolong" --ci
hermes plugins enable prolong --no-allow-tool-override
hermes plugins list --enabled --user --json
```

Restart long-lived Hermes gateway or desktop processes after enabling it. Enabling
a plugin executes its Python code inside Hermes; only install from a checkout you
trust.

## Use

No custom model tool is added. When earlier evidence matters, the system-prompt
section directs the model to inspect `trajectory.jsonl` using ordinary read-only
file, search, terminal, or Python tools. Every line is deterministic JSON. Records
have one of three forms:

- `record_type: "session_segment"` with persisted lineage metadata; or
- `record_type: "message"` with the raw decoded Hermes message row; or
- `record_type: "message_content_chunk"` with a bounded, overlapping search view
  of long message content.

Chunk records make evidence in the middle of a long one-line JSON record visible to
ordinary `search_files` and `read_file` calls. The raw `message` record remains the
lossless source; chunks intentionally duplicate long content and overlap by 200
characters so short search terms are not hidden at a boundary.

The file is a derived projection. Do not edit it. A legitimate trajectory change
appends an exact suffix when safe; rewinds, compaction, divergence, process restart,
or detected external modification trigger an atomic rebuild.

SQLite `data_version` is a conservative cache invalidator. Every canonical database
commit causes a complete lineage reread, so a mutation to an older message row cannot
be hidden by an unchanged tail.

## Privacy and security boundary

The projection duplicates persisted transcript data and may therefore contain
secrets already present in the session. On supported POSIX systems the plugin:

- creates owner-only `0700` directories;
- requires an existing canonical Hermes home to be `0700` for both absolute and
  relative paths, without chmodding unrelated lexical ancestors or the working directory;
- leaves the idle JSONL at `0400`;
- rejects symlink, hard-link, foreign-owner, non-regular, and wrong-mode logs;
- uses `O_NOFOLLOW`, descriptor identity checks, full-write loops, `fsync`, and
  same-directory atomic replacement;
- uses a validated POSIX advisory lock to serialize sibling Hermes processes;
- holds an OS-managed shared lease for every advertised lineage anchor, so one
  process cannot delete a projection still used by another;
- detects unexpected file identity, size, time, mode, and owner changes.

These controls reduce accidental disclosure and detect stale or substituted
artifacts. They are not a sandbox, cryptographic authentication, or protection
from root, the same Unix user, compromised Hermes/plugin code, backups, or tools
that the model is already authorized to run. Cleanup is best effort, not secure
erasure. Crashes and `SIGKILL` can leave a projection behind.

A startup sweep reconciles direct canonical-session deletion that bypassed lifecycle
hooks. If part of a lineage survives, PRO-LONG keeps the frozen path anchor and
rewrites it from the surviving canonical lineage. It removes the projection only
when no represented session remains and no sibling process holds its lease. Graceful
unload also discovers valid projections inherited from a crashed predecessor and
read-only adopts their descriptor-bound JSONL before removing them under the anchor's
exclusive lease. The last lease holder may refresh a stale local cleanup baseline
only when the inherited projection is a canonical, structurally valid append-only
extension. Adoption enforces typed session counters/timestamps, safe parent IDs, the
complete fixed persisted-message field set with field-specific types, and embedded
message/session identity before trusting inherited bytes. Cleanup validates
every residual artifact before touching the log and restores a captured log if the
directory changes before unlink. Malformed, divergent,
or changed artifacts are preserved and refused; process death releases shared leases
in the kernel.

Secure storage currently fails closed outside POSIX systems with `O_NOFOLLOW`.
A Windows release needs a separate SID/DACL and reparse-point implementation.

## Fidelity limits

Hermes v0.20.1 has no supported post-commit compression plugin hook and no durable
compression-generation or rewrite-reason field. Batch compression, pruning, and
micro-compaction can share the same in-place archival primitive. Consequently:

- the plugin can reconcile a content-complete view of currently persisted rows;
- rotation lineage is explicit through session parent links and `end_reason`;
- exact event-by-event classification of every in-place rewrite is impossible;
- convergence is eventual after an abrupt early-return or process crash;
- the plugin imports Hermes's internal `SessionDB`, which is a pinned compatibility
  dependency rather than a documented stable plugin facade; if a future runtime adds
  an unknown persisted message column, projection synchronization fails open with a
  warning instead of silently omitting that field.

See [ADR-0009](../../docs/adr/0009-hermes-prolong-programmatic-memory.md) for the
full contract and rejected alternatives.

## Verify

```bash
pnpm test:hermes-prolong
HERMES_SOURCE="$HOME/.hermes/hermes-agent" \
  "$HOME/.hermes/hermes-agent/venv/bin/python" \
  -m unittest tests.hermes_prolong.test_runtime_contract -v
pnpm verify:hermes-prolong
```

The deterministic verifier runs unit tests, real installed-Hermes lifecycle and
in-place-compaction contract tests, plugin doctor, and a 50,000-record benchmark.
The model-backed native `/compress` proof is intentionally separate because it
uses real inference and credentials.

```bash
pnpm verify:hermes-prolong:e2e
```

The E2E verifier requires Python `pexpect`. It writes a filtered `auth.json`
containing only OpenAI Codex credential records, never logs their contents, and fails
unless it verifies isolated-home removal after either success or failure. `--keep-home`
is the explicit debugging opt-out. It writes an exclusive private receipt under
`~/.hermes/cache/`. The receipt contains the random test nonce, runtime/plugin
identities, ordered tool/result hashes, and cleanup results—but no provider credential.
