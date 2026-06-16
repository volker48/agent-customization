import { buildSynthesisPrompt, emptyAnalysis } from "./prompts.js";
import type { FusionAnalysis, FusionResult } from "./types.js";

export const FUSION_MESSAGE_TYPE = "fusion-panel";

export interface FusionPanelDetails {
  prompt: string;
  judge: string;
  models: string[];
  analysis?: FusionAnalysis;
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

/**
 * Build the Fusion panel context message. Its `content` is the synthesis prompt
 * the active (calling) model reads to write the final answer; `details` drives
 * the compact card the TUI renders.
 */
export function toFusionPanelMessage(result: FusionResult) {
  const content = buildSynthesisPrompt({
    prompt: result.prompt,
    analysis: result.judgeOutput?.analysis ?? emptyAnalysis(),
    confidence: result.judgeOutput?.confidence ?? "low",
    responses: result.responses,
  });
  return {
    customType: FUSION_MESSAGE_TYPE,
    content,
    display: true,
    details: toFusionDetails(result),
  };
}

export function toFusionDetails(result: FusionResult): FusionPanelDetails {
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

export function renderFusionPanelMarkdown(
  details: FusionPanelDetails | undefined,
  expanded: boolean,
): string {
  if (!details) return "🔀 **Fusion panel** — synthesizing final answer below…";

  const okCount = details.panelResponses.filter((r) => r.status === "ok").length;
  const summary = [
    "🔀 **Fusion panel**",
    `${okCount}/${details.panelResponses.length} models`,
    `judge ${details.judge}`,
    `confidence ${details.confidence ?? "unknown"}`,
  ].join(" · ");

  if (!expanded) {
    return `${summary}\n\n_The answer below is synthesized from this panel._`;
  }

  const panelLines = details.panelResponses.map((response) => {
    const status = response.status === "ok" ? "ok" : `error: ${response.error ?? "unknown"}`;
    return `  - ${response.model} (${status}, ${response.elapsedMs}ms)`;
  });

  return [
    summary,
    "",
    "---",
    "**Fusion details**",
    "",
    `- Elapsed: ${details.elapsedMs}ms`,
    "- Panel:",
    ...panelLines,
    ...renderAnalysisLines(details.analysis),
  ].join("\n");
}

function renderAnalysisLines(analysis: FusionAnalysis | undefined): string[] {
  if (!analysis) return [];
  const sections: Array<[string, string[]]> = [
    ["Consensus", analysis.consensus],
    ["Blind spots", analysis.blindSpots],
    ["Risks", analysis.risks],
  ];
  const lines: string[] = [];
  for (const [label, items] of sections) {
    if (items.length === 0) continue;
    lines.push(`- ${label}:`);
    for (const item of items) lines.push(`  - ${item}`);
  }
  return lines;
}
