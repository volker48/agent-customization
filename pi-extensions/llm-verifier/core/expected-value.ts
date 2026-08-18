import {
  normalizeScaleLetter,
  scaleValue,
  type ScaleDirection,
  type ScaleTokenMode,
  type ScoreLetter,
} from "./scale.js";
import type {
  ScaleExpectation,
  ScaleProbability,
  TokenAlternative,
  TokenPositionDistribution,
  VerifierCompletion,
} from "./types.js";

export class MissingScoreDistributionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingScoreDistributionError";
  }
}

export interface ExpectedValueOptions {
  direction: ScaleDirection;
  tokenMode?: ScaleTokenMode;
  minScaleTokens?: number;
}

export function expectedScaleValue(
  alternatives: readonly TokenAlternative[],
  options: ExpectedValueOptions,
): ScaleExpectation | undefined {
  const bestLogprobByLetter = new Map<ScoreLetter, number>();
  for (const alternative of alternatives) {
    if (!Number.isFinite(alternative.logprob)) continue;
    const letter = normalizeScaleLetter(alternative.token, options.tokenMode);
    if (!letter) continue;
    const previous = bestLogprobByLetter.get(letter);
    if (previous === undefined || alternative.logprob > previous) {
      bestLogprobByLetter.set(letter, alternative.logprob);
    }
  }
  if (bestLogprobByLetter.size === 0) return undefined;

  const maximum = Math.max(...bestLogprobByLetter.values());
  const weights = [...bestLogprobByLetter.entries()].map(([letter, logprob]) => ({
    letter,
    weight: Math.exp(logprob - maximum),
  }));
  const total = weights.reduce((sum, item) => sum + item.weight, 0);
  if (!(total > 0) || !Number.isFinite(total)) return undefined;

  const probabilities: ScaleProbability[] = weights
    .map(({ letter, weight }) => ({ letter, probability: weight / total }))
    .sort((left, right) => left.letter.localeCompare(right.letter));
  const value = probabilities.reduce(
    (sum, item) =>
      sum + scaleValue(item.letter as ScoreLetter, options.direction) * item.probability,
    0,
  );

  return {
    value,
    scaleTokenCount: probabilities.length,
    probabilities,
  };
}

export function requireExpectedScaleValue(
  alternatives: readonly TokenAlternative[],
  options: ExpectedValueOptions,
): ScaleExpectation {
  const expectation = expectedScaleValue(alternatives, options);
  const minimum = options.minScaleTokens ?? 1;
  if (!expectation) {
    throw new MissingScoreDistributionError("Verifier returned no usable A-T token alternatives");
  }
  if (expectation.scaleTokenCount < minimum) {
    throw new MissingScoreDistributionError(
      `Verifier returned only ${expectation.scaleTokenCount} usable A-T token alternative(s); ` +
        `${minimum} required to avoid discrete-label scoring`,
    );
  }
  return expectation;
}

export function findPositionAfterTag(
  positions: readonly TokenPositionDistribution[],
  tag: string,
): TokenPositionDistribution | undefined {
  if (!tag.endsWith(">")) throw new Error(`Expected a closing angle bracket in tag: ${tag}`);

  let latestPositionIndex = -1;
  let textSoFar = "";
  for (let index = 0; index < positions.length; index += 1) {
    textSoFar += positions[index].token;
    const trimmed = textSoFar.trimEnd();
    if (
      (trimmed.endsWith(tag) || trimmed.endsWith(tag.slice(0, -1))) &&
      index + 1 < positions.length
    ) {
      latestPositionIndex = index + 1;
    }
  }
  return latestPositionIndex >= 0 ? positions[latestPositionIndex] : undefined;
}

export function extractTaggedExpectation(
  completion: VerifierCompletion,
  tag: string,
  options: ExpectedValueOptions,
): ScaleExpectation {
  const position = findPositionAfterTag(completion.positions, tag);
  if (!position) {
    throw new MissingScoreDistributionError(
      `Verifier response has no token distribution after ${tag}`,
    );
  }
  return requireExpectedScaleValue(position.alternatives, options);
}

/** Diagnostic-only parser. Primary verifier scoring must not call this as a fallback. */
export function parseTaggedSampledLetter(text: string, tag: string): ScoreLetter | undefined {
  const tagName = tag.replace(/[<>]/g, "");
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<${escaped}>\\s*([A-Ta-t])\\s*</${escaped}>`, "gi");
  let last: RegExpExecArray | null = null;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) last = match;
  return last ? normalizeScaleLetter(last[1]) : undefined;
}
