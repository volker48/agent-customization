# Plan 001: Remove stale sessions from the remote registry when a Pi IPC socket closes

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f73bfca..HEAD -- pi-extensions/remote/ipc.ts tests/remote-ipc.test.ts tests/remote-daemon.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `f73bfca`, 2026-07-16

## Why this matters

The remote daemon keeps a `registry: Map<string, SessionRegistryEntry>` of Pi
sessions exposed for remote control. Entries are removed **only** when a Pi
extension sends an explicit `session_shutdown` frame. If a Pi extension process
crashes or its Unix-domain socket drops without sending that frame, the session
stays "registered" forever: `list` reports a phantom session to the phone,
`attach`/prompt writes are routed to a destroyed socket, and any
`waitForSessionEnd(sessionId)` promise never resolves. The registry also grows
without bound across the daemon's lifetime. This plan makes a socket `close`
event tear down exactly what an explicit `session_shutdown` would have.

## Current state

Files:
- `pi-extensions/remote/ipc.ts` — the IPC daemon server. Holds the registry,
  the per-socket accept handler, and the frame handler that processes
  `session_shutdown`.
- `tests/remote-ipc.test.ts` — existing Vitest suite for this module; use it as
  the structural pattern for the new test.

The socket `close` handler today only forgets the socket, never the registry
entries that point at it (`pi-extensions/remote/ipc.ts:134-147`):

```ts
function acceptDaemonSocket(socket: Socket, state: DaemonState, options: IpcDaemonOptions): void {
  state.sockets.add(socket);
  let buffered = "";

  socket.on("data", (chunk) => {
    const parsed = parseBufferedFrames(buffered + chunk.toString("utf8"));
    buffered = parsed.remaining;
    for (const envelope of parsed.envelopes) {
      void handleReceivedEnvelope(envelope, socket, state, options);
    }
  });
  socket.on("error", () => socket.destroy());
  socket.on("close", () => state.sockets.delete(socket));   // <-- only forgets the socket
}
```

The explicit-shutdown path that this plan must mirror lives in
`handleDaemonFrame` (`pi-extensions/remote/ipc.ts:225-234`):

```ts
if (envelope.type === "session_shutdown" && envelope.sessionId !== null) {
  registry.delete(envelope.sessionId);
  const frame: IpcEnvelope = {
    sessionId: null,
    type: "session_ended",
    payload: { sessionId: envelope.sessionId },
  };
  options.onControlFrame?.(frame);
  emitted.push(frame);
}
```

Two more facts the executor needs:

- Emitted frames are how attached remote clients learn a session ended: in
  `handleReceivedEnvelope` (`ipc.ts:190-196`), every emitted frame is delivered
  to `state.listeners`. The `close` cleanup must run the same
  `state.listeners.forEach((listener) => listener(frame))` so the phone is
  notified.
- `waitForSessionEnd` resolves via `resolveEndWaiters`, which today only fires
  on a `session_shutdown` envelope (`ipc.ts:298-306`). The `close` cleanup must
  also resolve any `endWaiters` for the affected session ids, or
  `waitForSessionEnd` promises leak.

`DaemonState` shape (`ipc.ts:62-68`): `{ registry, sessionWaiters, endWaiters,
sockets, listeners }`. `SessionRegistryEntry` is `{ name, cwd, socket }`
(`ipc.ts:28-32`) — the `socket` field is what lets you find entries belonging to
a closing socket.

## Commands you will need

| Purpose   | Command                                   | Expected on success |
|-----------|-------------------------------------------|---------------------|
| Install   | `pnpm install --frozen-lockfile`          | exit 0              |
| Typecheck | `pnpm typecheck`                          | exit 0, no errors   |
| Lint      | `pnpm lint`                               | exit 0              |
| Format    | `pnpm format:check`                       | exit 0              |
| This test | `pnpm test -- tests/remote-ipc.test.ts`   | all pass            |
| Full unit | `pnpm test:unit`                          | all pass            |

## Scope

**In scope** (the only files you should modify):
- `pi-extensions/remote/ipc.ts`
- `tests/remote-ipc.test.ts`

**Out of scope** (do NOT touch, even though they look related):
- `pi-extensions/remote/daemon.ts` — the transport/accept layer; the fix belongs
  in the IPC layer, not here.
- The `session_shutdown` handling in `handleDaemonFrame` — leave the explicit
  path exactly as is; you are adding a parallel path for abrupt close, not
  changing shutdown.
- The wire protocol / `protocol.ts` — no new frame types; reuse `session_ended`.

## Git workflow

- Branch: `advisor/001-remote-registry-cleanup`
- Commit style matches repo history (conventional commits), e.g.
  `fix(remote): drop registry entries when a Pi socket closes`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Extract the shutdown-emit logic into a reusable helper

In `pi-extensions/remote/ipc.ts`, add a small helper that, given a `sessionId`,
`state`, and `options`, deletes the registry entry, builds the `session_ended`
frame, calls `options.onControlFrame?.(frame)`, notifies `state.listeners`, and
resolves end-waiters for that session. Then call it from BOTH the existing
`session_shutdown` branch and the new `close` handler so the two paths cannot
drift.

Target shape:

