# iOS Remote Client PRD

## Problem Statement

The remote control backend (`REMOTE_CONTROL_PRD.md`) exposes a running Pi session over
iroh: a paired device can list sessions, attach to one, receive a full transcript
backfill plus live deltas, send steering prompts, and abort a turn. But there is no
device that speaks it. The author starts a Pi session on the laptop, runs `/remote`, and
then has nothing to attach with.

This PRD covers the **iOS app only** — a native SwiftUI chatbot client that pairs once
and becomes a view-and-steer surface for sessions running on the laptop. The laptop
remains the sole execution host; the phone holds no working directory and runs no tools
(see `CONTEXT.md`). Creating sessions *from the phone* is a separate capability
(`PHONE_INITIATED_SESSIONS_PRD.md`) that this app consumes in its final phase.

## Solution

A native **iOS app** that is an iroh client for ALPN `pi/remote/1`.

- The app links iroh via **iroh-ffi's Swift bindings** (`IrohLib`, mirroring the iroh
  `1.0` API the daemon already pins as `@number0/iroh@1.0.0`). It dials the daemon's
  published **ticket** directly over QUIC — same transport the daemon's own tests use
  (`EndpointTicket.fromString(ticket).endpointAddr()` → `connect` → `openBi`).
- It speaks the existing wire protocol verbatim: **LF-delimited JSON envelopes**
  `{ sessionId, type, payload }`, control channel on `sessionId: null`, per-session
  channel keyed by `sessionId` (`protocol.ts`).
- It pairs once (scan ticket QR, enter the 6-digit code), then is authorized by its iroh
  node id forever (ADR-0003). It lists sessions, attaches to one, renders the projected
  transcript as a chat UI, sends prompts as steering messages, and can abort.

Architecture:

```
┌─────────────── iPhone ───────────────┐         ┌────────── Laptop (execution host) ──────────┐
│  SwiftUI chat UI                      │  iroh   │  Remote daemon (stable node id)             │
│  RemoteClient (envelopes, streams) ───┼── QUIC ─┼─► session registry ─unix socket─ Extension │
│  iroh-ffi (IrohLib) Endpoint          │ pi/     │                                  (per Pi)   │
│  Keychain: node secret key, ticket    │ remote/1│  allowlist (node ids)                       │
└───────────────────────────────────────┘         └─────────────────────────────────────────────┘
```

The app changes **nothing** about how the session executes. Both the laptop TUI and the
phone enqueue into Pi's existing steering queue; no driver locking.

## User Stories

- **Pair once (Phase 0).** I run `/remote` on the laptop. The laptop shows a QR ticket and
  a short code. On my phone I tap "Pair", scan the QR, and type the code. The app stores
  its node identity and the daemon records it. I never pair that phone again.

- **Watch a running session (Phase 0).** With the phone paired, I open the app. It lists
  the laptop's `/remote`d sessions by name and working directory. I tap one and see the
  whole conversation so far, then the assistant streaming live as it works.

- **Answer the agent (Phase 0).** The agent asks a question or finishes a step. I type a
  reply on my phone; it arrives as a steering message and the agent continues on the
  laptop, tools and all. If it goes the wrong way I tap Stop to abort the turn.

- **Reconnect transparently (Phase 1).** My phone drops Wi-Fi and comes back, or I background
  the app and return. It reconnects with no code (already paired) and re-attaches, pulling
  a fresh full backfill — no missed-event replay needed.

- **Many sessions, one phone (Phase 1).** I have two sessions `/remote`d. The app lists both;
  I switch between them, each its own chat thread, one attached at a time.

- **Start work from the phone (Phase 2).** My laptop is on but idle. From the app I pick a
  folder on the laptop and start a fresh session there, then drive it — as if I'd opened a
  terminal and run `pi`, but from the couch. (Depends on `PHONE_INITIATED_SESSIONS_PRD.md`.)

## Phasing

- **Phase 0 — single-session POC (the deliverable to aim for first).** Pairing, list,
  attach to one laptop-started session, render backfill + live deltas, send prompt, abort.
  One session at a time, foreground-only, manual reconnect acceptable. This is the
  "start on the laptop, check progress and answer questions on the phone" flow end to end.
- **Phase 1 — durable multi-session client.** Session list with live registry, switch
  sessions, automatic reconnect/re-attach on network or lifecycle changes, connection-state
  UI, transcript truncation affordances ("output truncated"), basic local persistence of
  paired identity.
