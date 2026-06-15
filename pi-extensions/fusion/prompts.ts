import type { AnyPanelResponse, FusionAnalysis, ModelRef, PanelResponse } from "./types.js";

export const PANEL_SYSTEM_PROMPT = `You are an independent Fusion panel model.
Answer only the user's task. You may use web_search and webfetch when useful.
Do not assume access to previous conversation, project files, or local tools.`;

export function buildPanelPrompt(prompt: string): string {
  return prompt;
}

export const JUDGE_SYSTEM_PROMPT = `You are a fusion judge synthesizing independent model responses.

Your job is not to vote and not to average responses. Compare them.

Evaluate factual accuracy, source support, depth, contradictions, unique insights, blind spots,
and source quality. Use web_search and webfetch only when needed to verify disputed, current,
or high-impact claims. Do not introduce unsupported claims. Prefer primary sources. Penalize
confident but uncited factual claims.

Return only valid JSON with this shape:
{
  "analysis": {
    "consensus": [],
    "contradictions": [],
    "partialCoverage": [],
    "uniqueInsights": [],
    "blindSpots": [],
    "sourceQuality": [],
    "risks": []
  },
  "confidence": "low|medium|high",
  "finalAnswer": "A complete answer to the user, with citations where appropriate."
}`;

export function buildJudgePrompt(args: { prompt: string; responses: AnyPanelResponse[] }): string {
  const successful = args.responses.filter((response): response is PanelResponse => {
    return response.status === "ok";
  });
  const failed = args.responses.filter((response) => response.status === "error");

  return [
    "Original user task:",
    args.prompt,
    "",
    "Successful panel responses:",
    ...successful.map(formatPanelResponse),
    "",
    "Failed panel models:",
    failed.length === 0 ? "None" : failed.map((r) => `- ${r.model}: ${r.error}`).join("\n"),
  ].join("\n");
}

export function emptyAnalysis(): FusionAnalysis {
  return {
    consensus: [],
    contradictions: [],
    partialCoverage: [],
    uniqueInsights: [],
    blindSpots: [],
    sourceQuality: [],
    risks: [],
  };
}

function formatPanelResponse(response: { model: ModelRef; content: string }): string {
  return `\n---\nModel: ${response.model}\n${response.content}\n---`;
}
