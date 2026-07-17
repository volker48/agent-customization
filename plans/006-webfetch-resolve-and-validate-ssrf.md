# Plan 006: Close the webfetch SSRF DNS gap by validating resolved IPs, not just the hostname string

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f73bfca..HEAD -- pi-extensions/lib/webfetch-core.ts tests/webfetch.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `f73bfca`, 2026-07-16

## Why this matters

`webfetch` fetches attacker-influenceable URLs whose response bodies flow into
the LLM context. It has an SSRF guard, `getPrivateHostBlockReason(hostname)`,
that blocks `localhost`, cloud-metadata hosts, and private IP literals. But the
guard inspects only the **literal hostname string**; the actual `fetch()` then
does its own DNS resolution. So a public-looking hostname whose DNS record
resolves to an internal address — loopback, RFC1918, or `169.254.169.254`
(cloud metadata) — passes the string check and `fetch` connects to the internal
IP anyway. This plan closes the common case by resolving the host up front and
rejecting the request if **any** resolved address is private/metadata, applied
to the initial request and to every redirect hop.

**Scope boundary (read this):** a fully rebinding-proof fix requires pinning the
socket to the validated IP at connect time (a DNS-rebinding attacker can flip the
record between our resolve and `fetch`'s resolve). That needs an HTTP-stack
dispatcher and TLS-servername handling and likely a new dependency — it is
deliberately **out of scope** here and called out as a follow-up. This plan
raises the bar from "trivially bypassable via one DNS record" to "requires a
sub-second rebinding race," which is a large, testable improvement on its own.

## Current state

File: `pi-extensions/lib/webfetch-core.ts`. Test file: `tests/webfetch.test.ts`
(54 KB, the behavior guard for this module) plus
`tests/webfetch.baseline.test.ts` (snapshot baseline, env-gated).

The existing string-only guard (`webfetch-core.ts:518-541`):

```ts
function getPrivateHostBlockReason(hostname: string): string | undefined {
  if (shouldAllowPrivateHosts()) {
    return undefined;
  }
  const normalized = normalizeHostname(hostname);
  if (!normalized) return "Target host is empty";
  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return `Blocked private host: ${normalized}`;
  }
  if (METADATA_HOSTS.has(normalized)) return `Blocked metadata host: ${normalized}`;
  if (isPrivateIPv4(normalized) || isPrivateIPv6(normalized)) {
    return `Blocked private IP host: ${normalized}`;
  }
  return undefined;
}
```

Reusable building blocks already in the file:
- `isPrivateIPv4(addr: string): boolean` (`webfetch-core.ts:470-484`) and
  `isPrivateIPv6(addr: string): boolean` (`:486+`) — take an IP string, return
  whether it's private/loopback/link-local/ULA.
- `METADATA_HOSTS` (`:67`), `shouldAllowPrivateHosts()` (`:507-510`) reading the
  `WEBFETCH_ALLOW_PRIVATE_HOSTS` override env var, and `normalizeHostname`
  (`:512-516`).

The two request paths that must call the new check:

1. **Initial request** (`webfetch-core.ts:2544`):
   ```ts
   const blockReason = getPrivateHostBlockReason(targetUrl.hostname);
   if (blockReason) { /* returns a 403 tool result */ }
   ```
2. **Each redirect hop** in `fetchWithRedirects` (`webfetch-core.ts:1411-1420`):
   ```ts
   const nextUrl = new URL(locationHeader, currentUrl).toString();
   const blockReason = getPrivateHostBlockReason(new URL(nextUrl).hostname);
   if (blockReason) { /* cancels body, throws RedirectBlockedError */ }
   ```

Both currently pass only the hostname string. Note the override env var
`WEBFETCH_ALLOW_PRIVATE_HOSTS=1` must still bypass the check (trusted-workflow
escape hatch) — the new resolution step must respect `shouldAllowPrivateHosts()`
exactly as the string check does.

## Commands you will need

| Purpose        | Command                                   | Expected on success |
|----------------|-------------------------------------------|---------------------|
| Install        | `pnpm install --frozen-lockfile`          | exit 0              |
| Typecheck      | `pnpm typecheck`                          | exit 0, no errors   |
| Lint           | `pnpm lint`                               | exit 0              |
| Format         | `pnpm format:check`                       | exit 0              |
| This test      | `pnpm test -- tests/webfetch.test.ts`     | all pass            |
| Full unit      | `pnpm test:unit`                          | all pass            |

## Scope

**In scope** (the only files you should modify):
- `pi-extensions/lib/webfetch-core.ts`
- `tests/webfetch.test.ts`

**Out of scope** (do NOT touch, even though related):
- Connection/socket pinning to the resolved IP (the true rebinding fix) — needs
  a dispatcher + TLS servername handling and probably a new dependency. Do NOT
  add `undici` or rewrite the fetch stack. Leave a follow-up note (see
  Maintenance).
- The GitHub/GitLab API `fetch` calls (`webfetch-core.ts:866, 1075, 1155, 1215`)
  — these target fixed public API hosts (`api.github.com`, GitLab), not
  user-supplied hosts; adding DNS resolution there is unnecessary and risks
  breaking those integrations.
- `getPrivateHostBlockReason`'s existing string logic — keep it; you are ADDING a
  resolution step, not replacing the literal check (the literal check still
  usefully blocks IP-literal URLs without a DNS round-trip).
- `webfetch`'s token-efficient / site-optimized output behavior (ADR-0004).

## Git workflow

- Branch: `advisor/006-webfetch-ssrf-resolve`
- Commit style: conventional commits, e.g.
  `fix(webfetch): reject hosts that resolve to private/metadata IPs`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add an async resolve-and-validate helper with an injectable resolver

Add a new async function next to `getPrivateHostBlockReason`. It first runs the
existing synchronous string check (cheap, blocks IP literals and localhost), and
if that passes, resolves the hostname to all addresses and rejects if any is
private/metadata. Make the resolver injectable (default = real DNS) so tests can
supply a fake without mocking `node:dns` globally.

Add at the top of the file with the other imports:

```ts
import { lookup } from "node:dns/promises";
```

Then:

```ts
export type HostLookup = (hostname: string) => Promise<{ address: string }[]>;

const defaultHostLookup: HostLookup = (hostname) => lookup(hostname, { all: true });

async function getResolvedHostBlockReason(
  hostname: string,
  resolveHost: HostLookup = defaultHostLookup,
): Promise<string | undefined> {
  // 1. Existing literal-string check (also honors WEBFETCH_ALLOW_PRIVATE_HOSTS).
  const literalReason = getPrivateHostBlockReason(hostname);
  if (literalReason) return literalReason;

  // The override disables all private-host blocking, string AND resolved.
  if (shouldAllowPrivateHosts()) return undefined;

  const normalized = normalizeHostname(hostname);
  if (!normalized) return "Target host is empty";

  let addresses: { address: string }[];
  try {
    addresses = await resolveHost(normalized);
  } catch {
    return `Could not resolve host: ${normalized}`;
  }
  if (addresses.length === 0) {
    return `Could not resolve host: ${normalized}`;
  }
  for (const { address } of addresses) {
    if (isPrivateIPv4(address) || isPrivateIPv6(address)) {
      return `Blocked host resolving to private/internal address: ${normalized}`;
    }
  }
  return undefined;
}
```

Design notes for the executor:
- Reuse `isPrivateIPv4` / `isPrivateIPv6` verbatim — do not reimplement the
  ranges. They already cover loopback, RFC1918, link-local (`169.254.*` →
  metadata), CGNAT, and IPv6 ULA/link-local.
- Blocking on resolution failure (`Could not resolve host`) is the safe default:
  if we can't verify a host is public, we don't fetch it.
- Respect `shouldAllowPrivateHosts()` so the documented trusted-workflow escape
  hatch still works.

**Verify**: `pnpm typecheck` → exit 0.

### Step 2: Call the async check on the initial request

At `webfetch-core.ts:2544`, replace the synchronous
`getPrivateHostBlockReason(targetUrl.hostname)` with
`await getResolvedHostBlockReason(targetUrl.hostname)`. The surrounding function
is already `async` (it `await`s `fetch` later), so `await` is available. Keep the
exact same 403 tool-result construction and the override-hint message.

**Verify**: `pnpm typecheck` → exit 0.

### Step 3: Call the async check on every redirect hop

In `fetchWithRedirects` (`webfetch-core.ts:1411-1420`), replace
`getPrivateHostBlockReason(new URL(nextUrl).hostname)` with
`await getResolvedHostBlockReason(new URL(nextUrl).hostname)`. `fetchWithRedirects`
is already `async`. Keep the existing body-cancel + `RedirectBlockedError` throw
unchanged.

**Verify**: `pnpm typecheck` → exit 0; `pnpm lint` → exit 0.

### Step 4: Add regression tests

In `tests/webfetch.test.ts`, add unit tests that call `getResolvedHostBlockReason`
directly (export it if not already exported — the module already exports internals
used by tests; follow the existing export/import pattern in that test file) with a
**fake resolver**:

1. Host resolving to a public IP (`[{ address: "93.184.216.34" }]`) → returns
   `undefined` (allowed).
2. Host resolving to loopback (`[{ address: "127.0.0.1" }]`) → returns a block
   reason string.
3. Host resolving to cloud metadata (`[{ address: "169.254.169.254" }]`) →
   returns a block reason.
4. Host resolving to an RFC1918 address (`[{ address: "10.0.0.5" }]`) → blocked.
5. Host resolving to an IPv6 loopback (`[{ address: "::1" }]`) → blocked.
6. Resolver throws / returns `[]` → returns a "Could not resolve host" reason
   (fail-closed).
7. With `WEBFETCH_ALLOW_PRIVATE_HOSTS=1` set, a loopback-resolving host → returns
   `undefined` (escape hatch still works). Restore the env var after the test.
8. A literal private IP URL (e.g. hostname `"127.0.0.1"`) → still blocked by the
   synchronous first check WITHOUT calling the resolver (assert the fake resolver
   was not invoked).

Model the test file structure and import style on the existing tests in
`tests/webfetch.test.ts`. If integration-level tests there already stub
`globalThis.fetch`, you do not need to also exercise the two call sites
end-to-end — the direct-function tests plus the unchanged fetch-stubbed
integration tests are sufficient. If you can cheaply add one integration test
that a public host with a stubbed redirect to `http://169.254.169.254/` is
blocked, do so; otherwise rely on the redirect-path unit coverage.

**Verify**: `pnpm test -- tests/webfetch.test.ts` → all pass, including the new
cases. Temporarily make `getResolvedHostBlockReason` skip the resolved-address
loop and confirm cases 2–5 fail, then restore.

## Test plan

- New unit tests in `tests/webfetch.test.ts` covering the 8 cases above.
- Do NOT regenerate the webfetch baseline snapshots — this change should not
  alter output for public hosts. If `pnpm test -- tests/webfetch.test.ts`
  surfaces a baseline mismatch, that's a STOP condition (unexpected behavior
  change), not a "run with `WEBFETCH_BASELINE=1`" situation.
