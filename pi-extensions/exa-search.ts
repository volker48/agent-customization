import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_NUM_RESULTS,
  DEFAULT_TEXT_MAX_CHARACTERS,
  type ExaSearchInput,
  executeWebSearch,
  MAX_NUM_RESULTS,
  MAX_TEXT_MAX_CHARACTERS,
  MIN_NUM_RESULTS,
  MIN_TEXT_MAX_CHARACTERS,
  SEARCH_TYPES,
} from "./lib/exa-search-core.js";

const ExaSearchParams = Type.Object({
  query: Type.String({
    description: "Search query for Exa web search",
    minLength: 1,
  }),
  numResults: Type.Optional(
    Type.Integer({
      description: `Number of search results to return (default: ${DEFAULT_NUM_RESULTS})`,
      minimum: MIN_NUM_RESULTS,
      maximum: MAX_NUM_RESULTS,
    }),
  ),
  type: Type.Optional(StringEnum(SEARCH_TYPES)),
  textMaxCharacters: Type.Optional(
    Type.Integer({
      description: `Max text chars fetched per result (default: ${DEFAULT_TEXT_MAX_CHARACTERS})`,
      minimum: MIN_TEXT_MAX_CHARACTERS,
      maximum: MAX_TEXT_MAX_CHARACTERS,
    }),
  ),
});

export default function exaSearchExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "exa_search",
    label: "Exa Search",
    description:
      "Search the web with Exa. Returns ranked links with URL, metadata, and a short text snippet.",
    parameters: ExaSearchParams,

    async execute(_toolCallId, params, signal) {
      return executeWebSearch(params as ExaSearchInput, signal);
    },
  });
}
