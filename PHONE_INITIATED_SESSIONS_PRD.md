# Phone-Initiated Sessions PRD

## Problem Statement

Today a Pi session can only be remote-controlled if it already exists: someone opens a
terminal on the laptop, runs `pi`, and runs `/remote`. The remote control PRD explicitly
deferred the inverse — **starting a new session from the phone** — because it "needs the
daemon to spawn and manage `pi` processes (pty, headless trust)" (`REMOTE_CONTROL_PRD.md`,
Out of Scope). That deferral is the gap between "check on work I started" and the author's
actual destination: *the laptop is on, and I start new work from the couch.*

This PRD covers the **daemon and extension changes** that let a paired remote client create
and own a session on the execution host, in a folder it chooses. The iOS app that drives it
is `IOS_REMOTE_CLIENT_PRD.md` (Phase 2); the phone UI is out of scope here, exactly as the
original split put the client out of scope for the backend.

## Solution

Extend the **remote daemon** from a pure relay into a process **supervisor** for
remote-initiated sessions, behind two new control messages.

- The daemon gains the ability to **enumerate startable folders** and **spawn a `pi`
  process** in a chosen folder with the `remote` extension auto-loaded, headless (no TTY a
  human is watching), and to register the resulting session in the existing registry so it
  attaches like any other.
- A spawned session is **owned by the daemon**: the daemon holds the child process, tears it
  down on `session_shutdown` / `daemon_stop`, and reaps it if the controlling client never
  attaches.
- Everything downstream is **unchanged**: once registered, the new session lists, attaches,
  backfills, streams, takes prompts, and aborts through the exact path
  `IOS_REMOTE_CLIENT_PRD.md` already uses. Creating a session is the only new verb.

The session still **executes only on the laptop**. "Start from the phone" means "ask the
laptop to start it"; the phone remains a control surface (`CONTEXT.md`).

```
Phone → daemon : control list_roots          → [{ path, label }]
Phone → daemon : control new_session { root } → daemon spawns `pi --headless` (remote ext)
   pi (child)  → daemon : ipc register { sessionId, name, cwd }   (existing handshake)
daemon → phone : control new_session { sessionId }  → phone attaches as usual
```

## New protocol messages

Additive to `protocol.ts`; both are control-channel (`sessionId: null`):

- **`list_roots`** (in) → `roots` (out): the folders the daemon will start a session in,
  `[{ path, label }]`. Sourced from an operator-configured allowlist of root directories
  under `~/.pi/agent/remote/` (e.g. `session-roots.json`), **not** the whole filesystem.
- **`new_session`** (in) `{ root, name? }` → `new_session` (out)
  `{ sessionId }` on success, or a typed error payload (`unknown_root`, `spawn_failed`,
  `not_paired`). The daemon spawns the child, waits for its `register` handshake (bounded
  timeout), and returns the registered `sessionId`. The client then attaches normally.

Authorization for both reuses ADR-0003: only an allowlisted node id may call them. Creating
a session is a power surface — it runs `bash` and edits files unattended — so it is paired
devices only, by the same node-id check that already guards `prompt`.

## User Stories

- **Start in a known project.** From a paired phone I ask for startable folders; the daemon
  returns my configured roots (`~/code/app`, `~/code/notes`). I pick one and tap "New
  session"; seconds later it's in my session list, attached, agent ready for my first prompt.

- **Name it on creation.** I give the new session a name as I start it, so it's findable in
  the list instead of showing a raw id.

- **It outlives the request.** I start a session, lock my phone, and come back later. The
  session is still there (the daemon owns it); I re-attach and see what it did.

- **Clean teardown.** I end the session from the phone; the daemon stops the child `pi`
  process and drops it from the registry. Stopping the daemon stops every session it spawned.

- **No surprise sessions.** A node that isn't paired cannot create a session — `new_session`
  is rejected by node id before any process is spawned.

## Implementation Decisions

- **Daemon supervises; it still does not run the agent loop.** The spawned `pi` runs the loop
  in its own process exactly as a terminal session would; the daemon only manages the child's
  lifecycle and relays. This preserves the relay/registry architecture (`CONTEXT.md`) — the
  daemon gains a process table, not an agent.

- **Headless spawn with explicit trust.** The child is launched non-interactively in the
  chosen `cwd` with the `remote` extension loaded and whatever "headless trust" flag Pi
  requires to run tools without an interactive trust prompt. This is the crux the original
  PRD flagged; the exact spawn incantation (flags, pty-vs-pipe) is the first thing to nail
  down (Build order step 1). The child registers over the existing unix-socket `register`
  handshake (`ipc.ts`), so registration is unchanged — only who *starts* the child is new.

