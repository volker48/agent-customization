# Plan 002: Harden remote pairing — atomic allowlist writes and a pairing-attempt cap

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f73bfca..HEAD -- pi-extensions/remote/authorization.ts tests/remote-authorization.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `f73bfca`, 2026-07-16

## Why this matters

The remote-control allowlist file (`allowed-node-ids.json` under
`~/.pi/agent/remote/`) is the security boundary that decides which paired
devices may drive local Pi sessions (ADR-0003: "Authorization after pairing is
by node id — cryptographic and unforgeable"). Two implementation gaps weaken the
pairing that populates it:

1. **Non-atomic, racy allowlist writes.** `FileNodeAllowlist.add` does a plain
   read-modify-`writeFile` with no temp-file+rename and no serialization. Two
   pairings completing near-simultaneously each read the old list and overwrite
   the file; the last writer silently drops the other's just-added node id (a
   paired device is de-authorized). A concurrent reader can also observe a
   partially written file and throw.
2. **No pairing-attempt cap.** The pairing code is a 6-digit secret (10^6 space)
   valid for a 5-minute window. `PairingWindow.verify` leaves the window armed
   after a wrong guess, and each new connection yields one fresh guess with no
   global counter, lockout, or backoff. An attacker who has the endpoint ticket
   can brute-force the code by reconnecting during the window; one success
   permanently allowlists their node id.

Both are fixes to the pairing *implementation*, not the ADR-0003 scheme itself.

## Current state

File: `pi-extensions/remote/authorization.ts` — owns `FileNodeAllowlist`,
`PairingWindow`, and `authorizeRemoteEnvelope`. Test file:
`tests/remote-authorization.test.ts`.

The non-atomic write (`authorization.ts:110-118`):

