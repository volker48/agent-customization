import type { TokenAlternative, TokenPositionDistribution } from "../core/types.js";

interface OpenAiTopLogprob {
  token?: unknown;
  logprob?: unknown;
}

interface OpenAiLogprobPosition {
  token?: unknown;
  logprob?: unknown;
  top_logprobs?: unknown;
}

interface OpenAiChoice {
  logprobs?: unknown;
}

interface OpenAiChunk {
  choices?: unknown;
}

export function parseOpenAiSseLogprobs(text: string): TokenPositionDistribution[] {
  const positions: TokenPositionDistribution[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") continue;
    const parsed = JSON.parse(data) as unknown;
    positions.push(...extractPositions(parsed));
  }
  return positions;
}

export class OpenAiSseLogprobCapture {
  readonly fetch: typeof globalThis.fetch;
  private readonly pending: Promise<void>[] = [];
  private readonly responseGroups: TokenPositionDistribution[][] = [];
  private requests = 0;

  constructor(baseFetch: typeof globalThis.fetch = globalThis.fetch) {
    this.fetch = async (input, init) => {
      this.requests += 1;
      const response = await baseFetch(input, init);
      if (response.body) {
        const clone = response.clone();
        const pending = clone.text().then((text) => {
          this.responseGroups.push(parseOpenAiSseLogprobs(text));
        });
        this.pending.push(pending);
      }
      return response;
    };
  }

  get requestCount(): number {
    return this.requests;
  }

  async finish(): Promise<TokenPositionDistribution[][]> {
    await Promise.all(this.pending);
    return this.responseGroups.map((group) => [...group]);
  }
}

function extractPositions(value: unknown): TokenPositionDistribution[] {
  if (!isObject(value)) return [];
  const chunk = value as OpenAiChunk;
  if (!Array.isArray(chunk.choices) || chunk.choices.length === 0) return [];
  const choice = chunk.choices[0] as OpenAiChoice;
  if (!isObject(choice) || !isObject(choice.logprobs)) return [];
  const content = (choice.logprobs as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((raw) => parsePosition(raw));
}

function parsePosition(value: unknown): TokenPositionDistribution[] {
  if (!isObject(value)) return [];
  const position = value as OpenAiLogprobPosition;
  if (typeof position.token !== "string") return [];
  const alternatives: TokenAlternative[] = [];
  if (Array.isArray(position.top_logprobs)) {
    for (const rawAlternative of position.top_logprobs) {
      if (!isObject(rawAlternative)) continue;
      const alternative = rawAlternative as OpenAiTopLogprob;
      if (typeof alternative.token === "string" && typeof alternative.logprob === "number") {
        alternatives.push({ token: alternative.token, logprob: alternative.logprob });
      }
    }
  }
  if (alternatives.length === 0 && typeof position.logprob === "number") {
    alternatives.push({ token: position.token, logprob: position.logprob });
  }
  return [
    {
      token: position.token,
      logprob: typeof position.logprob === "number" ? position.logprob : undefined,
      alternatives,
    },
  ];
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
