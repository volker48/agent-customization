import type { FusionConfig, FusionProgressEvent } from "./types.js";

type PanelStatus = "pending" | "running" | "ok" | "error";
type JudgeStatus = "pending" | "running" | "ok";

export interface ProgressState {
  phase: string;
  judge: string;
  judgeStatus: JudgeStatus;
  panels: Map<string, PanelStatus>;
}

export function createProgressState(config?: FusionConfig): ProgressState {
  return {
    phase: config ? "resolving models" : "loading config",
    judge: config?.judge ?? "pending",
    judgeStatus: "pending",
    panels: new Map(config?.models.map((model) => [model, "pending"])),
  };
}

export function reduceProgress(state: ProgressState, event: FusionProgressEvent): ProgressState {
  switch (event.phase) {
    case "resolving-models":
      return {
        ...state,
        phase: "resolving models",
        judge: event.judge,
        panels: new Map(event.models.map((model) => [model, "pending"])),
      };
    case "panel-started": {
      const panels = new Map(state.panels);
      panels.set(event.model, "running");
      return { ...state, phase: "running panel", panels };
    }
    case "panel-finished": {
      const panels = new Map(state.panels);
      panels.set(event.model, event.status);
      return {
        ...state,
        panels,
        phase: allPanelsDone(panels) ? "running judge" : "running panel",
      };
    }
    case "judge-started":
      return { ...state, phase: "running judge", judge: event.model, judgeStatus: "running" };
    case "judge-finished":
      return { ...state, phase: "complete", judgeStatus: "ok" };
  }
}

export function formatProgress(state: ProgressState): string {
  const entries = [...state.panels.entries()];
  const done = entries.filter(([, status]) => status === "ok" || status === "error").length;
  const lines = [`Fusion: ${state.phase}`, `Panel: ${done}/${entries.length} complete`];
  for (const [model, status] of entries) {
    lines.push(`- ${statusIcon(status)} ${model}`);
  }
  lines.push(`Judge: ${statusIcon(state.judgeStatus)} ${state.judge}`);
  return lines.join("\n");
}

function statusIcon(status: PanelStatus): string {
  if (status === "ok") return "✓";
  if (status === "error") return "✗";
  if (status === "running") return "…";
  return "•";
}

function allPanelsDone(panels: Map<string, PanelStatus>): boolean {
  return [...panels.values()].every((status) => status === "ok" || status === "error");
}
