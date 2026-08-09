/**
 * Reusable Exa web search core.
 *
 * Shared by the standalone `exa_search` tool and the Fusion `web_search` tool so
 * both have identical search semantics. The standalone tool owns the parameter
 * schema and registration; this module owns the request/format/truncate logic.
 */

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";

export const EXA_API_URL = "https://api.exa.ai/search";
export const SEARCH_TYPES = ["auto", "fast", "deep", "instant"] as const;

export const DEFAULT_NUM_RESULTS = 5;
export const MIN_NUM_RESULTS = 1;
export const MAX_NUM_RESULTS = 10;

export const DEFAULT_TEXT_MAX_CHARACTERS = 1200;
export const MIN_TEXT_MAX_CHARACTERS = 200;
export const MAX_TEXT_MAX_CHARACTERS = 5000;

export const DEFAULT_SEARCH_TYPE = "auto";
const PREVIEW_TEXT_LENGTH = 280;

export type SearchType = (typeof SEARCH_TYPES)[number];

export interface ExaSearchInput {
  query: string;
  numResults?: number;
  type?: SearchType;
  textMaxCharacters?: number;
  excludeDomains?: string[];
}

export interface ExaSearchDetails {
  query: string;
  error?: string;
  requestId?: string;
  resultCount: number;
  requestedNumResults?: number;
  searchType?: SearchType;
  resolvedSearchType?: string;
  searchTimeMs?: number;
  textMaxCharacters?: number;
  costDollars?: { [key: string]: unknown };
  truncated: boolean;
}

interface ExaSearchResult {
  title: string | null;
  url: string;
  publishedDate?: string;
  score?: number;
  text?: string;
}

interface ExaSearchResponse {
  results: ExaSearchResult[];
  requestId: string;
  resolvedSearchType?: string;
  searchTime?: number;
  costDollars?: { [key: string]: unknown };
}

interface ExaSearchOptions {
  type: SearchType;
  numResults: number;
  contents: {
    text: {
      maxCharacters: number;
    };
  };
  excludeDomains?: string[];
}

export interface WebSearchToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: ExaSearchDetails;
  isError?: boolean;
}

function summarizeText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "No preview text returned.";
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength)}...`;
}

function formatResult(result: ExaSearchResult, index: number): string {
  const title = result.title?.trim() || "Untitled result";
  const lines = [`${index + 1}. ${title}`, `   URL: ${result.url}`];

  if (result.publishedDate) {
    lines.push(`   Published: ${result.publishedDate}`);
  }

  if (typeof result.score === "number") {
    lines.push(`   Score: ${result.score.toFixed(3)}`);
  }

  const snippet = summarizeText(result.text ?? "", PREVIEW_TEXT_LENGTH);
  lines.push(`   Snippet: ${snippet}`);

  return lines.join("\n");
}

function formatSearchResponse(query: string, response: ExaSearchResponse): string {
  if (response.results.length === 0) {
    return `No Exa results found for: ${query}`;
  }

  const header = [`Exa search results for: ${query}`, `Request ID: ${response.requestId}`, ""].join(
    "\n",
  );

  const formattedResults = response.results
    .map((result, index) => formatResult(result, index))
    .join("\n\n");

  return `${header}${formattedResults}`;
}

function applyOutputTruncation(text: string): { text: string; truncation: TruncationResult } {
  const truncation = truncateHead(text, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  if (!truncation.truncated) {
    return { text: truncation.content, truncation };
  }

  let output = truncation.content;
  output += "\n\n[Output truncated: showing ";
  output += `${truncation.outputLines} of ${truncation.totalLines} lines`;
  output += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;

  return { text: output, truncation };
}

function buildSearchOptions(input: ExaSearchInput): {
  searchType: SearchType;
  numResults: number;
  textMaxCharacters: number;
  options: ExaSearchOptions;
} {
  const searchType = input.type ?? DEFAULT_SEARCH_TYPE;
  const numResults = input.numResults ?? DEFAULT_NUM_RESULTS;
  const textMaxCharacters = input.textMaxCharacters ?? DEFAULT_TEXT_MAX_CHARACTERS;
  const excludeDomains =
    input.excludeDomains && input.excludeDomains.length > 0 ? input.excludeDomains : undefined;

  return {
    searchType,
    numResults,
    textMaxCharacters,
    options: {
      type: searchType,
      numResults,
      contents: {
        text: {
          maxCharacters: textMaxCharacters,
        },
      },
      ...(excludeDomains ? { excludeDomains } : {}),
    },
  };
}

function buildErrorDetails(query: string, message: string): ExaSearchDetails {
  return {
    query,
    error: message,
    resultCount: 0,
    truncated: false,
  };
}

async function parseErrorMessage(response: Response): Promise<string> {
  const raw = await response.text();
  if (!raw.trim()) {
    return `HTTP ${response.status} ${response.statusText}`;
  }

  try {
    const parsed = JSON.parse(raw) as { error?: string; message?: string };
    const details = [parsed.error, parsed.message].filter(Boolean).join(": ");
    return details || `HTTP ${response.status} ${response.statusText}`;
  } catch {
    return `${response.status} ${response.statusText}: ${raw}`;
  }
}

async function searchExa(
  apiKey: string,
  query: string,
  options: ExaSearchOptions,
  signal: AbortSignal,
): Promise<ExaSearchResponse> {
  const response = await fetch(EXA_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({ query, ...options }),
    signal,
  });

  if (!response.ok) {
    const message = await parseErrorMessage(response);
    throw new Error(`Exa API error: ${message}`);
  }

  return (await response.json()) as ExaSearchResponse;
}

function textResult(
  text: string,
  isError: boolean,
  details: ExaSearchDetails,
): WebSearchToolResult {
  return {
    content: [{ type: "text", text }],
    isError: isError || undefined,
    details,
  };
}

/**
 * Execute an Exa web search and return formatted, truncated tool output.
 *
 * @param input Search query and options.
 * @param signal Abort signal for cancellation.
 * @returns Tool result content plus structured search details.
 */
export async function executeWebSearch(
  input: ExaSearchInput,
  signal: AbortSignal,
): Promise<WebSearchToolResult> {
  const query = input.query.trim();
  if (!query) {
    return textResult(
      "query must not be empty",
      true,
      buildErrorDetails("", "query must not be empty"),
    );
  }

  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) {
    return textResult(
      "EXA_API_KEY is not set",
      true,
      buildErrorDetails(query, "EXA_API_KEY is not set"),
    );
  }

  if (signal.aborted) {
    return textResult("Search cancelled", true, buildErrorDetails(query, "Search cancelled"));
  }

  const { options, numResults, searchType, textMaxCharacters } = buildSearchOptions(input);

  try {
    const response = await searchExa(apiKey, query, options, signal);

    if (signal.aborted) {
      return textResult("Search cancelled", true, buildErrorDetails(query, "Search cancelled"));
    }

    const output = formatSearchResponse(query, response);
    const truncated = applyOutputTruncation(output);

    const details: ExaSearchDetails = {
      query,
      requestId: response.requestId,
      resultCount: response.results.length,
      requestedNumResults: numResults,
      searchType,
      resolvedSearchType: response.resolvedSearchType,
      searchTimeMs: response.searchTime,
      textMaxCharacters,
      costDollars: response.costDollars,
      truncated: truncated.truncation.truncated,
    };

    return { content: [{ type: "text", text: truncated.text }], details };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return textResult(`Exa search failed: ${message}`, true, buildErrorDetails(query, message));
  }
}