```ts
async add(nodeId: string): Promise<void> {
  const nodeIds = new Set(await this.#read());
  nodeIds.add(nodeId);
  await mkdir(dirname(this.#filePath), { recursive: true });
  await writeFile(this.#filePath, `${JSON.stringify([...nodeIds].sort(), null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(this.#filePath, 0o600);
}
```

The `PairingWindow` with no failure counter (`authorization.ts:60-97`):

```ts
export class PairingWindow {
  #code: string | undefined;
  #expiresAt = 0;
  // ... arm() sets #code and #expiresAt ...
  verify(receivedCode: string): boolean {
    const code = this.currentCode();
    if (!code || !verifyPairingCode(code, receivedCode)) {
      return false;   // <-- window stays armed; no attempt is counted
    }
    this.close();
    return true;
  }
  currentCode(): string | undefined { /* returns #code if not expired */ }
  close(): void { this.#code = undefined; this.#expiresAt = 0; }
}
```

`verifyPairingCode` already uses `timingSafeEqual` — do not change the
comparison. `authorizeRemoteEnvelope` (`authorization.ts:162-179`) calls
`pairingWindow.verify(...)` then `allowlist.add(...)` on success. Node ids are
imports at the top: `import { chmod, mkdir, readFile, writeFile } from
"node:fs/promises";` and `import { dirname, join } from "node:path";`. There is
no `rename` import yet.

Convention: this repo already does atomic JSON writes via temp-file+`rename`
elsewhere — see `plugins/pi/scripts/lib/jobs.mjs` (`atomicWriteJson`, writes
`${path}.<pid>.<ts>.tmp` then `rename`). Match that approach here (add
randomness to the temp name per STOP-safe uniqueness).

## Commands you will need

| Purpose   | Command                                            | Expected on success |
|-----------|----------------------------------------------------|---------------------|
| Install   | `pnpm install --frozen-lockfile`                   | exit 0              |
| Typecheck | `pnpm typecheck`                                   | exit 0, no errors   |
| Lint      | `pnpm lint`                                        | exit 0              |
| Format    | `pnpm format:check`                                | exit 0              |
| This test | `pnpm test -- tests/remote-authorization.test.ts`  | all pass            |
| Full unit | `pnpm test:unit`                                   | all pass            |

## Scope

**In scope** (the only files you should modify):
- `pi-extensions/remote/authorization.ts`
- `tests/remote-authorization.test.ts`

**Out of scope** (do NOT touch):
- `verifyPairingCode` / `createPairingCode` — the CSPRNG generation and
  `timingSafeEqual` comparison are correct; do not weaken them.
- `pi-extensions/remote/daemon.ts` — the accept loop that calls `verify`. The
  cap lives inside `PairingWindow` so no daemon change is required.
- The allowlist file format (a sorted JSON string array) and its `0o600` mode —
  preserve both exactly.

## Git workflow

- Branch: `advisor/002-harden-pairing-allowlist`
- Commit style: conventional commits, e.g.
  `fix(remote): write allowlist atomically and cap pairing attempts`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Make `FileNodeAllowlist.add` write atomically

Add `rename` to the `node:fs/promises` import and `randomUUID` from
`node:crypto`. Rewrite `add` to write to a unique temp file in the same
directory, then `rename` it over the target (rename is atomic within a
filesystem). Because `writeFile(..., { mode: 0o600 })` sets the temp file's
mode, and `rename` preserves it, keep a `chmod` on the final path only if the
target pre-existed with looser perms is a concern — the existing code chmods
after write; keep an equivalent `chmod` on the final path after rename for
parity.

Target shape:

```ts
async add(nodeId: string): Promise<void> {
  const nodeIds = new Set(await this.#read());
  nodeIds.add(nodeId);
  await mkdir(dirname(this.#filePath), { recursive: true });
  const tmpPath = `${this.#filePath}.${randomUUID()}.tmp`;
  const contents = `${JSON.stringify([...nodeIds].sort(), null, 2)}\n`;
  await writeFile(tmpPath, contents, { mode: 0o600 });
  await rename(tmpPath, this.#filePath);
  await chmod(this.#filePath, 0o600);
}
```

**Verify**: `pnpm typecheck` → exit 0.

### Step 2: Serialize concurrent `add` calls

The read-modify-write in `add` can still interleave between two in-process
callers (read A, read B, write A, write B → B clobbers A). Serialize `add`
through a private promise chain so each add's read-modify-write runs to
completion before the next begins.

Target shape (field + wrapper):

```ts
export class FileNodeAllowlist implements NodeAllowlist {
  readonly #filePath: string;
  #writeChain: Promise<void> = Promise.resolve();
  // ...
  add(nodeId: string): Promise<void> {
    const next = this.#writeChain.then(() => this.#addLocked(nodeId));
    // keep the chain alive even if a write rejects, so one failure
    // doesn't permanently break subsequent adds:
    this.#writeChain = next.catch(() => undefined);
    return next;
  }

  async #addLocked(nodeId: string): Promise<void> {
    // the body from Step 1
  }
}
```

**Verify**: `pnpm typecheck` → exit 0; `pnpm lint` → exit 0.

### Step 3: Add a pairing-attempt cap to `PairingWindow`

Add a private failure counter and a small threshold constant. On a wrong (but
non-expired) guess, increment the counter; when it reaches the threshold, close
the window (disarm it) so further guesses fail until the user re-arms pairing.
Reset the counter in `arm()` and on a successful `verify`.

Target shape:

```ts
const MAX_PAIRING_ATTEMPTS = 5;

export class PairingWindow {
  #code: string | undefined;
  #expiresAt = 0;
  #failures = 0;

  arm(): string {
    this.#code = this.createCode();
    this.#expiresAt = this.now() + this.ttlMs;
    this.#failures = 0;
    return this.#code;
  }

  verify(receivedCode: string): boolean {
    const code = this.currentCode();
    if (!code || !verifyPairingCode(code, receivedCode)) {
      if (code) {
        this.#failures += 1;
        if (this.#failures >= MAX_PAIRING_ATTEMPTS) {
          this.close();
        }
      }
      return false;
    }
    this.close();
    return true;
  }

  close(): void {
    this.#code = undefined;
    this.#expiresAt = 0;
    this.#failures = 0;
  }
  // currentCode() unchanged
}
```

Note the guard `if (code)`: only count a failure when the window was actually
armed and unexpired (a guess against an already-closed/expired window shouldn't
count — there's nothing to protect).

**Verify**: `pnpm typecheck` → exit 0.

### Step 4: Add regression tests

In `tests/remote-authorization.test.ts` (follow its existing test style and how
it constructs `PairingWindow` / `FileNodeAllowlist` — the suite already
exercises these with injected `now`/`createCode` and a temp dir):

1. **Attempt cap**: arm a window with a known code (inject `createCode` to
   return a fixed value, as the suite already does), call `verify("000-000")`
   (wrong) `MAX_PAIRING_ATTEMPTS` times, assert every call returns `false`, then
   assert that `verify(<the correct code>)` now also returns `false` because the
   window disarmed. Also assert a fresh `arm()` resets the counter so the
   correct code works again.
2. **Atomic add preserves concurrent additions**: create a `FileNodeAllowlist`
   over a temp dir, fire `Promise.all([add("nodeA"), add("nodeB")])`, then assert
   `has("nodeA")` and `has("nodeB")` are both true and the file parses to a
   2-element array. (Before Step 2 this can flake/drop one; after, it's stable.)

**Verify**: `pnpm test -- tests/remote-authorization.test.ts` → all pass. Confirm
the attempt-cap test fails if you temporarily revert Step 3, then restore it.

## Test plan

- New tests in `tests/remote-authorization.test.ts`: the two cases above.
- Keep existing pairing tests passing unchanged (correct code still pairs;
  expired window still rejects).
- Verification: `pnpm test:unit` → all pass.

## Done criteria

ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm lint` exits 0
- [ ] `pnpm format:check` exits 0
- [ ] `pnpm test:unit` exits 0; both new tests exist and pass
- [ ] The attempt-cap test fails when Step 3 is reverted (verified once, then
      restored)
- [ ] `add` writes via a temp file + `rename` (`grep -n "rename" pi-extensions/remote/authorization.ts` returns a match)
- [ ] `git status` shows only the two in-scope files modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `PairingWindow` or `FileNodeAllowlist.add` does not match the "Current state"
  excerpts.
- The `MAX_PAIRING_ATTEMPTS` threshold interacts with an existing daemon test
  that performs more than 5 pairing attempts against one armed window and now
  fails — report it; the daemon test may encode the old unlimited behavior and
  the operator should decide the threshold.
- Changing `add` to temp+rename breaks the file-mode assertion in an existing
  test (report the exact assertion; do not loosen the mode).
- A verification fails twice after a reasonable fix attempt.

## Maintenance notes

- If pairing is ever made re-armable automatically (auto re-arm on window
  expiry), revisit the counter reset so a cap can't be trivially bypassed by
  forcing a re-arm.
- Reviewer should confirm `#writeChain` swallows rejections (`.catch`) so one
  failed write doesn't wedge all subsequent `add` calls, and that the temp file
  is never left behind on the happy path (rename consumes it).
- Deferred (not in this plan): widening the pairing code length, and
  logging/alerting on repeated failures. Both are reasonable follow-ups but out
  of scope here.