- **Phase 2 — start sessions from the phone.** Folder picker + "new session" wired to the
  new control messages from `PHONE_INITIATED_SESSIONS_PRD.md`. The app's "final destination":
  laptop on, start from phone or laptop, see them all.

## Implementation Decisions

- **Native iroh via iroh-ffi Swift (`IrohLib`), not a bridge.** Keeps the daemon's
  "pair once, P2P, no server" design intact and works off-LAN through n0 relays. The
  daemon is unchanged. Risk: the daemon is only ever the *accepter* today; the phone is the
  *connector*, so an early spike must confirm the Swift surface for `Endpoint.connect(addr,
  alpn)`, `Connection.openBi`, `BiStream` read/write, and `EndpointTicket` parsing before
  UI work. The JS binding confirms all of these exist in the `1.0` API; the spike de-risks
  the Swift projection of them. (See Build order step 1.)

- **The app owns a stable iroh secret key, stored in the iOS Keychain.** The node id is the
  app's identity in the allowlist; losing it means re-pairing. Generated on first launch,
  never leaves the device.

- **Connection/stream lifecycle mirrors the daemon's read-to-end model.** The daemon accepts
  one bi-stream per connection and `readToEnd`s the request side before responding
  (`daemon.ts` `handleConnection`, `iroh-transport.ts` `receiveEnvelopes`). So the client
  has exactly two stream shapes:
  - **Request/response stream** (pair, list, attach without streaming, prompt, abort, detach):
    open stream, write envelope(s), **finish the send side**, read the response(s) to end,
    close. `prompt`/`abort` get no response and the daemon closes the stream.
  - **Streaming attach stream** (`attach { sessionId, stream: true }`): write the attach,
    finish the send side; the daemon replies with the backfill and then holds the stream
    open, pushing live `event` frames until `session_shutdown` or disconnect. This is the
    app's live transcript feed. Prompts/aborts go on **separate** request streams while it
    stays open.

- **The transcript projection is the render model, as-is.** Each frame is
  `{ role, text, toolName, status, truncatedOutput }` (`transcript-projection.ts`). The UI
  maps `role` (`user` / `assistant` / `toolResult` / `system`) to bubble styles, shows
  `toolName` + `status` for tool activity, and a subtle "output truncated" marker when
  `truncatedOutput` is true. The app does **not** ask for richer data in Phase 0/1; if a
  richer UI is wanted later it is a protocol change tracked separately, not an app hack.

- **Message coalescing for streaming.** `message_start` / `message_update` / `message_end`
  arrive as successive projections of the same assistant message (`status` =
  `started`/`streaming`/`completed`). The UI coalesces them into one growing bubble keyed by
  arrival within the current turn, rather than appending a new bubble per delta. Backfill
  entries arrive as `completed` and append directly.

- **Steering, not chatting.** A phone prompt is `prompt { text }` → the daemon → the
  extension's `pi.sendUserMessage(text, { deliverAs: "steer" })`. It always triggers a turn.
  Stop is `abort {}` → `ctx.abort()`. The app presents these as "send" and "stop"; there is
  no separate "queue vs steer" control in Phase 0.

- **SwiftUI, async/await over the FFI.** A single `RemoteClient` actor wraps the iroh
  endpoint and serializes stream access; view models observe an `@Observable` session store.
  No third-party networking stack — the only native dependency is `IrohLib`.

## Required precursor on the execution host

Pairing display is **not wired today**. `createPairingCode` and `renderPairingTicket` exist
and are unit-tested, but `daemon-entry.ts` uses a hardcoded `PI_REMOTE_PAIRING_CODE ??
"000-000"` and neither the daemon nor `/remote` surfaces the ticket QR or a fresh code to the
user. Before Phase 0 can pair a real phone, the extension/daemon must, on first-ever pairing:

- generate a real pairing code (`createPairingCode`) instead of the env default, and
- render the daemon's `ticket` + code to the laptop user (`renderPairingTicket`), e.g. via a
  `/remote pair` subcommand that prints the QR in the TUI.

This is a small, self-contained change on the existing extension; it is the one backend edit
this PRD depends on. (Everything else in Phase 0 already exists.)

## Testing Decisions

- **Protocol conformance (unit).** Encode/decode the JSON envelope and LF framing in Swift;
  round-trip against fixtures generated by the TS `protocol.ts` so both sides agree byte for
  byte (payloads with embedded newlines/Unicode separators survive; split on `\n` only).
