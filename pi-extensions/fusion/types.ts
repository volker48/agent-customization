import type {
  Api,
  AssistantMessage,
  Message,
  Model,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";

export type ModelRef = string;
export type FusionStatus = "ok" | "degraded" | "error";
export type Confidence = "low" | "medium" | "high";
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export interface FusionReasoning {
  effort?: ReasoningEffort;
}

export interface WebSearchPolicy {
  numResults?: number;
  textMaxCharacters?: number;
  excludedDomains?: string[];
}

export interface WebFetchPolicy {
  strategy?: "direct" | "smart";
  maxChars?: number;
  blockedDomains?: string[];
}

export interface FusionConfig {
  judge: ModelRef;
  models: ModelRef[];
  maxToolCalls: number;
  maxCompletionTokens?: number;
  reasoning?: FusionReasoning;
  webSearch?: WebSearchPolicy;
  webfetch?: WebFetchPolicy;
  debugLogPath?: string;
  maxBinaryQuestions?: number;
}

export interface ToolUseSummary {
  name: string;
  ok: boolean;
}

export interface PanelResponse {
  model: ModelRef;
  runId: string;
  status: "ok";
  content: string;
  elapsedMs: number;
  toolCalls: ToolUseSummary[];
}

export interface FailedPanelResponse {
  model: ModelRef;
  runId: string;
  status: "error";
  error: string;
  elapsedMs: number;
  errorDetails?: { [key: string]: unknown };
}

export type AnyPanelResponse = PanelResponse | FailedPanelResponse;

export interface FusionAnalysis {
  consensus: string[];
  contradictions: string[];
  partialCoverage: string[];
  uniqueInsights: string[];
  blindSpots: string[];
  sourceQuality: string[];
  risks: string[];
}

export interface BinaryDimension {
  name: string;
  questions: string[];
}

export interface FusionJudgeOutput {
  questions: BinaryDimension[];
  panelScores: Record<ModelRef, Record<string, boolean[]>>;
  analysis: FusionAnalysis;
}

export interface FusionCapsuleProvenance {
  capsuleId: string;
  revision: number;
}

export interface FusionResult {
  status: FusionStatus;
  prompt: string;
  /** A bounded label used by the panel card instead of the effective prompt. */
  displayPrompt?: string;
  capsule?: FusionCapsuleProvenance;
  judge: ModelRef;
  responses: AnyPanelResponse[];
  judgeOutput?: FusionJudgeOutput;
  confidence?: Confidence;
  error?: string;
  elapsedMs: number;
}

export type FusionProgressEvent =
  | { phase: "resolving-models"; models: ModelRef[]; judge: ModelRef }
  | { phase: "panel-started"; model: ModelRef; panelRunId: string }
  | {
      phase: "panel-finished";
      model: ModelRef;
      panelRunId: string;
      status: "ok" | "error";
      elapsedMs: number;
      contentChars?: number;
      toolCalls?: ToolUseSummary[];
      error?: string;
      errorDetails?: { [key: string]: unknown };
    }
  | { phase: "meta-failed"; model: ModelRef; error: string }
  | { phase: "judge-started"; model: ModelRef }
  | { phase: "judge-failed"; model: ModelRef; elapsedMs: number; error: string }
  | { phase: "judge-finished"; model: ModelRef; elapsedMs: number; confidence: Confidence };

export interface ResolvedModel {
  ref: ModelRef;
  model: Model<Api>;
  apiKey: string;
  headers?: Record<string, string>;
}

/**
 * The subset of Pi's ModelRegistry that Fusion depends on.
 * getApiKeyAndHeaders resolves API keys, env vars, request headers, and
 * auto-refreshed OAuth/subscription tokens.
 */
export interface ModelRegistryLike {
  find(provider: string, model: string): Model<Api> | undefined;
  getApiKeyAndHeaders(
    model: Model<Api>,
  ): Promise<
    { ok: true; apiKey?: string; headers?: Record<string, string> } | { ok: false; error: string }
  >;
  isUsingOAuth?(model: Model<Api>): boolean;
}

export interface FusionTool {
  name: string;
  description: string;
  parameters: object;
  execute(call: ToolCall, signal: AbortSignal): Promise<ToolResultMessage>;
}

export interface CompletionClient {
  complete(args: {
    model: ResolvedModel;
    systemPrompt: string;
    messages: Message[];
    tools: FusionTool[];
    signal: AbortSignal;
    maxCompletionTokens?: number;
    reasoning?: FusionReasoning;
  }): Promise<AssistantMessage>;
}
