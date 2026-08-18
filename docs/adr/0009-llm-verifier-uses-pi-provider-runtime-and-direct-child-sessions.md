# ADR-0009: LLM verifier uses Pi's provider runtime and direct child sessions

- **Status:** Accepted for V1
- **Date:** 2026-08-18

## Context

The upstream `llm-verifier` 0.2.0 implementation computes expectations over A-T score-token logprob distributions. It also uses repeated evaluations, odd-repetition A/B slot swaps, and the Probabilistic Pivot Tournament. A sampled letter is not an equivalent substitute.

Pi main at `59a71b235dadb4ad0d67557a8abb0aaa093e68b4` can pass arbitrary OpenAI-compatible request fields and custom fetch implementations, but its public `AssistantMessage` and event protocol discard provider token alternatives. Pi's `ConstrainedSamplingConfig` controls tool JSON/grammar generation; it is not a general next-token distribution API.

Pi's SDK already supports cwd-bound `AgentSession` instances, in-memory sessions, lifecycle subscriptions, model selection, and disabling extension discovery. RPC provides process isolation but duplicates protocol/process management that V1 worktrees already handle for filesystem concurrency.

## Decision

1. Port verifier algorithms into pure TypeScript modules. No Python process, package, or bridge is permitted.
2. Use Pi's extension model registry `complete()` path for verifier inference so Pi retains ownership of model lookup, credentials, provider compatibility, request construction, retries, and usage accounting.
3. For `openai-completions` models, capture standard OpenAI-compatible SSE logprob chunks by passing a response-cloning `fetch` through Pi. This is a verifier-specific observation layer, not a provider SDK client.
4. Preserve upstream open-model prefill behavior by sending a final assistant prefix and injecting `continue_final_message`, `add_generation_prompt: false`, and `structured_outputs.choice` into Pi's provider payload, then scoring the constrained one-token A-T distribution.
5. Preserve upstream prefill ordering: score B is conditioned on the sampled A score tag.
6. Treat DeepSeek-style hosted models as direct-tag emitters and read distributions at `<score_A>` / `<score_B>` positions.
7. Fail preflight for provider APIs whose token distributions Pi cannot currently expose, including Google Vertex. Never substitute a sampled score token.
8. Run coding candidates as direct in-process Pi `AgentSession` instances, one per Git worktree, with verifier-extension loading disabled. Add subprocess/RPC runners later behind the same candidate-runner interface if stronger process isolation is needed.

## Smallest reusable Pi enhancement

A future Pi change should add an opt-in, provider-neutral request such as `tokenLogprobs: { topK: number }` and expose normalized generated positions (`token`, chosen logprob, top alternatives) on the returned assistant message or an options callback. The OpenAI completions and Google Vertex adapters can map their native logprob fields into that shape. This removes the SSE observation layer and unlocks Vertex without leaking provider SDKs into the extension.

## Consequences

- V1 can perform exact fine-grained scoring on compatible OpenAI-style endpoints today while using Pi's existing auth/provider registry.
- Capability is verified by a real distribution probe before a tournament starts.
- The current implementation requires Pi 0.84.2 or newer for extension-side `complete()` and custom-fetch observation.
- Google Vertex support remains blocked, loudly and intentionally, until Pi exposes its logprob result.
- Worktrees isolate concurrent repository changes but remain execution isolation, not a security sandbox.