- **Stream lifecycle (unit/integration).** Request/response streams finish the send side and
  read to end; the streaming-attach stream stays open and surfaces live frames; a prompt sent
  on a second stream while attached does not disturb the feed.
- **Projection rendering (unit).** Backfill `completed` entries and live `started`/
  `streaming`/`completed` deltas coalesce into the expected bubbles; `truncatedOutput`
  renders the marker; `toolResult` with `status` renders tool activity.
- **Pairing (integration).** Against a real daemon (gated, like the backend's `FUSION_E2E`):
  unpaired app + correct code → accepted and node id persisted; wrong code → rejected before
  any session data; second launch reconnects with no code.
- **End-to-end (gated, real iroh).** Spin the daemon with a stub session; the app pairs,
  lists, attaches, observes a backfill + a streamed delta, sends a prompt that reaches the
  stub, and aborts. Mirrors `tests/remote.e2e.test.ts` from the client side.

## Out of Scope

- **Starting sessions from the phone** — its own capability in
  `PHONE_INITIATED_SESSIONS_PRD.md`; this app consumes it in Phase 2.
- **Android / desktop clients.** iOS + SwiftUI only.
- **Push notifications / background wake.** Phase 0 is foreground; true background delivery
  (e.g. "the agent is asking a question") is deferred — iroh holds no Apple push channel and
  a notification path is a separate design.
- **Per-device revocation UI, multiple paired laptops, session search/history.** Later.
- **Richer transcript fidelity** (full untruncated tool output, diffs, images). The Phase 0/1
  UI renders the existing compact projection; richer data is a protocol evolution.

## Further Notes

### Connect / pair / attach sequence (client view)

```
Pairing (first launch):
  laptop /remote pair     → prints QR(ticket) + code   [precursor change above]
  app  → scan QR           → EndpointTicket.fromString(ticket).endpointAddr()
  app  → daemon            → connect(addr, "pi/remote/1"); openBi
  app  → daemon            → control: pair { code }; finish send
  daemon → app             → control: pair { paired: true }   (node id now allowlisted)
Normal use (paired):
  app  → daemon            → connect; openBi; control: list; finish send
  daemon → app             → control: list [{ sessionId, name, cwd }]
  app  → daemon            → openBi; per-session: attach { sessionId, stream: true }; finish send
  daemon → app             → event frames: full backfill, then live deltas (stream stays open)
  app  → daemon            → (separate stream) prompt { sessionId, text }; finish send
  app  → daemon            → (separate stream) abort { sessionId }; finish send
  daemon → app             → on session end: control/per-session shutdown → close feed, drop from list
```

### File seams (Swift)

- `RemoteClient` — owns the iroh `Endpoint` (one secret key), opens request and streaming
  streams, the only type importing `IrohLib`. Async API: `pair`, `list`, `attachStream`,
  `sendPrompt`, `abort`.
- `Protocol` — `Envelope` codable + LF JSONL encode/decode mirroring `protocol.ts`; control vs
  per-session typing. Pure, fixture-tested against the TS side.
- `Projection` — Swift model of the transcript entry + the coalescing rules into renderable
  chat items.
- `Pairing` — ticket scan (camera/QR), code entry, Keychain-backed identity, `pi/remote/1`
  constant.
- `SessionStore` — `@Observable` registry + per-session transcript; drives the SwiftUI views.
- Views — `SessionListView`, `ConversationView` (chat bubbles + composer + Stop), `PairingView`.

### Build order (suggested)

1. **iroh-ffi connector spike.** A throwaway Swift CLI/app that parses the daemon's ticket,
   connects over `pi/remote/1`, opens a bi-stream, and round-trips one envelope against the
   running daemon. Proves `IrohLib` exposes connect + `openBi` + ticket parsing before any UI.
2. Land the host precursor (`/remote pair` shows real QR + code).
3. `Protocol` + `Projection` with cross-language fixture tests.
4. `RemoteClient.pair` + `list` against the live daemon.
5. Streaming attach → `SessionStore` → `ConversationView` renders backfill + live deltas.
6. `sendPrompt` + `abort` from the composer (Phase 0 complete).
7. Reconnect/lifecycle + multi-session switching (Phase 1).
8. Gated client e2e.
9. Phase 2 wiring once `PHONE_INITIATED_SESSIONS_PRD.md` lands.
