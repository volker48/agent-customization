# Remote control architecture

## Product goal

Remote control lets a user keep a Pi coding session running on a laptop while viewing and steering it from another device, such as a phone. `REMOTE_CONTROL_PRD.md` is the primary product source: the laptop remains the permanent execution host; the remote client is only a view-and-steer surface and runs no tools.

## Main components

```text
Remote client ── iroh QUIC (ALPN pi/remote/1) ── local daemon ── Unix socket ── Pi extension
```

- **Pi extension**: `pi-extensions/remote/index.ts` registers `/remote` and bridges Pi session events/prompts to the daemon.
- **Daemon**: `pi-extensions/remote/daemon.ts` owns the persistent iroh endpoint, session registry, authorization, and routing.
- **IPC**: `pi-extensions/remote/ipc.ts` connects extension clients to the daemon over `~/.pi/agent/remote/daemon.sock`.
- **Transport**: `pi-extensions/remote/iroh-transport.ts` wraps `@number0/iroh` endpoint/connection/stream operations.
- **Protocol**: `pi-extensions/remote/protocol.ts` defines LF-delimited JSON envelope framing and message types.
- **Authorization**: `pi-extensions/remote/authorization.ts` handles pairing code generation, validation, and node-id allowlisting.
- **Transcript projection**: `pi-extensions/remote/transcript-projection.ts` converts Pi transcript/events to compact remote-safe entries.

## `/remote` command behavior

`remoteExtension` registers `/remote` with subcommands:

- `/remote` — register the current Pi session, spawning the daemon if needed.
- `/remote status` — show daemon/session status.
- `/remote stop` — stop the daemon.
- `/remote pair` — show a fresh pairing ticket/code.

On normal `/remote`, the extension obtains the Pi session id, connects to or spawns the daemon, registers session metadata (`sessionId`, name, cwd), starts reading daemon envelopes, and shows pairing info if no node ids are allowlisted.

The extension subscribes to live Pi events (`message_*`, `tool_execution_*`, `turn_*`, `agent_end`) and forwards projected payloads only when attached. During backfill it queues live events and flushes them after synchronization to avoid gaps.

Remote prompts are injected through Pi as steering messages (`pi.sendUserMessage(..., { deliverAs: "steer" })` per PRD and implementation intent), and remote abort maps to `ctx.abort()`.

## Daemon lifecycle and storage

`defaultRemoteRoot()` is `~/.pi/agent/remote` (`authorization.ts`). Important files there:

- `daemon.sock` — fixed Unix socket path for the extension/CLI IPC.
- `iroh-secret-key.json` — stable daemon identity so clients can pair once.
- `allowed-node-ids.json` — paired client node ids.

The extension lazily spawns the daemon as a detached process and waits up to 10 seconds for the socket. The daemon prepares the socket path, binds iroh with the persisted secret key, starts the IPC server, chmods owner-only files/sockets, and accepts iroh connections until closed.

The `pi-remote` CLI exposed by `package.json` uses the same daemon controls outside the TUI.

## Protocol

`protocol.ts` defines:

- ALPN: `pi/remote/1`.
- Control message types: `pair`, `list`, `attach`, `detach`, `session_ended`.
- Per-session message types: `event`, `prompt`, `abort`.
- Envelope shape: `{ sessionId, type, payload }` where `sessionId: null` means control channel.
- Framing: JSON plus trailing newline; decoding splits on `\n`.

The daemon routes control envelopes itself and per-session envelopes through the IPC server to the registered Pi extension.

## Authorization model

ADR-0003 is the authority: iroh authenticates transport peer identity but does not authorize who may steer the agent. This repo authorizes by node-id allowlist after one-time coded pairing.

Flow:

1. Pairing info arms a five-minute `PairingWindow` and returns an iroh ticket plus a short code like `123-456`.
2. A new client connects and sends a pairing envelope with the code.
3. The daemon verifies the code with timing-safe comparison, consumes the window, and writes the client's node id to `allowed-node-ids.json` with mode `0600`.
4. Future connections from that node id are accepted without a code.
5. Unknown node ids are rejected before session data flows.

Remote prompts can run tools unattended by design, so do not weaken this authorization path casually.

## Transcript projection

`transcript-projection.ts` normalizes transcript messages and live events into entries with:

- `role`
- `text`
- `toolName`
- `status`
- `truncatedOutput`

Tool outputs and text are truncated to protect remote transport/UI from large payloads. Attach uses a full transcript backfill followed by live deltas; reconnects resync through another full backfill rather than replaying buffered deltas.

## Change guidance

- Keep the execution-host boundary: remote clients steer, but Pi on the laptop executes tools.
- Preserve node-id allowlist plus code pairing unless replacing ADR-0003 with a new accepted decision.
- Update remote tests (`tests/remote-*.test.ts`, `tests/remote.e2e.test.ts`, `tests/ios-remote-fixtures.test.ts`) for protocol, authorization, daemon readiness, transcript, and CLI changes.
- Be careful with frame compatibility; clients depend on the JSONL envelope and ALPN version.
