import { DEFAULT_MAX_BINARY_QUESTIONS } from "./config.js";
import { resolveModelRef } from "./model-ref.js";
import { FusionModelRunError, completeWithTools } from "./model-runner.js";
import {
  buildJudgePrompt,
  buildMetaPrompt,
  buildPanelPrompt,
  computeConfidence,
  emptyAnalysis,
  JUDGE_SYSTEM_PROMPT,
  META_SYSTEM_PROMPT,
  PANEL_SYSTEM_PROMPT,
  parseBinaryDimensions,
  parseMetaPromptOutput,
  stripCodeFence,
} from "./prompts.js";
import { createFusionTools } from "./tools.js";
import type {
  AnyPanelResponse,
  BinaryDimension,
  CompletionClient,
  FusionAnalysis,
  FusionConfig,
  FusionJudgeOutput,
  FusionProgressEvent,
  FusionResult,
  ModelRegistryLike,
  ModelRef,
  PanelResponse,
} from "./types.js";

export async function runFusion(args: {
  prompt: string;
  config: FusionConfig;
  registry: ModelRegistryLike;
  signal: AbortSignal;
  client?: CompletionClient;
  onProgress?: (event: FusionProgressEvent) => void;
}): Promise<FusionResult> {
  const started = Date.now();
  args.onProgress?.({
    phase: "resolving-models",
    models: args.config.models,
    judge: args.config.judge,
  });
  const judge = await resolveModelRef(args.registry, args.config.judge);
  const panelModels = await Promise.all(
    args.config.models.map((model) => resolveModelRef(args.registry, model)),
  );
  const tools = createFusionTools(args.config);

  const questionsPromise = runMetaPrompt({ ...args, judge, tools });
  const responsesPromise = Promise.all(
    panelModels.map(async (model) => runPanelModel({ ...args, model, tools })),
  );
  const [questions, responses] = await Promise.all([questionsPromise, responsesPromise]);
  const successes = responses.filter((response): response is PanelResponse => {
    return response.status === "ok";
  });

  if (successes.length === 0) {
    return {
      status: "error",
      prompt: args.prompt,
      judge: args.config.judge,
      responses,
      error: "All Fusion panel models failed",
      elapsedMs: Date.now() - started,
    };
  }

  const judgeStarted = Date.now();
  args.onProgress?.({ phase: "judge-started", model: args.config.judge });
  let judgeRun: Awaited<ReturnType<typeof completeWithTools>>;
  try {
    judgeRun = await completeWithTools({
      model: judge,
      systemPrompt: JUDGE_SYSTEM_PROMPT,
      userPrompt: buildJudgePrompt({ prompt: args.prompt, questions, responses }),
      tools,
      maxToolCalls: args.config.maxToolCalls,
      signal: args.signal,
      client: args.client,
      maxCompletionTokens: args.config.maxCompletionTokens,
      reasoning: args.config.reasoning,
    });
  } catch (error) {
    if (args.signal.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    args.onProgress?.({
      phase: "judge-failed",
      model: args.config.judge,
      elapsedMs: Date.now() - judgeStarted,
      error: message,
    });
    const panelCount = `${successes.length}/${responses.length}`;
    const failure = [
      `Fusion judge failed after ${panelCount} panel responses succeeded:`,
      message,
    ].join(" ");
    return {
      status: "error",
      prompt: args.prompt,
      judge: args.config.judge,
      responses,
      error: failure,
      elapsedMs: Date.now() - started,
    };
  }

  const judgeOutput = parseJudgeOutput(
    judgeRun.content,
    questions,
    successes.map((response) => response.model),
  );
  const confidence = computeConfidence(judgeOutput.panelScores);
  args.onProgress?.({
    phase: "judge-finished",
    model: args.config.judge,
    elapsedMs: Date.now() - judgeStarted,
    confidence,
  });

  return {
    status: successes.length === responses.length ? "ok" : "degraded",
    prompt: args.prompt,
    judge: args.config.judge,
    responses,
    judgeOutput,
    confidence,
    elapsedMs: Date.now() - started,
  };
}

async function runMetaPrompt(args: {
  prompt: string;
  config: FusionConfig;
  judge: Awaited<ReturnType<typeof resolveModelRef>>;
  signal: AbortSignal;
  tools: ReturnType<typeof createFusionTools>;
  client?: CompletionClient;
  onProgress?: (event: FusionProgressEvent) => void;
}): Promise<BinaryDimension[]> {
  try {
    const result = await completeWithTools({
      model: args.judge,
      systemPrompt: META_SYSTEM_PROMPT,
      userPrompt: buildMetaPrompt(
        args.prompt,
        args.config.maxBinaryQuestions ?? DEFAULT_MAX_BINARY_QUESTIONS,
      ),
      tools: [],
      maxToolCalls: 0,
      signal: args.signal,
      client: args.client,
      maxCompletionTokens: args.config.maxCompletionTokens,
      reasoning: args.config.reasoning,
    });
    const questions = parseMetaPromptOutput(
      result.content,
      args.config.maxBinaryQuestions ?? DEFAULT_MAX_BINARY_QUESTIONS,
    );
    if (questions.length === 0) {
      args.onProgress?.({
        phase: "meta-failed",
        model: args.config.judge,
        error: "meta-prompt returned no binary questions",
      });
    }
    return questions;
  } catch (error) {
    if (args.signal.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    args.onProgress?.({ phase: "meta-failed", model: args.config.judge, error: message });
    return [];
  }
}

async function runPanelModel(args: {
  prompt: string;
  config: FusionConfig;
  model: Awaited<ReturnType<typeof resolveModelRef>>;
  signal: AbortSignal;
  tools: ReturnType<typeof createFusionTools>;
  client?: CompletionClient;
  onProgress?: (event: FusionProgressEvent) => void;
}): Promise<AnyPanelResponse> {
  const started = Date.now();
  const runId = crypto.randomUUID();
  args.onProgress?.({ phase: "panel-started", model: args.model.ref, panelRunId: runId });
  try {
    const result = await completeWithTools({
      model: args.model,
      systemPrompt: PANEL_SYSTEM_PROMPT,
      userPrompt: buildPanelPrompt(args.prompt),
      tools: args.tools,
      maxToolCalls: args.config.maxToolCalls,
      signal: args.signal,
      client: args.client,
      maxCompletionTokens: args.config.maxCompletionTokens,
      reasoning: args.config.reasoning,
    });
    const response: AnyPanelResponse = {
      model: args.model.ref,
      runId,
      status: "ok",
      content: result.content,
      elapsedMs: Date.now() - started,
      toolCalls: result.toolCalls,
    };
    args.onProgress?.({
      phase: "panel-finished",
      model: args.model.ref,
      panelRunId: runId,
      status: response.status,
      elapsedMs: response.elapsedMs,
      contentChars: response.content.length,
      toolCalls: response.toolCalls,
    });
    return response;
  } catch (error) {
    if (args.signal.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const response: AnyPanelResponse = {
      model: args.model.ref,
      runId,
      status: "error",
      error: message,
      elapsedMs: Date.now() - started,
      errorDetails: error instanceof FusionModelRunError ? error.details : undefined,
    };
    args.onProgress?.({
      phase: "panel-finished",
      model: args.model.ref,
      panelRunId: runId,
      status: response.status,
      elapsedMs: response.elapsedMs,
      error: response.error,
      errorDetails: response.errorDetails,
    });
    return response;
  }
}

export function parseJudgeOutput(
  content: string,
  fallbackQuestions: BinaryDimension[] = [],
  validModels?: ModelRef[],
): FusionJudgeOutput {
  try {
    const parsed = JSON.parse(stripCodeFence(content)) as Partial<FusionJudgeOutput>;
    const parsedQuestions = parseBinaryDimensions(parsed.questions);
    const questions = parsedQuestions.length > 0 ? parsedQuestions : fallbackQuestions;
    return {
      questions,
      panelScores: parsePanelScores(parsed.panelScores, questions, validModels),
      analysis: parseAnalysis(parsed.analysis),
    };
  } catch {
    return { questions: fallbackQuestions, panelScores: {}, analysis: emptyAnalysis() };
  }
}

const ANALYSIS_KEYS = [
  "consensus",
  "contradictions",
  "partialCoverage",
  "uniqueInsights",
  "blindSpots",
  "sourceQuality",
  "risks",
] as const satisfies Array<keyof FusionAnalysis>;

function parseAnalysis(value: unknown): FusionAnalysis {
  const analysis = emptyAnalysis();
  if (!value || typeof value !== "object" || Array.isArray(value)) return analysis;
  const candidate = value as Partial<Record<keyof FusionAnalysis, unknown>>;
  for (const key of ANALYSIS_KEYS) analysis[key] = parseStringArray(candidate[key]);
  return analysis;
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function parsePanelScores(
  value: unknown,
  questions: BinaryDimension[],
  validModels: ModelRef[] | undefined,
): Record<ModelRef, Record<string, boolean[]>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const modelSet = validModels ? new Set(validModels) : undefined;
  const dimensionNames = new Map(
    questions.map((question) => [normalizeDimensionName(question.name), question.name]),
  );
  const output: Record<ModelRef, Record<string, boolean[]>> = {};
  for (const [model, dimensions] of Object.entries(value)) {
    if (modelSet && !modelSet.has(model)) continue;
    if (!dimensions || typeof dimensions !== "object" || Array.isArray(dimensions)) continue;
    const parsedDimensions: Record<string, boolean[]> = {};
    for (const [dimension, scores] of Object.entries(dimensions)) {
      const canonicalDimension = dimensionNames.get(normalizeDimensionName(dimension));
      if (dimensionNames.size > 0 && !canonicalDimension) continue;
      if (!Array.isArray(scores)) continue;
      parsedDimensions[canonicalDimension ?? dimension] = scores.map((score) => score === true);
    }
    if (Object.keys(parsedDimensions).length > 0) output[model] = parsedDimensions;
  }
  return output;
}

function normalizeDimensionName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}