```ts
function endSession(
  sessionId: string,
  state: DaemonState,
  options: IpcDaemonOptions,
): void {
  if (!state.registry.has(sessionId)) return;
  state.registry.delete(sessionId);
  const frame: IpcEnvelope = {
    sessionId: null,
    type: "session_ended",
    payload: { sessionId },
  };
  options.onControlFrame?.(frame);
  state.listeners.forEach((listener) => listener(frame));
  const waiters = state.endWaiters.get(sessionId) ?? [];
  waiters.forEach((waiter) => waiter.resolve());
  state.endWaiters.delete(sessionId);
}
```

Note: the existing `session_shutdown` branch currently pushes the frame into
`emitted` (which `handleReceivedEnvelope` then re-broadcasts to listeners). If
you route `session_shutdown` through `endSession`, that broadcast now happens
inside `endSession`, so do NOT also push the frame into `emitted` from the
branch — otherwise attached clients receive the `session_ended` frame twice.
Verify by reading `handleReceivedEnvelope` (`ipc.ts:190-196`) and confirming
`emitted` frames are forwarded to `state.listeners` there. Keep the
`session_shutdown` behavior observable-identical (one `session_ended` per
client, `onControlFrame` called once).

**Verify**: `pnpm typecheck` → exit 0, no errors.

### Step 2: Call the helper from the socket `close` handler

Change the `close` handler in `acceptDaemonSocket` to first find every registry
`sessionId` whose entry `.socket === socket`, then call `endSession` for each,
then delete the socket from `state.sockets`:

```ts
socket.on("close", () => {
  for (const [sessionId, entry] of state.registry) {
    if (entry.socket === socket) {
      endSession(sessionId, state, options);
    }
  }
  state.sockets.delete(socket);
});
```

Iterating a `Map` while calling `endSession` (which deletes from that same Map)
is safe in JS for the currently-visited and future keys, but to be unambiguous
collect the ids first: `const ids = [...state.registry].filter(([, e]) => e.socket === socket).map(([id]) => id);`
then loop `ids`. Prefer the collect-first form.

**Verify**: `pnpm typecheck` → exit 0; `pnpm lint` → exit 0.

### Step 3: Add a regression test

In `tests/remote-ipc.test.ts`, add a test that:
1. Starts the IPC daemon server (follow the existing setup in that file — it
   already creates a temp socket path and connects an extension client).
2. Registers a session (send a `register` envelope, or use the existing helper
   the suite uses to register).
3. Subscribes a listener and/or calls `waitForSessionEnd(sessionId)`.
4. Destroys the extension client socket **without** sending `session_shutdown`
   (e.g. `client.close()` or destroying the underlying socket — match how the
   suite tears down elsewhere).
5. Asserts: the registry no longer lists the session (`list` returns `[]` or
   `registry.has(sessionId)` is false via the facade), a `session_ended` frame
   reached the subscribed listener, and the `waitForSessionEnd` promise
   resolves.

Model the test structure on the nearest existing test in
`tests/remote-ipc.test.ts` (same imports, same daemon bootstrap). If the suite
has no existing way to observe the registry after close, assert via the
`session_ended` listener frame and the resolved `waitForSessionEnd` promise —
both are public behavior.

**Verify**: `pnpm test -- tests/remote-ipc.test.ts` → all pass, including your
new test. Confirm the new test FAILS if you temporarily revert Step 2 (comment
out the `endSession` loop), then re-apply Step 2.

## Test plan

- New test in `tests/remote-ipc.test.ts`: "abrupt socket close removes the
  session from the registry, emits `session_ended`, and resolves
  `waitForSessionEnd`". Cases: (a) registry no longer contains the session,
  (b) subscribed listener received a `session_ended` frame for that session id,
  (c) a pending `waitForSessionEnd` resolves.
- Keep/verify an existing `session_shutdown` test still passes unchanged (proves
  the refactor didn't double-emit or change the explicit path).
- Verification: `pnpm test:unit` → all pass.

## Done criteria

ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm lint` exits 0
- [ ] `pnpm format:check` exits 0
- [ ] `pnpm test:unit` exits 0; the new `remote-ipc` test exists and passes
- [ ] The new test fails when Step 2's cleanup is reverted (you verified this
      once, then restored the fix)
- [ ] `git status` shows only `pi-extensions/remote/ipc.ts` and
      `tests/remote-ipc.test.ts` modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The `close` handler or the `session_shutdown` branch in `ipc.ts` does not
  match the "Current state" excerpts (the code drifted since this plan).
- `SessionRegistryEntry` no longer carries a `socket` field (you can't identify
  a socket's entries without it — report and stop).
- Making `session_shutdown` route through the shared helper causes the existing
  shutdown test to observe two `session_ended` frames and you cannot resolve it
  without changing the wire protocol.
- The verification fails twice after a reasonable fix attempt.

## Maintenance notes

- If a future change lets one socket own multiple sessions (it already can — a
  socket registers one session today, but the loop handles many), the collect
  -first cleanup already covers it; keep it a loop, not a single-delete.
- Reviewer should confirm no double-emit of `session_ended` on the explicit
  shutdown path, and that `endWaiters` are resolved (not just deleted) so
  `waitForSessionEnd` callers don't hang.
- Deferred: this does not add a heartbeat/liveness probe; it only reacts to
  socket close. If sockets can half-open without a `close` event, a separate
  keepalive plan would be needed.
