# Pi Remote Control Extension PRD

## Problem Statement

A Pi coding session runs in a terminal on a laptop. There is no way to view or steer
that running session from another device. The author wants to start a session, run
`/remote`, and then watch the transcript and send prompts from a phone — while the
agent keeps executing on the laptop, where the repo and tools actually live.

This PRD covers the **backend and the Pi extension only**. The phone client is out of
scope here; the deliverable is everything the phone will eventually talk to.

## Solution

A **remote control** capability delivered as a Pi extension plus a local **daemon**.

- The laptop is the permanent **execution host**: it runs the Pi agent loop and all
  tools. The phone is a **remote client** — a view-and-steer surface that holds no
  working directory and runs no tools. The session never moves. (See `CONTEXT.md`.)
- A single long-lived **remote daemon** on the laptop owns one persistent iroh
  endpoint (stable node identity → pair once) and a **session registry**. It is a
  multiplexing relay between the phone and one or more Pi sessions; it does not run
  the agent loop.
- The `/remote` command in any Pi session registers that session with the daemon
  (spawning the daemon if absent), then bridges session events out and prompts in.
- The phone connects over iroh (QUIC, encrypted, public-key-addressed), authorizes via
  a one-time **pairing** (code + node-id **allowlist**, see ADR-0003), lists sessions,
  attaches to one, receives a full-transcript **backfill** plus live deltas, and sends
  prompts that are injected with `pi.sendUserMessage(..., { deliverAs: "steer" })`.

Architecture:

```
Phone ──iroh QUIC (ALPN pi/remote/1)── Remote daemon ──unix socket── Extension (one per Pi process)
                                              │
                                       session registry
                                       iroh endpoint (stable identity)
                                       paired-device allowlist
```

## User Stories

- **Pair once.** As the author, I run `/remote` in a fresh setup; the terminal shows a
  QR ticket and a short pairing code. My phone scans it, I enter the code, and the
  daemon records my phone's node id. I never enter a code again on that device.

- **Attach to a running session.** With the phone paired, I run `/remote` in a session.
  My phone shows it in a session list (name + working directory). I tap it and see the
  full conversation so far, then the assistant typing live.

- **Steer from the phone.** I type a prompt on the phone; it arrives as a steering
  message and the agent runs it on the laptop — including tools — unattended. I can
  hit stop on the phone to abort the current turn.

- **Multiple sessions, one pairing.** I have two Pi sessions open, each `/remote`d. My
  phone lists both and I can attach to either, one at a time.

- **Survive the TUI closing.** I close the Pi window that first ran `/remote`. Other
  `/remote`d sessions stay reachable because the daemon is a detached process that
  outlives any single Pi process.

- **Reconnect transparently.** My phone drops off Wi-Fi and comes back. It reconnects
  with no code (already paired) and re-attaches, getting a fresh backfill.

- **Control the daemon without a TUI.** I run `pi-remote status` / `pi-remote stop`
  from a shell to inspect or shut down the daemon when no Pi session is open.

## Implementation Decisions

- **Thin remote control, laptop is permanent execution host.** The session does not
  move; the phone only views and steers. Both the laptop TUI and the phone may be
  active at once; both just enqueue into Pi's existing steering/follow-up queue. No
  driver locking.

- **iroh via the official JS binding, in the daemon (`@number0/iroh`, pinned exact,
  `1.0.0`).** `iroh-js/index.d.ts` confirms full custom-protocol support: `Endpoint.bind`,
  `connect(addr, alpn)`, `Connection.openBi/acceptBi`, `BiStream`, `EndpointTicket`.
  No Rust, no FFI glue. Default public n0 relays; direct P2P when reachable.

- **Single persistent daemon (option B), extension-as-client (B1).** Each Pi process
  owns no iroh endpoint; multi-session and (future) phone-initiated sessions both
  require one always-there node. The interactive `pi` + `/remote` flow is the entry
  point; the daemon is a relay.

- **Authorization: node-id allowlist after coded pairing (ADR-0003).** iroh secures
  transport and verifies the peer's node id cryptographically but provides no
  authorization. Requesting pairing info arms a fresh five-minute pairing window;
  a successful code consumes the window, and a failed pairing attempt ends that
  connection. The allowlist (`~/.pi/agent/remote/`) authorizes thereafter. Remote
  prompts execute tools unattended by design.

- **Transport: one iroh connection per phone, single multiplexed stream, JSON
  envelope.** Every frame is `{ sessionId, type, payload }`; `sessionId: null` is the
  control channel. The daemon routes by `sessionId` to the right extension's unix
  socket. **Framing is LF-delimited JSONL, split on `\n` only** (matching Pi's own RPC
  convention). ALPN is the versioned constant `pi/remote/1`. Per-session QUIC streams
  are a later optimization that does not change the envelope.

- **Daemon lifecycle.** Lazy **detached** spawn from the extension
  (`spawn(…, { detached: true, stdio: "ignore" }).unref()`) so it outlives Pi.
  Single-instance via binding the fixed socket path
  (`~/.pi/agent/remote/daemon.sock`); a stale socket after a crash is detected
  (connect refused) and cleaned before bind. Stop is manual (`/remote stop` /
  `pi-remote stop`); no idle auto-shutdown.

- **Streaming + backfill.** Stream out from `message_start/update/end` and
  `tool_execution_start/update/end` (plus `turn_*`, `agent_end`) as live deltas.
  On attach, backfill the **full** transcript read from `ctx.sessionManager`. Both
  backfill and live frames use the **transcript projection**: `{ role, text, toolName,
  status, truncatedOutput }`, with large tool outputs truncated. Reconnect = full
  re-sync; no delta buffer. `session_shutdown` → `session_ended` control frame + drop
  from registry.

