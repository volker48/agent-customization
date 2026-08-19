import type { Api, AssistantMessage, Context, Message, Model, Usage } from "@earendil-works/pi-ai";

import { extractTaggedExpectation, requireExpectedScaleValue } from "../core/expected-value.js";
import { buildPairwisePrompt, type PairwisePromptInput } from "../core/prompt.js";
import { normalizeScaleLetter, SCORE_LETTERS, type ScoreLetter } from "../core/scale.js";
import type { SlotPairReward, VerifierCompletion } from "../core/types.js";
import { OpenAiSseLogprobCapture } from "./openai-logprob-capture.js";

export const MINIMUM_PI_LOGPROB_RUNTIME = "0.84.2";

export type ScoreExtractionMode = "auto" | "direct-tags" | "prefill";

interface JsonObject {
  [key: string]: unknown;
}

export interface VerifierCompletionOptions {
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  fetch?: typeof globalThis.fetch;
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  onPayload?: (
    payload: unknown,
    model: Model<Api>,
  ) => unknown | undefined | Promise<unknown | undefined>;
}

export interface PiModelRegistryLike {
  find(provider: string, modelId: string): Model<Api> | undefined;
  complete<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: VerifierCompletionOptions,
  ): Promise<AssistantMessage>;
}

interface MaybePiModelRegistry {
  find?: unknown;
  complete?: unknown;
}

export interface PiVerifierClientFingerprint {
  model: {
    provider: string;
    model: string;
    api: string;
  };
  scoring: {
    temperature: number;
    topLogprobs: number;
    minimumScaleTokens: number;
    extractionMode: Exclude<ScoreExtractionMode, "auto">;
    maxAnalysisTokens: number;
    directTagMaxTokens: number;
    reasoningEffort: string;
  };
}

export interface PiVerifierModelClientOptions {
  model: Model<Api>;
  extractionMode?: ScoreExtractionMode;
  topLogprobs?: number;
  minimumScaleTokens?: number;
  maxAnalysisTokens?: number;
  directTagMaxTokens?: number;
  reasoningEffort?: VerifierCompletionOptions["reasoningEffort"];
}

interface PrefilledScore {
  value: number;
  sampledLetter: ScoreLetter;
}

export class UnsupportedVerifierModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedVerifierModelError";
  }
}

export class PiVerifierModelClient {
  private readonly mode: Exclude<ScoreExtractionMode, "auto">;
  private readonly topLogprobs: number;
  private readonly minimumScaleTokens: number;
  private readonly maxAnalysisTokens: number;
  private readonly directTagMaxTokens: number;

  constructor(
    private readonly registry: PiModelRegistryLike,
    private readonly options: PiVerifierModelClientOptions,
  ) {
    if (options.model.api !== "openai-completions") {
      throw new UnsupportedVerifierModelError(
        `Verifier model ${options.model.provider}/${options.model.id} uses ${options.model.api}. ` +
          "Current Pi streams do not expose provider-neutral token logprobs for this API. " +
          "Choose an openai-completions model or add Pi token-distribution support; sampled labels are not accepted.",
      );
    }
    const modelMaxTokens = positiveInteger(options.model.maxTokens, "model.maxTokens");
    this.mode = resolveExtractionMode(options.model, options.extractionMode ?? "auto");
    this.topLogprobs = boundedInteger(options.topLogprobs ?? 20, 1, 20, "topLogprobs");
    this.minimumScaleTokens = boundedInteger(
      options.minimumScaleTokens ?? 2,
      1,
      SCORE_LETTERS.length,
      "minimumScaleTokens",
    );
    this.maxAnalysisTokens = boundedInteger(
      Math.min(options.maxAnalysisTokens ?? 4096, modelMaxTokens),
      1,
      modelMaxTokens,
      "maxAnalysisTokens",
    );
    this.directTagMaxTokens = boundedInteger(
      Math.min(options.directTagMaxTokens ?? 32768, modelMaxTokens),
      1,
      modelMaxTokens,
      "directTagMaxTokens",
    );
  }

