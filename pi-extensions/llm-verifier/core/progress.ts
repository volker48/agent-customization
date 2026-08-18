import { expectedScaleValue, findPositionAfterTag } from "./expected-value.js";
import type { VerifierCompletion } from "./types.js";

export function extractProgressScores(
  completion: VerifierCompletion,
  checkpointCount: number,
  minimumScaleTokens = 2,
): Array<number | null> {
  if (!Number.isInteger(checkpointCount) || checkpointCount < 1) {
    throw new Error("checkpointCount must be a positive integer");
  }
  return Array.from({ length: checkpointCount }, (_, index) => {
    const tag = `<c${index + 1}>`;
    const position = findPositionAfterTag(completion.positions, tag);
    if (!position) return null;
    const expectation = expectedScaleValue(position.alternatives, {
      direction: "progress",
      tokenMode: "first-letter",
    });
    if (!expectation || expectation.scaleTokenCount < minimumScaleTokens) return null;
    return expectation.value;
  });
}

export function averageProgressRepetitions(
  repetitions: readonly (readonly (number | null)[])[],
): Array<number | null> {
  if (repetitions.length === 0) throw new Error("Need at least one progress repetition");
  const width = repetitions[0].length;
  if (repetitions.some((repetition) => repetition.length !== width)) {
    throw new Error("Progress repetitions have different checkpoint counts");
  }
  return Array.from({ length: width }, (_, checkpoint) => {
    const values = repetitions
      .map((repetition) => repetition[checkpoint])
      .filter((value): value is number => value !== null);
    return values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : null;
  });
}
