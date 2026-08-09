import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { createFusionTools } from "../pi-extensions/fusion/tools.js";
import type { FusionConfig, FusionTool } from "../pi-extensions/fusion/types.js";

const baseConfig: FusionConfig = {
  judge: "anthropic/claude-opus-4-8",
  models: ["openai/gpt-5"],
  maxToolCalls: 4,
};

function toolCall(name: string, args: { [key: string]: unknown }): ToolCall {
  return { type: "toolCall", id: `${name}-1`, name, arguments: args };
}

function getTool(name: string, config: FusionConfig = baseConfig): FusionTool {
  const tool = createFusionTools(config).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing Fusion tool: ${name}`);
  return tool;
}

function firstText(result: ToolResultMessage): string {
  const part = result.content[0];
  if (part?.type !== "text") throw new Error("Expected text tool result");
  return part.text;
}

describe("createFusionTools", () => {
  it("exposes only the restricted Fusion web tools", () => {
    expect(createFusionTools(baseConfig).map((tool) => tool.name)).toEqual([
      "web_search",
      "webfetch",
    ]);
  });

  it("returns a tool error for empty web_search queries without making a network call", async () => {
    const search = getTool("web_search");

    const result = await search.execute(
      toolCall("web_search", { query: "   " }),
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("query must not be empty");
  });

  it("blocks configured webfetch domains and subdomains before fetching", async () => {
    const fetchTool = getTool("webfetch", {
      ...baseConfig,
      webfetch: { blockedDomains: ["example.com"] },
    });

    const result = await fetchTool.execute(
      toolCall("webfetch", { url: "https://docs.example.com/page" }),
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("Blocked domain: https://docs.example.com/page");
  });

  it("rejects non-HTTP webfetch schemes through the shared fetch core", async () => {
    const fetchTool = getTool("webfetch");

    const result = await fetchTool.execute(
      toolCall("webfetch", { url: "file:///etc/passwd" }),
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("Unsupported URL scheme: file:");
  });

  it("rejects private webfetch hosts through the shared fetch core", async () => {
    const fetchTool = getTool("webfetch");

    const result = await fetchTool.execute(
      toolCall("webfetch", { url: "http://127.0.0.1:8080/" }),
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("Blocked private IP host: 127.0.0.1");
  });
});
