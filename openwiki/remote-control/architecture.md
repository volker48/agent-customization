# Remote Control Architecture

Remote control lets a phone view and steer a running Pi session while the session keeps executing on the laptop. The phone never executes tools — it is a control surface, not a relocated session.

## Architecture Overview

```
┌─────────────────────────────────────────────────┐
│  Execution Host (laptop)                        │
│                                                 │
│  ┌──────────┐    Unix socket    ┌────────────┐  │
│  │ Pi       │◄─────────────────►│ Remote     │  │
│  │ Session  │   IPC (daemon.sock)│ Daemon     │  │
│  │ (agent   │                   │            │  │
│  │  loop)   │                   │ ┌────────┐ │  │
│  └──────────┘                   │ │ iroh   │ │  │
│       │                         │ │endpoint│ │  │
│       │ runs tools,             │ └───┬────┘ │  │
│       │ owns cwd                └─────┼──────┘  │
│                                       │         │
└───────────────────────────────────────┼─────────┘
                                        │
                              iroh P2P (QUIC+TLS)
                              ALPN: pi/remote/1
                                        │
                    ┌───────────────────┼───────────┐
                    │                   │           │
              ┌─────▼─────┐      ┌─────▼─────┐    │
              │ iOS Client │      │ (other    │    │
              │ (phone)    │      │  clients) │    │
              │            │      └───────────┘    │
              │ view +     │                       │
              │ steer only │                       │
              └────────────┘                       │
```

## Components

### 1. Pi Extension (`pi-extensions/remote/index.ts`)

Registers the `/remote` command. When invoked:

1. Connects to (or spawns) the remote daemon via Unix socket
2. Registers the session with the daemon (session ID, name, working directory)
3. Subscribes to Pi live events (`message_start`, `message_update`, `message_end`, `tool_execution_*`, `turn_start/end`, `agent_end`)
4. Projects transcript events via `transcript-projection.ts` and forwards to daemon
5. Receives inbound messages from the daemon: `attach`, `detach`, `prompt`, `abort`, `sync`

Subcommands: `/remote` (start), `/remote status`, `/remote stop`, `/remote pair`.

If no devices are paired yet, the extension automatically shows pairing info.

### 2. Remote Daemon (`pi-extensions/remote/daemon.ts`)

A single long-lived process on the execution host that:

- Owns the one persistent **iroh endpoint** (stable node identity across restarts)
- Manages the **session registry** — a map of session IDs to their display name, working directory, and IPC socket
- Multiplexes between remote clients and Pi sessions
- Does **not** run the agent loop itself

Started on-demand: when `/remote` is invoked and no daemon socket exists, the extension spawns one via `daemon-entry.ts`. The daemon persists its iroh secret key in `~/.pi/agent/remote/iroh-secret-key.json` so its node ID is constant across runs.

### 3. iroh P2P Transport (`pi-extensions/remote/iroh-transport.ts`)

