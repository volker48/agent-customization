import { resolveModelRef } from "./model-ref.js";
import { FusionModelRunError, completeWithTools } from "./model-runner.js";
import {
  buildJudgePrompt,
  buildPanelPrompt,
  emptyAnalysis,
  JUDGE_SYSTEM_PROMPT,
  PANEL_SYSTEM_PROMPT,
} from "./prompts.js";
import { createFusionTools } from "./tools.js";
import type {
  AnyPanelResponse,
  CompletionClient,
  FusionConfig,
  FusionJudgeOutput,
  FusionProgressEvent,
  FusionResult,
  ModelRegistryLike,
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

  const responses = await Promise.all(
    panelModels.map(async (model) => runPanelModel({ ...args, model, tools })),
  );
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
  const judgeRun = await completeWithTools({
    model: judge,
    systemPrompt: JUDGE_SYSTEM_PROMPT,
    userPrompt: buildJudgePrompt({ prompt: args.prompt, responses }),
    tools,
    maxToolCalls: args.config.maxToolCalls,
    signal: args.signal,
    client: args.client,
    maxCompletionTokens: args.config.maxCompletionTokens,
    reasoning: args.config.reasoning,
  });

  const judgeOutput = parseJudgeOutput(judgeRun.content);
  args.onProgress?.({
    phase: "judge-finished",
    model: args.config.judge,
    elapsedMs: Date.now() - judgeStarted,
    finalAnswerChars: judgeOutput.finalAnswer.length,
  });

  return {
    status: successes.length === responses.length ? "ok" : "degraded",
    prompt: args.prompt,
    judge: args.config.judge,
    responses,
    judgeOutput,
    elapsedMs: Date.now() - started,
  };
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

export function parseJudgeOutput(content: string): FusionJudgeOutput {
  try {
    const parsed = JSON.parse(stripCodeFence(content)) as Partial<FusionJudgeOutput>;
    if (typeof parsed.finalAnswer === "string" && isConfidence(parsed.confidence)) {
      return {
        analysis: { ...emptyAnalysis(), ...parsed.analysis },
        confidence: parsed.confidence,
        finalAnswer: parsed.finalAnswer,
      };
    }
  } catch {}

  return { analysis: emptyAnalysis(), confidence: "low", finalAnswer: content };
}

function stripCodeFence(content: string): string {
  return content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
}

function isConfidence(value: unknown): value is FusionJudgeOutput["confidence"] {
  return value === "low" || value === "medium" || value === "high";
}
