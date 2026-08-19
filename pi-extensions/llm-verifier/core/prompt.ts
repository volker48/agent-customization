import { PAIRWISE_SCALE_DESCRIPTION } from "./scale.js";
import type { Criterion } from "./types.js";

export const DEFAULT_CODING_CRITERIA: readonly Criterion[] = [
  {
    id: "task_correctness",
    name: "Task correctness",
    description:
      "Did the candidate address the actual root cause and completely satisfy the requested behavior?",
  },
  {
    id: "verification_evidence",
    name: "Verification evidence",
    description:
      "Do the observed commands and outputs convincingly verify the solution and guard against regressions?",
  },
  {
    id: "repository_fit",
    name: "Repository fit",
    description:
      "Is the patch appropriately scoped, compatible with the surrounding architecture, and compliant with repository constraints?",
  },
];

export interface PairwisePromptInput {
  problem: string;
  trajectoryA: string;
  trajectoryB: string;
  criterion: Criterion;
  groundTruthNote?: string;
  imageCount?: number;
}

export function buildPairwisePrompt(input: PairwisePromptInput): string {
  const imagesNote = input.imageCount
    ? `**Attached images:** ${input.imageCount} image(s) are attached to this message, in order; ` +
      "they are part of the task context.\n\n"
    : "";
  const note = input.groundTruthNote?.trim() ?? "";

  return (
    "You are an expert evaluator of AI coding agents. You will see a task description and two " +
    "agent trajectories, then evaluate them on ONE specific criterion, stated at the end.\n\n" +
    `${note}\n\n` +
    `**Task:**\n${input.problem}\n\n` +
    imagesNote +
    `**Trajectory A:**\n${input.trajectoryA}\n\n` +
    `**Trajectory B:**\n${input.trajectoryB}\n\n` +
    `**Rating Scale:**\n${PAIRWISE_SCALE_DESCRIPTION}\n\n` +
    `**Evaluation Guideline — ${input.criterion.name}:**\n${input.criterion.description}\n\n` +
    `Score each trajectory ONLY on this specific criterion ("${input.criterion.name}"). ` +
    "Ignore other aspects of the trajectory that are not relevant to it.\n\n" +
    "Reason it through first, then END your reply with exactly these two lines and nothing after them. " +
    "Replace each placeholder with a single letter A-T, keeping the spaces around the letter exactly as shown:\n" +
    "<score_A> LETTER_A_TO_T </score_A>\n" +
    "<score_B> LETTER_A_TO_T </score_B>\n\n" +
    "Begin your analysis now."
  );
}

export function formatProgressSteps(steps: readonly string[]): string {
  const parts: string[] = [];
  steps.forEach((step, index) => {
    parts.push(`=== Agent Step ${index + 1} ===`, step.trim(), "");
  });
  return parts.join("\n");
}

export interface ProgressPromptInput {
  problem: string;
  trajectoryText: string;
  stepCount: number;
  checkpointSteps: readonly number[];
  imageCount?: number;
}

export function buildProgressPrompt(input: ProgressPromptInput): string {
  const output = [
    "You are a strict, skeptical evaluator of agent task attempts. Agents routinely declare victory " +
      "while their environment still shows errors, edit the wrong target, or never actually run the " +
      "verification the task asks for. Trust observed output — NOT the agent's narration.",
    "",
    "**Task instruction:**",
    input.problem.trim(),
    "",
  ];
  if (input.imageCount) {
    output.push(
      `**Attached images:** ${input.imageCount} image(s) are attached to this message, in order. ` +
        'Markers like "[Image i attached]" in the trajectory refer to them; images without a marker are task context.',
      "",
    );
  }
  output.push(
    `**Agent trajectory (${input.stepCount} agent steps; each step is one action by the agent, with its observed output):**`,
    input.trajectoryText,
    "",
    `You will score the trajectory at ${input.checkpointSteps.length} CHECKPOINTS. The score measures exactly ONE thing:`,
    "",
    "    \"Given everything the agent has done up to and including this step, would the agent's CURRENT state " +
      "actually satisfy the task's hidden grader (i.e. produce the expected files / output / behavior the task requires)?\"",
    "",
    "Use the 20-letter A..T scale:",
    "  A = certainly NO — nothing useful done yet, or the agent is going down a clearly wrong path.",
    "  B-G = leans NO — partial work exists but key pieces are missing or broken.",
    "  H-M = uncertain — a plausible solution is taking shape, but no convincing verification yet.",
    "  N-S = leans YES — the right artifacts appear to be in place and partial verification has worked, with minor concerns.",
    "  T = essentially certain YES — the agent has run the relevant verification and the observed output literally matches what the task calls for, with no outstanding errors.",
    "",
    "CRITICAL CALIBRATION RULES:",
    "  * Effort, exploration, step count, and confident-sounding narration are NOT progress.",
    "  * Default to skepticism. A result with no real verification step should not exceed ~K, and even a verified-looking one should rarely exceed ~R unless verification clearly matches the task.",
    '  * Treat prose declarations ("done!", "all tests pass") as ZERO evidence. Ground the score in actual actions and output.',
    "",
    "EXPECTED PATTERNS — successive checkpoints do NOT have to rise:",
    "  * Genuine solutions typically rise from A toward T.",
    "  * Wrong approaches should PLATEAU once the wrong artifact is in place.",
    "  * Regressions should DECREASE the score.",
    "",
    "The checkpoints to score are:",
  );
  input.checkpointSteps.forEach((step, index) => {
    output.push(`  Checkpoint ${index + 1} = state right after Agent Step ${step}`);
  });
  output.push(
    "",
    "Score each checkpoint INDEPENDENTLY based on the agent's current best attempt at that point. " +
      `Output EXACTLY ${input.checkpointSteps.length} lines and nothing else, in the format:`,
  );
  input.checkpointSteps.forEach((_, index) => output.push(`<c${index + 1}>LETTER</c${index + 1}>`));
  output.push("", "where each LETTER is a single letter from A to T.");
  return output.join("\n");
}