  fingerprint(): PiVerifierClientFingerprint {
    return {
      model: {
        provider: this.options.model.provider,
        model: this.options.model.id,
        api: this.options.model.api,
      },
      scoring: {
        temperature: 1,
        topLogprobs: this.topLogprobs,
        minimumScaleTokens: this.minimumScaleTokens,
        extractionMode: this.mode,
        maxAnalysisTokens: this.maxAnalysisTokens,
        directTagMaxTokens: this.directTagMaxTokens,
        reasoningEffort: this.options.reasoningEffort ?? "off",
      },
    };
  }

  async assertCapabilities(signal?: AbortSignal): Promise<void> {
    if (this.mode === "prefill") {
      await this.scorePrefilledTag(
        "Return a score letter from A through T.",
        "Capability probe complete.",
        "<score_A>",
        signal,
      );
      return;
    }
    const prompt = buildPairwisePrompt({
      problem: "Capability probe: prefer the trajectory that explicitly reports a passing check.",
      trajectoryA: "Observed command: test\nObserved output: PASS",
      trajectoryB: "No verification was run.",
      criterion: {
        id: "probe",
        name: "Verification",
        description: "Prefer observed passing verification.",
      },
    });
    await this.scoreDirectTags(prompt, signal);
  }

  async scorePair(input: PairwisePromptInput, signal?: AbortSignal): Promise<SlotPairReward> {
    const prompt = buildPairwisePrompt(input);
    return this.mode === "prefill"
      ? this.scoreWithPrefill(prompt, signal)
      : this.scoreDirectTags(prompt, signal);
  }

  private async scoreDirectTags(prompt: string, signal?: AbortSignal): Promise<SlotPairReward> {
    const completion = await this.completeWithLogprobs(
      [{ role: "user", content: prompt, timestamp: Date.now() }],
      {
        signal,
        maxTokens: this.directTagMaxTokens,
        reasoningEffort: this.options.reasoningEffort,
      },
    );
    return {
      slotA: extractTaggedExpectation(completion, "<score_A>", {
        direction: "pairwise",
        minScaleTokens: this.minimumScaleTokens,
      }).value,
      slotB: extractTaggedExpectation(completion, "<score_B>", {
        direction: "pairwise",
        minScaleTokens: this.minimumScaleTokens,
      }).value,
    };
  }

  private async scoreWithPrefill(prompt: string, signal?: AbortSignal): Promise<SlotPairReward> {
    const analysisMessage = await this.complete(
      [{ role: "user", content: prompt, timestamp: Date.now() }],
      { signal, maxTokens: this.maxAnalysisTokens },
    );
    const analysis = stripScoreTags(extractText(analysisMessage));

    const scoreA = await this.scorePrefilledTag(prompt, analysis, "<score_A>", signal);
    const analysisWithA = `${analysis.trimEnd()}\n<score_A>${scoreA.sampledLetter}</score_A>`;
    const scoreB = await this.scorePrefilledTag(prompt, analysisWithA, "<score_B>", signal);
    return { slotA: scoreA.value, slotB: scoreB.value };
  }

  private async scorePrefilledTag(
    prompt: string,
    analysis: string,
    tag: "<score_A>" | "<score_B>",
    signal?: AbortSignal,
  ): Promise<PrefilledScore> {
    const prefix = `${analysis.trimEnd()}\n${tag}`;
    const completion = await this.completeWithLogprobs(
      [
        { role: "user", content: prompt, timestamp: Date.now() },
        prefillAssistantMessage(prefix, this.options.model),
      ],
      { signal, maxTokens: 1 },
      {
        add_generation_prompt: false,
        continue_final_message: true,
        structured_outputs: {
          choice: [...SCORE_LETTERS, ...SCORE_LETTERS.map((letter) => ` ${letter}`)],
        },
      },
    );
    const position = completion.positions[0];
    if (!position) throw new Error(`Verifier prefill produced no token position after ${tag}`);
    const expectation = requireExpectedScaleValue(position.alternatives, {
      direction: "pairwise",
      minScaleTokens: this.minimumScaleTokens,
    });
    const sampledLetter =
      normalizeScaleLetter(completion.text, "first-letter") ??
      normalizeScaleLetter(position.token, "first-letter");
    if (!sampledLetter) {
      throw new Error(`Verifier prefill produced an unreadable sampled score token after ${tag}`);
    }
    return { value: expectation.value, sampledLetter };
  }

