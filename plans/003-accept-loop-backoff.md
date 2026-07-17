# Plan 003: Add backoff to the remote daemon accept loop so it can't busy-spin

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f73bfca..HEAD -- pi-extensions/remote/daemon.ts tests/remote-daemon.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `f73bfca`, 2026-07-16

## Why this matters

The remote daemon's connection accept loop calls `acceptConnection(endpoint)` in
a `while (!isClosed())` loop. Its `catch` only exits when `isClosed()` is true;
otherwise it immediately loops again with no delay. `acceptConnection` throws on
a null accept or an ALPN mismatch (`iroh-transport.ts`), so a transient endpoint
fault — or a peer that repeatedly dials with a mismatched ALPN — makes the loop
spin as fast as the microtask queue allows, pinning a CPU and starving timers/IO
without ever accepting real work. Adding a short backoff on repeated errors (reset
on any successful accept) removes the busy-spin while keeping the fast path
unchanged.

## Current state

File: `pi-extensions/remote/daemon.ts`. Test file:
`tests/remote-daemon.test.ts` (note: this suite is currently excluded from the
unit run — see Step 3 / STOP conditions).

The accept loop (`pi-extensions/remote/daemon.ts:109-127`):

```ts
async function acceptLoop(
  endpoint: RemoteEndpoint,
  ipc: IpcDaemonServer,
  allowlist: FileNodeAllowlist,
  pairingWindow: PairingWindow,
  streamingAttachCounts: Map<string, number>,
  isClosed: () => boolean,
): Promise<void> {
  while (!isClosed()) {
    try {
      const connection = await acceptConnection(endpoint);
      void handleConnection(connection, ipc, allowlist, pairingWindow, streamingAttachCounts).catch(
        () => undefined,
      );
    } catch {
      if (isClosed()) return;
      // <-- no delay here: immediately re-loops and can busy-spin
    }
  }
}
```

There is no existing `delay`/`sleep` helper imported here (grep confirms none in
`daemon.ts`). You will add a tiny inline one or a local helper.

## Commands you will need

| Purpose   | Command                                   | Expected on success |
|-----------|-------------------------------------------|---------------------|
| Install   | `pnpm install --frozen-lockfile`          | exit 0              |
| Typecheck | `pnpm typecheck`                          | exit 0, no errors   |
| Lint      | `pnpm lint`                               | exit 0              |
| Format    | `pnpm format:check`                       | exit 0              |
| This test | `pnpm test -- tests/remote-daemon.test.ts`| all pass            |
| Full unit | `pnpm test:unit`                          | all pass            |

## Scope

**In scope** (the only files you should modify):
- `pi-extensions/remote/daemon.ts`
- `tests/remote-daemon.test.ts` (only if you add a test — see Step 3; optional)

**Out of scope** (do NOT touch):
- `pi-extensions/remote/iroh-transport.ts` — where `acceptConnection` lives;
  the backoff belongs in the loop, not the transport.
- `handleConnection` and its downstream — unchanged.
- The `isClosed()` shutdown semantics — preserve exact early-return behavior.

## Git workflow

- Branch: `advisor/003-accept-loop-backoff`
- Commit style: conventional commits, e.g.
  `fix(remote): back off on repeated accept errors to avoid busy-spin`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add a cancellable delay and apply exponential backoff on errors

Introduce a backoff counter in the loop: reset to 0 on every successful
`acceptConnection`, and on a caught error (when not closed) `await` a delay that
grows from a small base (e.g. 50 ms) up to a cap (e.g. 1000 ms), then continue.
Keep the fast path (successful accept) allocation-free and delay-free.

Target shape:

```ts
const ACCEPT_BACKOFF_BASE_MS = 50;
const ACCEPT_BACKOFF_MAX_MS = 1000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acceptLoop(/* same params */): Promise<void> {
  let backoffMs = 0;
  while (!isClosed()) {
    try {
      const connection = await acceptConnection(endpoint);
      backoffMs = 0;
      void handleConnection(connection, ipc, allowlist, pairingWindow, streamingAttachCounts).catch(
        () => undefined,
      );
    } catch {
      if (isClosed()) return;
      backoffMs = backoffMs === 0 ? ACCEPT_BACKOFF_BASE_MS : Math.min(backoffMs * 2, ACCEPT_BACKOFF_MAX_MS);
      await delay(backoffMs);
    }
  }
}
```

If the file already unref's timers or has a shutdown-abort mechanism, prefer
using it so a pending `delay` doesn't keep the process alive during shutdown;
otherwise the `while (!isClosed())` guard re-checks immediately after the delay
resolves, which is acceptable (max one extra ≤1s wait on shutdown). If the delay
keeping the process alive during tests is a problem, `unref` the timer:
`const t = setTimeout(resolve, ms); t.unref?.();`.

**Verify**: `pnpm typecheck` → exit 0; `pnpm lint` → exit 0.

### Step 2: Confirm no behavior change on the happy path

Read the surrounding daemon startup to confirm `acceptLoop` is started with
`void acceptLoop(...)` or awaited in a way that your added `await delay` does not
change (the loop was already `async` and already `await`s `acceptConnection`, so
adding another `await` in the catch is structurally the same).

**Verify**: `pnpm test:unit` → all pass (the daemon-facing tests that DO run in
the unit suite still pass).

### Step 3: (Optional) add a targeted test if it's cheap

`tests/remote-daemon.test.ts` is excluded from `pnpm test:unit` (see
`vitest.unit.config.mjs`). Run it directly with
`pnpm test -- tests/remote-daemon.test.ts`. If the suite already injects a fake
`acceptConnection`/endpoint, add a test that makes `acceptConnection` reject N
times then resolve, and assert the loop eventually accepts (proving it didn't
die and didn't hang). If the suite has no seam to inject accept failures, do NOT
build new test infrastructure for this — skip the test, and note in the PR that
the backoff is covered by code review + typecheck only. (The change is a
localized, low-risk loop guard.)

**Verify**: `pnpm test -- tests/remote-daemon.test.ts` → all pass (whether or
not you added a case).

## Test plan

- Optional test in `tests/remote-daemon.test.ts` only if an injection seam
  already exists (see Step 3). Otherwise no new test; rely on typecheck + review.
- Verification: `pnpm test -- tests/remote-daemon.test.ts` and `pnpm test:unit`
  both pass.

## Done criteria

ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm lint` exits 0
- [ ] `pnpm format:check` exits 0
- [ ] `pnpm test -- tests/remote-daemon.test.ts` passes
- [ ] `pnpm test:unit` passes
- [ ] The accept loop resets its backoff to 0 after a successful accept
      (`grep -n "backoff" pi-extensions/remote/daemon.ts` shows the reset)
- [ ] `git status` shows only in-scope files modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The `acceptLoop` in `daemon.ts` does not match the "Current state" excerpt.
- The daemon has an existing abort/`AbortSignal` used for shutdown that the
  delay should honor — report it so the delay can be made abortable rather than
  guessing.
- `tests/remote-daemon.test.ts` fails for reasons unrelated to your change (it
  may be flaky — that's the subject of a separate plan; note it and continue if
  the failure predates your edit).
- A verification fails twice after a reasonable fix attempt.

## Maintenance notes

- Keep the backoff bounded (`ACCEPT_BACKOFF_MAX_MS`) — an unbounded backoff would
  make the daemon slow to recover after a long fault.
- Reviewer should confirm the backoff resets on success (otherwise a single early
  error would permanently slow accepts) and that shutdown latency is at most one
  `ACCEPT_BACKOFF_MAX_MS`.
