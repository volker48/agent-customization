import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { runFusion } from "../pi-extensions/fusion/orchestrator.js";
import type { FusionConfig } from "../pi-extensions/fusion/types.js";

/**
 * Opt-in end-to-end test that calls real providers through Pi's ModelRegistry.
 *
 * Run with real subscription/API credentials configured in Pi's auth.json:
 *   FUSION_E2E=1 vitest run tests/fusion.e2e.test.ts
 *
 * Override the panel/judge via env to match your authed models:
 *   FUSION_E2E_JUDGE, FUSION_E2E_MODELS (comma-separated)
 */
const runE2E = process.env.FUSION_E2E === "1";
const describeIf = runE2E ? describe : describe.skip;

const JUDGE = process.env.FUSION_E2E_JUDGE ?? "anthropic/claude-haiku-4-5";
const MODELS = (
  process.env.FUSION_E2E_MODELS ?? "openai-codex/gpt-5.3-codex,anthropic/claude-haiku-4-5"
)
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

describeIf("fusion extension e2e", () => {
  it(
    "runs panel + judge against real providers, including a subscription model",
    async () => {
      const registry = ModelRegistry.create(AuthStorage.create());
      const config: FusionConfig = {
        judge: JUDGE,
        models: MODELS,
        maxToolCalls: 0,
        maxCompletionTokens: 400,
      };

      const result = await runFusion({
        prompt: "In one short sentence, what is the capital of France?",
        config,
        registry,
        signal: new AbortController().signal,
      });

      const summary = result.responses.map((r) => `${r.model}=${r.status}`).join(", ");
      console.log(`fusion e2e: status=${result.status} [${summary}]`);
      for (const response of result.responses) {
        if (response.status === "error") console.log(`  ${response.model} error: ${response.error}`);
      }

      expect(result.status).not.toBe("error");
      expect(result.responses.every((r) => r.status === "ok")).toBe(true);
      expect(result.judgeOutput?.finalAnswer.toLowerCase()).toContain("paris");
    },
    120_000,
  );
});
