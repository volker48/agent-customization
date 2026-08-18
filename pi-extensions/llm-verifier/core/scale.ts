export const SCORE_LETTERS = [
  "A",
  "B",
  "C",
  "D",
  "E",
  "F",
  "G",
  "H",
  "I",
  "J",
  "K",
  "L",
  "M",
  "N",
  "O",
  "P",
  "Q",
  "R",
  "S",
  "T",
] as const;

export type ScoreLetter = (typeof SCORE_LETTERS)[number];
export type ScaleDirection = "pairwise" | "progress";
export type ScaleTokenMode = "exact" | "first-letter";

const SCORE_LETTER_SET = new Set<string>(SCORE_LETTERS);

export const PAIRWISE_SCALE_DESCRIPTION = [
  "Rate how likely the agent correctly solved the task on a 20-point scale using letters A through T:",
  "  A = clearly and completely succeeded with verified output (best)",
  "  B-D = succeeded with only minor issues",
  "  E-G = above average, mostly correct with some issues",
  "  H-J = uncertain, leans toward success",
  "  K-M = uncertain, leans toward failure",
  "  N-P = below average, significant issues remain",
  "  Q-S = failed with some partial progress",
  "  T = clearly and completely failed (worst)",
].join("\n");

export function normalizeScaleLetter(
  token: string,
  mode: ScaleTokenMode = "exact",
): ScoreLetter | undefined {
  let normalized = token.trimStart();
  while (normalized.startsWith(">")) normalized = normalized.slice(1).trimStart();
  if (!normalized) return undefined;

  const candidate = (mode === "first-letter" ? normalized[0] : normalized.trim()).toUpperCase();
  if (candidate.length !== 1 || !SCORE_LETTER_SET.has(candidate)) return undefined;
  return candidate as ScoreLetter;
}

export function scaleValue(letter: ScoreLetter, direction: ScaleDirection): number {
  const index = SCORE_LETTERS.indexOf(letter);
  if (index < 0) throw new Error(`Unknown score letter: ${letter}`);
  return direction === "pairwise"
    ? (SCORE_LETTERS.length - 1 - index) / (SCORE_LETTERS.length - 1)
    : index / (SCORE_LETTERS.length - 1);
}

export function pairwiseScaleValue(letter: ScoreLetter): number {
  return scaleValue(letter, "pairwise");
}

export function progressScaleValue(letter: ScoreLetter): number {
  return scaleValue(letter, "progress");
}