- **Folder allowlist, not free-form paths.** The phone never sends an arbitrary path that the
  daemon blindly spawns in. The daemon exposes an operator-curated set of roots and the phone
  picks among them (optionally a subdirectory under a root, validated to stay within it).
  This keeps "start a session" from becoming "run a process anywhere on my laptop as me".

- **Daemon owns child lifecycle.** Spawned with the child tracked (not detached): the daemon
  reaps it on `session_shutdown`, on `daemon_stop`, and on a startup-timeout if the child
  never registers. Sessions the user started in a terminal and `/remote`d are unaffected —
  the daemon only owns the ones it spawned.

- **Registry entries gain an origin.** Each registry entry notes whether it was
  `terminal`- or `daemon`-spawned, so teardown and any future UI can distinguish "I started
  this in a terminal" from "the daemon started this for me". Display name/cwd are as today.

- **Runtime unchanged.** Daemon and child stay Node + `tsx`, same layout
  (`pi-extensions/remote/`). New code is a `supervisor.ts` seam plus message handling in
  `daemon.ts`; no new transport and no new external dependency.

## Testing Decisions

- **Protocol (unit).** `list_roots` / `new_session` envelope encode/decode and routing as
  control messages; typed error payloads.
- **Roots allowlist (unit).** Configured roots are returned; a requested root outside the
  allowlist (including `..` escape attempts under a root) is rejected with `unknown_root`
  before any spawn.
- **Authorization (unit).** Unpaired node id is rejected for both messages before a process
  is spawned; paired node id accepted.
- **Supervisor lifecycle (integration, mock child).** Spawn → register handshake → registered
  sessionId returned; child that never registers is reaped after the timeout with
  `spawn_failed`; `session_shutdown` and `daemon_stop` terminate daemon-spawned children;
  terminal-origin sessions are left alone.
- **End-to-end (gated, real iroh + real spawn).** A paired client lists roots, creates a
  session in a temp dir, attaches, sends a prompt that the freshly spawned agent acts on, and
  tears it down. Extends `tests/remote.e2e.test.ts`.

## Out of Scope

- The phone UI for folder picking / session creation — `IOS_REMOTE_CLIENT_PRD.md` Phase 2.
- Arbitrary-path spawning, repo cloning, or provisioning new working directories on the
  laptop. Roots are pre-existing and operator-configured.
- Resource limits / concurrency caps on spawned sessions, and crash-restart supervision.
  POC reaps but does not restart.
- Choosing the model / Pi config per remote-started session beyond name + folder. Later.
- Multi-laptop fan-out (one phone starting sessions on several execution hosts).

## Further Notes

### Why this is a separate PRD

The original remote control PRD drew the line at "backend + extension, phone client out of
scope" and deferred phone-initiated sessions as the point where the single-daemon design
"layers on later without rework". This PRD is that layer: it stays entirely on the execution
host, adds two additive control messages, and reuses the registry/attach/relay path
untouched. The iOS client PRD consumes it without knowing how a session was born — a
daemon-spawned session and a terminal-spawned one are indistinguishable once registered.

### File seams

- `protocol.ts` — add `list_roots`, `roots`, `new_session` to the control message union;
  typed `new_session` error payloads.
- `supervisor.ts` (new) — roots allowlist read under `~/.pi/agent/remote/`; spawn a headless
  `pi` child in a validated cwd; track children; reap on shutdown/timeout.
- `registry.ts` — entries gain an `origin: "terminal" | "daemon"` tag.
- `daemon.ts` — handle the two new control messages: authorize (node id), validate root,
  call the supervisor, await `register`, respond with `sessionId` or typed error.
- `index.ts` — no change for terminal sessions; the child it spawns registers exactly as
  today.

### Build order (suggested)

1. **Headless spawn spike.** Prove a `pi` process can be launched non-interactively in a given
   cwd with the `remote` extension loaded and tools runnable without an interactive trust
   prompt, and that it registers over the existing socket. This is the load-bearing unknown.
2. `protocol.ts` messages + tests.
3. `supervisor.ts` roots allowlist + validated spawn + lifecycle, with a mock child.
4. `daemon.ts` wiring: authorize → validate → spawn → await register → respond.
5. Registry `origin` tag + teardown semantics.
6. Gated e2e: create → attach → prompt → teardown over real iroh.
7. iOS app Phase 2 (in `IOS_REMOTE_CLIENT_PRD.md`).
