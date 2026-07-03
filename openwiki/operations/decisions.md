# Architecture Decision Records

Three accepted ADRs govern the major design decisions in this repository. Each is in [`docs/adr/`](../../docs/adr/).

## ADR-0001: Fusion Inner Tools Are a Restricted Projection

**File:** [`docs/adr/0001-fusion-inner-tools-are-a-restricted-projection.md`](../../docs/adr/0001-fusion-inner-tools-are-a-restricted-projection.md)

**Decision:** Fusion's inner `web_search` and `webfetch` tools share their *implementation* with the standalone extensions (both call the deep cores in `lib/*-core.ts`) but deliberately do **not** share their *interface*. The standalone tools expose a rich, model-controlled parameter surface; the Fusion tools expose a narrowed surface, rename `exa_search` → `web_search`, and inject operator policy from `fusion.json`.

**Why:** Fusion runs untrusted inner models (panel + judge) directly via the AI completion API. The narrow schema, rename, and hand-written two-tool allowlist are security controls — the operator decides search type, fetch strategy, domain policy, and result caps, not the inner model.

**Rejected alternative:** Collapse into one shared "web-tool definition" mounted by both hosts. Rejected because the duplication is the point — a derived/shared tool registry would erode the explicit two-tool allowlist that Fusion's safety posture depends on.

**Consequence:** Do not re-suggest unifying these tool interfaces. The implementation seam (`lib/*-core.ts`) is already the correct shared module.

---

## ADR-0002: The Calling Model Synthesizes the Final Answer

**File:** [`docs/adr/0002-the-calling-model-synthesizes-the-final-answer.md`](../../docs/adr/0002-the-calling-model-synthesizes-the-final-answer.md)

**Decision:** The judge produces only a structured analysis (consensus, contradictions, partial coverage, unique insights, blind spots, source quality, risks) plus confidence. The **calling model** — whatever model `/model` has active — writes the final answer, grounded in the judge's analysis and panel responses.

**Why:**
- **Fidelity to OpenRouter Fusion** — the reference design has the calling model write the final answer, not the judge
- **`/copy` works** — the synthesized answer is a normal assistant message, not a custom rendered message
- **Session context** — the calling model runs inside Pi's agent loop with full session, repo, and tool context that inner models lack

**Rejected alternatives:**
- Keep the judge authoring the final answer and re-emit as assistant message (fixes `/copy` but not the architecture)
- Inject synthesis prompt as `sendUserMessage` (renders as a large user bubble duplicating the `/fusion` invocation)

**Consequence:** `FusionJudgeOutput` no longer carries `finalAnswer`. The judge system prompt is analysis-only. ADR-0001's "outside Pi's agent loop" framing applies only to inner models (panel + judge); the synthesis step is deliberately inside the loop.

---

## ADR-0003: Remote Control Authorization Is Node-ID Allowlist After Coded Pairing

**File:** [`docs/adr/0003-remote-control-authorization-is-nodeid-allowlist-after-coded-pairing.md`](../../docs/adr/0003-remote-control-authorization-is-nodeid-allowlist-after-coded-pairing.md)

**Decision:** Remote control authorizes devices by iroh node ID, established through one-time coded pairing. On first contact, the daemon shows a ticket (QR) plus a short pairing code; the client presents the code; on success the daemon persists the client's node ID to an allowlist. Every later connection is authorized by node ID alone.

**Why:** iroh secures the transport (QUIC+TLS, verified node IDs) but provides no authorization — any node that learns the ticket can dial. A node-ID allowlist gives unforgeable per-device auth with "pair once" UX.

**Rejected alternatives:**
- Bearer token only (leakable, long-lived, no per-device identity or revocation)
- Trust-on-first-connect without code (race condition — first dialer is trusted)

**Consequence:** The daemon persists a stable iroh secret key and allowlist file under `~/.pi/agent/remote/`. Revocation is manual (delete the entry). Two connection paths exist: paired (node ID checked) and pairing (code checked, then node ID recorded).

---

## Agent Workflow Docs (`docs/agents/`)

- [`docs/agents/domain.md`](../../docs/agents/domain.md) — Instructs agents to read `CONTEXT.md` and `docs/adr/` before exploring, use the glossary's vocabulary, and flag ADR conflicts explicitly
- [`docs/agents/issue-tracker.md`](../../docs/agents/issue-tracker.md) — GitHub issues via `gh` CLI
- [`docs/agents/triage-labels.md`](../../docs/agents/triage-labels.md) — Canonical labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`

## Plans

- [`docs/plans/webfetch-html-to-markdown.md`](../../docs/plans/webfetch-html-to-markdown.md) — Design plan for the webfetch HTML-to-markdown conversion pipeline

## Source Map

- [`docs/adr/`](../../docs/adr/) — All architecture decision records
- [`docs/agents/`](../../docs/agents/) — Agent workflow documentation
- [`docs/plans/`](../../docs/plans/) — Design plans
- [`CONTEXT.md`](../../CONTEXT.md) — Domain glossary (canonical vocabulary)
- [`AGENTS.md`](../../AGENTS.md) — Agent skill pointers