- **Prompt injection / abort.** Phone prompt → `pi.sendUserMessage(text,
  { deliverAs: "steer" })` (always triggers a turn). Phone stop → `ctx.abort()`.

- **Control-message set.** Control channel: `pair`, `list`, `attach`, `detach`,
  `session_ended`. Per-session: `event` (out), `prompt` / `abort` (in).

- **Runtime: Node + `tsx`.** The extension runs in Pi's Node process via jiti. The
  daemon and CLI are separate processes spawned under Node via `tsx`
  (`spawn(process.execPath, ["--import", "tsx", path], …)`). Bun rejected: N-API risk
  on the load-bearing native iroh binding, plus a second runtime for a tool whose other
  half is locked to Node.

- **Layout (single directory, no `..` imports).** `pi-extensions/remote/` with only
  `index.ts` auto-loaded as the extension; `daemon.ts` and `cli.ts` are spawned, never
  auto-discovered. Files: `index.ts`, `daemon.ts`, `cli.ts`, `protocol.ts`,
  `transport.ts`, `pairing.ts`, `registry.ts`, `ipc.ts`.

- **Dependencies in `dependencies` (not dev):** `@number0/iroh`, `tsx`,
  `qrcode-terminal` (hand-typing a ticket is infeasible). Pi packages do prod-only
  installs.

## Testing Decisions

- **Protocol unit tests.** JSONL framing (split on `\n` only, payloads containing
  newlines/Unicode separators survive), envelope encode/decode, control vs per-session
  routing by `sessionId`. Verify each test fails if framing is reverted to a generic
  line reader.
- **Pairing/authorization unit tests.** Pairing code check; allowlist persist/read;
  unpaired node id rejected before any session data flows; paired node id accepted with
  no code.
- **Transcript projection unit tests.** Large tool output is truncated; backfill and
  live frames project identically.
- **Daemon lifecycle test.** Stale-socket detection and cleanup before bind;
  single-instance (second daemon exits).
- **End-to-end (gated, like `FUSION_E2E`).** Two in-process iroh endpoints over real
  relays: pair, list, attach, observe a backfill + a streamed delta, send a prompt that
  reaches a fake session, abort. Mock only the Pi session boundary; exercise real iroh
  and real sockets.

## Out of Scope

- The phone client (UI, app). This PRD is backend + extension only.
- **Starting new sessions from the phone** (deferred). It needs the daemon to spawn and
  manage `pi` processes (pty, headless trust) and is where B1/B2 diverge. The daemon
  and protocol are designed so it layers on later without rework.
- Per-device revocation UI. Revocation in the POC is "delete the allowlist entry by
  hand."
- Self-hosted iroh relay; idle auto-shutdown of the daemon; per-session QUIC streams;
  driver locking / exclusive control.

## Further Notes

### Connect / pair / attach sequence

```
First device (pairing):
  /remote               → extension ensures daemon up, registers session
  daemon                → arms 5-minute window; prints QR(ticket) + fresh code
  phone                 → scans ticket, connects (ALPN pi/remote/1)
  phone  → daemon       → control: pair { code, nodeId }
  daemon                → verify code; close window; persist nodeId to allowlist; ack
Paired device (normal):
  phone  → daemon       → connect; daemon authorizes by nodeId (no code)
  phone  → daemon       → control: list
  daemon → phone        → control: registry [{ sessionId, name, cwd }]
  phone  → daemon       → control: attach { sessionId }
  daemon → extension    → (socket) attach { sessionId }
  extension → daemon    → backfill: projected transcript entries
  daemon → phone        → event frames (backfill, then live deltas)
  phone  → daemon       → prompt { sessionId, text }  → extension → sendUserMessage(steer)
  phone  → daemon       → abort  { sessionId }         → extension → ctx.abort()
```

### File seams

- `protocol.ts` — envelope type `{ sessionId: string | null, type, payload }`; JSONL
  encode/decode (split on `\n`); control + per-session message type unions. Pure, fully
  unit-tested.
- `transport.ts` — iroh `Endpoint` bind/connect/accept; `BiStream` read/write helpers
  layered over `protocol.ts`. The only module importing `@number0/iroh`.
- `pairing.ts` — pairing code gen/verify; allowlist read/write under
  `~/.pi/agent/remote/`; terminal QR via `qrcode-terminal`.
- `registry.ts` — in-daemon map of `sessionId → { name, cwd, socket }`; add on
  register, drop on `session_shutdown`.
- `ipc.ts` — unix-socket server (daemon) and client (extension), same JSONL envelope;
  `register` handshake frame.
- `daemon.ts` — wires transport + registry + ipc + pairing; owns the stable secret key.
- `cli.ts` — `pi-remote status | stop` against the socket.
- `index.ts` — registers `/remote`, `/remote status`, `/remote stop`; spawns daemon if
  down; connects over ipc; subscribes to events → projects → forwards; applies inbound
  `prompt`/`abort`.

### Build order (suggested)

1. `protocol.ts` + tests (framing, envelope, routing).
2. `transport.ts` over real iroh — a throwaway echo over `pi/remote/1` to prove the JS
   binding loads and two endpoints talk via relays.
3. `pairing.ts` + tests (code, allowlist).
4. `ipc.ts` + `registry.ts` — daemon accepts a register over the socket.
5. `daemon.ts` — assemble; pair + list end-to-end with a stub session.
6. `index.ts` — real `/remote`: register, stream projected events, inject prompts.
7. `cli.ts` — status/stop.
8. Gated e2e.
