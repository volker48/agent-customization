# The calling model synthesizes the Fusion final answer, not the judge

**Status:** accepted

In a fusion run the **judge** produces only a structured analysis of the panel responses (consensus, contradictions, partial coverage, unique insights, blind spots, source quality, risks) plus a confidence rating. It no longer writes the user-facing answer. The **calling model** — whatever model `/model` has active, which may differ from the judge — writes the final answer, grounded in the judge's analysis and the panel responses.

The orchestrator (`runFusion`) stops at the judge's analysis. The command handler (`index.ts`) injects a custom `fusion-panel` message whose `content` is the synthesis prompt and calls `pi.sendMessage(..., { triggerTurn: true })`. Pi turns that custom message into a user-role message in context and runs the active model, which produces the final answer as an ordinary assistant message.

## Why

- **Fidelity to OpenRouter Fusion.** The reference design dispatches to a panel, has a judge produce structured analysis, and then "the calling model writes the final answer grounded in that analysis." The previous implementation collapsed analysis and authoring into the judge, so the active model never participated.
- **`/copy` works.** The previous final answer was a custom `fusion-result` message rendered by the extension; `/copy` operates on assistant messages, so the answer could not be copied. The synthesized answer is now a normal assistant message.
- **The calling model has context the inner models lack.** It runs inside Pi's agent loop with the full session, repo, and tools, so it can ground the synthesis in this project — not just the panel's context-free responses.

## Considered options

- **Keep the judge authoring the final answer and re-emit it as an assistant message.** Rejected. It would fix `/copy` but not the architecture: the active model still would not synthesize, and the answer would still be written by a model blind to the session.
- **Inject the synthesis prompt as a `sendUserMessage`.** Rejected. It would render as a large user bubble duplicating the `/fusion` invocation. A custom `fusion-panel` message renders as a compact, expandable card while still entering the LLM context as a user-role message.

## Consequences

- `FusionJudgeOutput` no longer carries `finalAnswer`; `runFusion` returns analysis + confidence. Consumers asserting on a judge-authored answer (notably the e2e test) assert on panel content and confidence instead.
- The judge system prompt is analysis-only; the synthesis instructions live in `SYNTHESIS_INSTRUCTIONS` / `buildSynthesisPrompt` and are read by the calling model.
- This narrows ADR-0001's "outside Pi's agent loop" framing to the **inner** models (panel + judge). The synthesis step is deliberately inside the loop, with full tools — that is the point, not drift.