  private async completeWithLogprobs(
    messages: Message[],
    options: VerifierCompletionOptions,
    payloadOverrides: JsonObject = {},
  ): Promise<VerifierCompletion> {
    const capture = new OpenAiSseLogprobCapture();
    const callerOnPayload = options.onPayload;
    const message = await this.complete(messages, {
      ...options,
      temperature: 1,
      fetch: capture.fetch,
      onPayload: async (payload, model) => {
        const transformed = callerOnPayload ? await callerOnPayload(payload, model) : undefined;
        return mergePayload(transformed ?? payload, {
          ...payloadOverrides,
          logprobs: true,
          top_logprobs: this.topLogprobs,
        });
      },
    });
    const responseGroups = await capture.finish();
    if (capture.requestCount === 0) {
      throw new UnsupportedVerifierModelError(
        "Pi did not route the verifier request through the supplied fetch implementation. " +
          `This provider path requires Pi ${MINIMUM_PI_LOGPROB_RUNTIME} or newer; ` +
          "sampled score labels are not accepted.",
      );
    }
    const positions = responseGroups.at(-1);
    if (!positions) {
      throw new Error("Verifier provider response contained no observable logprob stream");
    }
    return { text: extractText(message), positions };
  }

  private async complete(
    messages: Message[],
    options: VerifierCompletionOptions,
  ): Promise<AssistantMessage> {
    const message = await this.registry.complete(this.options.model, { messages }, options);
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      throw new Error(
        `Verifier request ${message.stopReason}: ${message.errorMessage ?? "provider returned no error detail"}`,
      );
    }
    return message;
  }
}

export function requirePiModelRegistry(registry: unknown): PiModelRegistryLike {
  if (!isObject(registry)) {
    throw new UnsupportedVerifierModelError("Pi model registry is unavailable");
  }
  const candidate = registry as MaybePiModelRegistry;
  if (typeof candidate.find !== "function" || typeof candidate.complete !== "function") {
    throw new UnsupportedVerifierModelError(
      `Native verifier inference requires Pi ${MINIMUM_PI_LOGPROB_RUNTIME} or newer, ` +
        "whose extension model registry exposes complete().",
    );
  }
  return registry as PiModelRegistryLike;
}

export function parseModelRef(ref: string): { provider: string; modelId: string } {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) {
    throw new Error(`Expected provider/model, got ${ref}`);
  }
  return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}

export function resolveVerifierModel(registry: PiModelRegistryLike, ref: string): Model<Api> {
  const parsed = parseModelRef(ref);
  const model = registry.find(parsed.provider, parsed.modelId);
  if (!model) throw new Error(`Verifier model not found: ${ref}`);
  return model;
}

function resolveExtractionMode(
  model: Model<Api>,
  mode: ScoreExtractionMode,
): Exclude<ScoreExtractionMode, "auto"> {
  if (mode !== "auto") return mode;
  return model.provider === "deepseek" || model.baseUrl.includes("api.deepseek.com")
    ? "direct-tags"
    : "prefill";
}

function extractText(message: AssistantMessage): string {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function stripScoreTags(text: string): string {
  const indices = [text.indexOf("<score_A>"), text.indexOf("<score_B>")].filter(
    (index) => index >= 0,
  );
  return indices.length ? text.slice(0, Math.min(...indices)).trimEnd() : text.trimEnd();
}

function prefillAssistantMessage(text: string, model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: zeroUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function mergePayload(payload: unknown, overrides: JsonObject): JsonObject {
  if (!isObject(payload)) {
    throw new Error("Pi verifier provider payload must be a JSON object");
  }
  return { ...payload, ...overrides };
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function positiveInteger(value: number | undefined, label: string): number {
  if (!Number.isInteger(value) || value === undefined || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
