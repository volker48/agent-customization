import type { ModelRef, ModelRegistryLike, ResolvedModel } from "./types.js";

export function parseModelRef(ref: ModelRef): { provider: string; modelId: string } {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) {
    throw new Error(`Expected provider/model, got ${ref}`);
  }

  return {
    provider: ref.slice(0, slash),
    modelId: ref.slice(slash + 1),
  };
}

export async function resolveModelRef(
  registry: ModelRegistryLike,
  ref: ModelRef,
): Promise<ResolvedModel> {
  const parsed = parseModelRef(ref);
  const model = registry.find(parsed.provider, parsed.modelId);
  if (!model) {
    throw new Error(`Fusion model not found: ${ref}`);
  }

  const auth = await registry.getApiKeyAndHeaders(model);
  if (auth.ok === false) {
    throw new Error(`Missing credentials for Fusion model ${ref}: ${auth.error}`);
  }

  if (!auth.apiKey) {
    const hint = registry.isUsingOAuth?.(model)
      ? "OAuth/subscription token unavailable; run `pi /login` for this provider"
      : "set the provider API key or run `pi /login`";
    throw new Error(`Missing credentials for Fusion model ${ref}: ${hint}`);
  }

  return { ref, model, apiKey: auth.apiKey, headers: auth.headers };
}