Uses [`@number0/iroh`](https://iroh.computer) for P2P connectivity:

- **Endpoint** — Bound with a persistent secret key, ALPN `pi/remote/1`, default relay mode
- **Connections** — Accepted via `endpoint.acceptNext()`, ALPN-verified
- **Streams** — Bidirectional streams (`openBi`/`acceptBi`) carry newline-delimited JSON envelopes
- **Tickets** — `EndpointTicket.fromAddr(endpoint.addr())` produces a connection ticket the phone scans as a QR code

iroh secures the transport (QUIC+TLS, cryptographically verified node IDs) but provides **no authorization** — any node that learns the ticket can dial. Authorization is handled separately.

### 4. Authorization (`pi-extensions/remote/authorization.ts`)

Per [ADR-0003](../../docs/adr/0003-remote-control-authorization-is-nodeid-allowlist-after-coded-pairing.md), authorization uses a **node ID allowlist established through one-time coded pairing**:

**Pairing flow (first contact):**
1. Daemon generates a 6-digit pairing code (`createPairingCode()` — unbiased, crypto-random)
2. Daemon displays an iroh ticket as a terminal QR code + the pairing code
3. Client connects, presents the code
4. `verifyPairingCode()` uses `timingSafeEqual` to prevent timing attacks
5. On success, daemon persists client's iroh node ID to `~/.pi/agent/remote/allowed-node-ids.json` (mode 0o600)
6. Client can reconnect by node ID alone — no code needed

**Authorization check (`authorizeRemoteEnvelope()`):**
- If node ID is in allowlist → accepted (paired mode)
- If not paired but envelope is a `pair` type with valid code → accepted (pairing mode), node ID added
- Otherwise → rejected before any session data flows

`CachedNodeAllowlist` wraps `FileNodeAllowlist` with an in-memory cache per connection to avoid repeated file reads.

### 5. Protocol (`pi-extensions/remote/protocol.ts`)

Newline-delimited JSON envelopes. Two channels:

**Control messages** (`sessionId: null`):
| Type | Direction | Purpose |
|---|---|---|
| `pair` | Client→Daemon | Present pairing code |
| `list` | Client→Daemon | List available sessions |
| `attach` | Client→Daemon | Start streaming a session |
| `detach` | Client→Daemon | Stop streaming |
| `session_ended` | Daemon→Client | Session terminated |

**Per-session messages** (`sessionId: string`):
| Type | Direction | Purpose |
|---|---|---|
| `event` | Daemon→Client | Transcript event (message, tool execution, turn) |
| `prompt` | Client→Daemon | Send a steering prompt to the session |
| `abort` | Client→Daemon | Abort the current agent turn |

`routeEnvelope()` dispatches based on whether `sessionId` is null (control) or present (session).

### 6. IPC (`pi-extensions/remote/ipc.ts`)

The daemon and extensions communicate over a Unix-domain socket (`daemon.sock`):

- **Daemon side**: `startIpcDaemonServer()` creates a `net.Server`, maintains the session registry, and provides `sendToSession()`, `subscribe()`, `waitForSession()`, `waitForSessionEnd()`
- **Extension side**: `connectIpcExtension()` connects to the socket, sends a `register` envelope, and provides `send()` and `readNext()`

IPC message types extend the protocol types with: `register`, `session_shutdown`, `daemon_stop`, `sync`, `pairing_info`.

### 7. Transcript Projection (`pi-extensions/remote/transcript-projection.ts`)

Transforms Pi's rich live events into a compact `TranscriptEntry[]` for wire transmission:

```typescript
type TranscriptEntry = {
  role: "user" | "assistant" | "toolResult" | "system";
  text: string;              // truncated to 4000 chars by default
  toolName: string | null;
  status: string;            // "started", "streaming", "completed", "running", "error"
  truncatedOutput: boolean;
};
```

Events projected: `message_start/update/end`, `tool_execution_start/update/end`, `turn_start/end`, `agent_end`. Tool results are truncated to `maxOutputChars` (default 4000).

### 8. CLI (`pi-extensions/remote/cli.ts`)

Installed as the `pi-remote` binary (`package.json` `bin`):

```bash
pi-remote status   # Show daemon status, sessions, paired devices
pi-remote stop     # Stop the daemon
```

Communicates with the daemon over the same Unix socket.

### 9. iOS Client (`ios-remote-client/`)

A Swift package for iPhone remote control:

- **`RemoteClient.swift`** — Connects to the daemon via iroh, manages connection lifecycle and reconnection
- **`RemoteProtocol.swift`** — Swift envelope types matching the TypeScript protocol
- **`SessionStore.swift`** — Manages session list and selected session state
- **`Projection.swift`** — Renders transcript entries as Swift UI components
- **`Package.swift`** — Swift Package Manager manifest

The iOS client pairs by scanning the QR ticket, enters the pairing code, then can view the live transcript and send steering prompts.

## Session Lifecycle

1. User runs `/remote` in a Pi session
2. Extension connects to daemon (spawns if needed), registers session
3. If no paired devices → shows pairing ticket + code
4. Phone pairs (one-time), then connects by node ID
5. Phone sends `attach` for a session → daemon starts streaming events
6. Extension receives `attach`, sends backfill (full transcript history), then live events
7. Phone sends `prompt` → extension injects via `pi.sendUserMessage(text, { deliverAs: "steer" })`
8. Phone sends `abort` → extension calls `ctx.abort()`
9. Phone sends `detach` or disconnects → streaming stops, session continues

### Backfill & Live Event Buffering

When a client attaches, the extension:
1. Sets `backfilling = true`, buffers live events
2. Sends the full transcript branch via `sendBackfill()`
3. Drains any inbound messages received during backfill
4. Flushes buffered live events
5. Sets `backfilling = false`, `attached = true`

## Security Model

- **Transport**: iroh (QUIC+TLS) with verified node IDs
- **Authorization**: Node ID allowlist after one-time coded pairing (ADR-0003)
- **Execution**: The phone never executes tools — all execution stays on the laptop
- **Remote prompts**: Execute tools unattended by design (the operator trusts their own paired device)
- **Revocation**: Manual — delete the node ID from `allowed-node-ids.json`
- **File permissions**: Allowlist and secret key are mode 0o600/0o700

## Source Map

- [`pi-extensions/remote/index.ts`](../../pi-extensions/remote/index.ts) — Pi extension, `/remote` command
- [`pi-extensions/remote/daemon.ts`](../../pi-extensions/remote/daemon.ts) — Daemon implementation
- [`pi-extensions/remote/daemon-entry.ts`](../../pi-extensions/remote/daemon-entry.ts) — Daemon process entry point
- [`pi-extensions/remote/protocol.ts`](../../pi-extensions/remote/protocol.ts) — Wire protocol envelopes
- [`pi-extensions/remote/authorization.ts`](../../pi-extensions/remote/authorization.ts) — Pairing, allowlist, authorization
- [`pi-extensions/remote/iroh-transport.ts`](../../pi-extensions/remote/iroh-transport.ts) — iroh P2P transport layer
- [`pi-extensions/remote/ipc.ts`](../../pi-extensions/remote/ipc.ts) — Unix socket IPC between extension and daemon
- [`pi-extensions/remote/transcript-projection.ts`](../../pi-extensions/remote/transcript-projection.ts) — Event projection for wire
- [`pi-extensions/remote/cli.ts`](../../pi-extensions/remote/cli.ts) — `pi-remote` CLI
- [`ios-remote-client/Sources/PiRemoteClient/`](../../ios-remote-client/Sources/PiRemoteClient/) — iOS Swift client
- [`docs/adr/0003-remote-control-authorization-is-nodeid-allowlist-after-coded-pairing.md`](../../docs/adr/0003-remote-control-authorization-is-nodeid-allowlist-after-coded-pairing.md) — Authorization decision
- [`REMOTE_CONTROL_PRD.md`](../../REMOTE_CONTROL_PRD.md) — Product requirements document