- Verification: `pnpm test:unit` → all pass.

## Done criteria

ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm lint` exits 0
- [ ] `pnpm format:check` exits 0
- [ ] `pnpm test:unit` exits 0; the 8 new webfetch SSRF tests exist and pass
- [ ] Both the initial-request (`:2544`) and redirect (`:1411`) call sites use
      `await getResolvedHostBlockReason(...)` (`grep -n "getResolvedHostBlockReason" pi-extensions/lib/webfetch-core.ts` shows the helper + 2 call sites)
- [ ] `WEBFETCH_ALLOW_PRIVATE_HOSTS=1` still bypasses the check (test 7 passes)
- [ ] `git status` shows only the two in-scope files changed
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The call sites at `:2544` or `:1411` don't match the "Current state" excerpts.
- The initial-request function turns out NOT to be async and `await` isn't
  available there (report — do not restructure control flow blindly).
- Adding the check breaks a large number of existing webfetch tests that fetch
  real public hosts in the default (non-e2e) suite — that would mean tests do
  real DNS and your resolver default is hitting the network; report it so the
  operator can decide whether those tests should inject a fake resolver.
- A webfetch baseline snapshot changes (unexpected output drift).
- A verification fails twice after a reasonable fix attempt.

## Maintenance notes

- **Deferred follow-up (the real rebinding fix)**: pin the connection to the
  validated IP so `fetch`'s own resolution can't differ from ours. In Node this
  means a custom dispatcher (undici `Agent` with a validating `connect`/`lookup`)
  and setting the TLS `servername` + `Host` header to the original hostname.
  That's a dependency + TLS decision for the maintainer — track it separately.
  Until then, document that webfetch is hardened against static internal-DNS
  records but not against a sub-second rebinding race.
- Reviewer should scrutinize: fail-closed on resolution error, the override env
  var still works, and that the synchronous literal check runs first (so IP-literal
  URLs are blocked without a DNS round-trip and without hitting the network).
- If IPv6-only or dual-stack hosts surface false positives, check `isPrivateIPv6`
  coverage — but do not loosen it without a test.
