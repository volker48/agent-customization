# Remote control authorizes devices by iroh node id, after one-time coded pairing

**Status:** accepted

Remote control exposes a power surface: a connected, authorized client can steer the agent, and the agent runs `bash` and edits files on the execution host unattended. iroh secures the *transport* (QUIC+TLS, and the connecting peer's node id is its cryptographically verified public key) but provides **no authorization** — any node that learns the daemon's ticket can dial its ALPN. So the daemon must decide who may drive.

We authorize by **node id allowlist established through one-time coded pairing**: on first contact the daemon shows a ticket (terminal QR) plus a short pairing code after arming a fresh five-minute pairing window; the client connects and presents the code; on success the daemon consumes the window and persists the client's node id to an allowlist under `~/.pi/agent/remote/`. Every later connection is authorized by node id alone — unforgeable, and "pair once" for the user. Unknown node ids are rejected before any session data flows. A failed pairing attempt ends that connection, so a client cannot batch guesses on one QUIC connection. Remote-initiated prompts execute tools unattended by design — confirmation would defeat the purpose, and the operator trusts their own paired device.

## Considered options

- **Bearer token only (token embedded in the ticket).** Rejected. The token is a leakable, long-lived password with no per-device identity or revocation. Node-id allowlisting gives unforgeable per-device auth for little extra code.
- **Allowlist with trust-on-first-connect (no code).** Rejected. The pairing window becomes a race — whichever node dials first is trusted. The pairing code closes that window for a few lines of code.

## Consequences

- The daemon persists a stable iroh secret key (so its node id is constant across runs) and an allowlist file under `~/.pi/agent/remote/`.
- Revocation in the POC is manual: delete the allowlist entry. Per-device revocation UI is deferred.
- The connection handshake has two shapes — a paired path (node id checked against the allowlist) and a pairing path (fresh window code checked, window consumed, then node id recorded).
