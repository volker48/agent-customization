import { buildSynthesisPrompt, computePassRate, emptyAnalysis } from "./prompts.js";
import type { BinaryDimension, FusionAnalysis, FusionResult } from "./types.js";

export const FUSION_MESSAGE_TYPE = "fusion-panel";

export interface FusionPanelDetails {
  status: FusionResult["status"];
  prompt: string;
  judge: string;
  models: string[];
  analysis?: FusionAnalysis;
  questions?: BinaryDimension[];
  panelScores?: Record<string, Record<string, boolean[]>>;
  panelResponses: Array<{
    model: string;
    status: "ok" | "error";
    elapsedMs: number;
    error?: string;
    content?: string;
  }>;
  elapsedMs: number;
  confidence?: string;
  error?: string;
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
    confidence: result.confidence ?? "low",
    responses: result.responses,
    warning: recoveryWarning(result),
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
    status: result.status,
    prompt: result.prompt,
    judge: result.judge,
    models: result.responses.map((response) => response.model),
    analysis: result.judgeOutput?.analysis,
    questions: result.judgeOutput?.questions,
    panelScores: result.judgeOutput?.panelScores,
    panelResponses: result.responses.map((response) => ({
      model: response.model,
      status: response.status,
      elapsedMs: response.elapsedMs,
      error: response.status === "error" ? response.error : undefined,
      content: response.status === "ok" ? response.content : undefined,
    })),
    elapsedMs: result.elapsedMs,
    confidence: result.confidence,
    error: result.error,
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
    details.status === "error" ? "judge failed" : `confidence ${details.confidence ?? "unknown"}`,
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
    ...renderErrorLines(details),
    "- Panel:",
    ...panelLines,
    ...renderBinaryScoreLines(details),
    ...renderAnalysisLines(details.analysis),
  ].join("\n");
}

function recoveryWarning(result: FusionResult): string | undefined {
  const successfulPanels = result.responses.filter((response) => response.status === "ok").length;
  if (result.status !== "error" || successfulPanels === 0) return undefined;
  const panelCount = `${successfulPanels}/${result.responses.length}`;
  const prefix = `Fusion judge failed after ${panelCount} panel responses succeeded`;
  const judgeFailure = result.error?.startsWith(prefix)
    ? result.error.slice(prefix.length).replace(/^:\s*/, "")
    : result.error;
  return [
    `The ${prefix}.`,
    judgeFailure ? `Judge failure: ${judgeFailure}` : undefined,
    "Write a best-effort answer from the successful panel responses.",
    "Note the missing judge analysis when it affects confidence.",
  ]
    .filter((line): line is string => Boolean(line))
    .join(" ");
}

function renderErrorLines(details: FusionPanelDetails): string[] {
  if (details.status !== "error" || !details.error) return [];
  return [`- Error: ${details.error}`];
}

function renderBinaryScoreLines(details: FusionPanelDetails): string[] {
  const questions = details.questions ?? [];
  const panelScores = details.panelScores;
  if (questions.length === 0 || !panelScores) return [];

  const lines = ["- Binary questions:"];
  for (const dimension of questions) {
    lines.push(`  - ${dimension.name}: ${dimension.questions.length} questions`);
    for (const question of dimension.questions) lines.push(`    - ${question}`);
  }

  lines.push("- Binary scores:");
  for (const [model, dimensions] of Object.entries(panelScores)) {
    lines.push(`  - ${model}:`);
    for (const dimension of questions) {
      const scores = dimensions[dimension.name] ?? [];
      const passed = scores.filter(Boolean).length;
      lines.push(`    - ${dimension.name}: ${passed}/${scores.length}`);
    }
  }

  const rate = computePassRate(panelScores);
  if (details.confidence && rate !== undefined) {
    const percent = Math.round(rate * 100);
    lines.push(`- Confidence: ${details.confidence} (${percent}% questions passed across panels)`);
  }

  return lines;
}

function renderAnalysisLines(analysis: FusionAnalysis | undefined): string[] {
  if (!analysis) return [];
  const sections: Array<[string, string[]]> = [
    ["Consensus", analysis.consensus],
    ["Contradictions", analysis.contradictions],
    ["Partial coverage", analysis.partialCoverage],
    ["Unique insights", analysis.uniqueInsights],
    ["Blind spots", analysis.blindSpots],
    ["Source quality", analysis.sourceQuality],
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
