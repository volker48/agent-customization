import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  PiVerifierModelClient,
  requirePiModelRegistry,
  resolveVerifierModel,
} from "./llm-verifier/pi/model-client.js";

const DEFAULT_MODEL_ENV = "PI_LAV_VERIFIER_MODEL";

export default function llmVerifierExtension(pi: ExtensionAPI): void {
  pi.registerCommand("lav-status", {
    description: "Show native LLM-as-a-Verifier implementation and provider capability status",
    handler: async (_args, ctx) => {
      const ref = process.env[DEFAULT_MODEL_ENV]?.trim();
      if (!ref) {
        ctx.ui.notify(
          `LLM-as-a-Verifier core is loaded. Set ${DEFAULT_MODEL_ENV}=provider/model to run provider preflight.`,
          "info",
        );
        return;
      }

      try {
        const registry = requirePiModelRegistry(ctx.modelRegistry);
        const model = resolveVerifierModel(registry, ref);
        const client = new PiVerifierModelClient(registry, { model });
        await client.assertCapabilities(ctx.signal);
        ctx.ui.notify(
          `Verifier ${ref} exposed usable A-T token distributions through Pi's provider stack.`,
          "info",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Verifier preflight failed: ${message}`, "error");
      }
    },
  });
}
