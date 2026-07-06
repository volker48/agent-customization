import { Type } from "@earendil-works/pi-ai";
import type { TextContent, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { MAX_NUM_RESULTS, MIN_NUM_RESULTS, executeWebSearch } from "../lib/exa-search-core.js";
import {
  MAX_MAX_CHARS,
  MIN_MAX_CHARS,
  executeWebfetch,
  type WebFetchInput,
} from "../lib/webfetch-core.js";
import type { FusionConfig, FusionTool } from "./types.js";

export function createFusionTools(config: FusionConfig): FusionTool[] {
  return [createWebSearchTool(config), createWebfetchTool(config)];
}

function createWebSearchTool(config: FusionConfig): FusionTool {
  return {
    name: "web_search",
    description: "Search the web and return ranked links with snippets.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1 }),
      numResults: Type.Optional(
        Type.Integer({ minimum: MIN_NUM_RESULTS, maximum: MAX_NUM_RESULTS }),
      ),
    }),
    async execute(call, signal) {
      const result = await executeWebSearch(
        {
          query: stringArg(call, "query"),
          numResults: numberArg(call, "numResults") ?? config.webSearch?.numResults,
          textMaxCharacters: config.webSearch?.textMaxCharacters,
          excludeDomains: config.webSearch?.excludedDomains,
        },
        signal,
      );
      return toToolResult(call, result.content, result.isError ?? false);
    },
  };
}

function createWebfetchTool(config: FusionConfig): FusionTool {
  return {
    name: "webfetch",
    description: "Fetch HTTP(S) text; handles GitHub links and URL #fragments directly.",
    parameters: Type.Object({
      url: Type.String({ minLength: 1 }),
      maxChars: Type.Optional(Type.Integer({ minimum: MIN_MAX_CHARS, maximum: MAX_MAX_CHARS })),
    }),
    async execute(call, signal) {
      const url = stringArg(call, "url").trim();
      const blocked = config.webfetch?.blockedDomains;
      if (blocked && blocked.length > 0 && isBlockedDomain(url, blocked)) {
        return toToolResult(call, [{ type: "text", text: `Blocked domain: ${url}` }], true);
      }

      const input: WebFetchInput = {
        url,
        maxChars: numberArg(call, "maxChars") ?? config.webfetch?.maxChars,
        strategy: config.webfetch?.strategy,
      };
      const result = await executeWebfetch(input, signal);
      return toToolResult(call, result.content, result.isError ?? false);
    },
  };
}

function isBlockedDomain(rawUrl: string, blockedDomains: string[]): boolean {
  let hostname: string;
  try {
    const normalized = /^[a-z][a-z0-9+.-]*:/i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    hostname = new URL(normalized).hostname.toLowerCase();
  } catch {
    return false;
  }
  return blockedDomains.some((domain) => {
    const target = domain.toLowerCase();
    return hostname === target || hostname.endsWith(`.${target}`);
  });
}

function stringArg(call: ToolCall, name: string): string {
  const value = call.arguments[name];
  return typeof value === "string" ? value : "";
}

function numberArg(call: ToolCall, name: string): number | undefined {
  const value = call.arguments[name];
  return typeof value === "number" ? value : undefined;
}

function toToolResult(
  call: ToolCall,
  content: Array<{ type: "text"; text: string }>,
  isError: boolean,
): ToolResultMessage {
  const text: TextContent[] = content.map((part) => ({ type: "text", text: part.text }));
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: text.length > 0 ? text : [{ type: "text", text: "(empty)" }],
    isError,
    timestamp: Date.now(),
  };
}
