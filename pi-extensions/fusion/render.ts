import type { FusionResult } from "./types.js";

export const FUSION_MESSAGE_TYPE = "fusion-result";

export interface FusionResultDetails {
  prompt: string;
  judge: string;
  models: string[];
  analysis: unknown;
  panelResponses: Array<{
    model: string;
    status: "ok" | "error";
    elapsedMs: number;
    error?: string;
    content?: string;
  }>;
  elapsedMs: number;
  confidence?: string;
}

export function toFusionMessage(result: FusionResult) {
  const finalAnswer = result.judgeOutput?.finalAnswer ?? result.error ?? "Fusion failed";
  return {
    customType: FUSION_MESSAGE_TYPE,
    content: finalAnswer,
    display: true,
    details: toFusionDetails(result),
  };
}

export function toFusionDetails(result: FusionResult): FusionResultDetails {
  return {
    prompt: result.prompt,
    judge: result.judge,
    models: result.responses.map((response) => response.model),
    analysis: result.judgeOutput?.analysis,
    panelResponses: result.responses.map((response) => ({
      model: response.model,
      status: response.status,
      elapsedMs: response.elapsedMs,
      error: response.status === "error" ? response.error : undefined,
      content: response.status === "ok" ? response.content : undefined,
    })),
    elapsedMs: result.elapsedMs,
    confidence: result.judgeOutput?.confidence,
  };
}

export function renderFusionMarkdown(
  content: string,
  details: FusionResultDetails | undefined,
  expanded: boolean,
): string {
  if (!expanded || !details) return content;

  const panelLines = details.panelResponses.map((response) => {
    const status = response.status === "ok" ? "ok" : `error: ${response.error ?? "unknown"}`;
    return `  - ${response.model} (${status}, ${response.elapsedMs}ms)`;
  });

  return [
    content,
    "",
    "---",
    "**Fusion details**",
    "",
    `- Judge: ${details.judge}`,
    `- Confidence: ${details.confidence ?? "unknown"}`,
    `- Elapsed: ${details.elapsedMs}ms`,
    "- Panel:",
    ...panelLines,
  ].join("\n");
}
