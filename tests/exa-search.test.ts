import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import exaSearchExtension from "../pi-extensions/exa-search.js";

type RegisteredTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: {
      query: string;
      numResults?: number;
      type?: "auto" | "fast" | "deep" | "instant";
      textMaxCharacters?: number;
    },
    signal: AbortSignal,
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
    details?: Record<string, unknown>;
  }>;
};

function createMockPi() {
  let tool: RegisteredTool | undefined;

  const pi = {
    registerTool(def: RegisteredTool) {
      tool = def;
    },
  };

  return {
    pi,
    getTool() {
      if (!tool) {
        throw new Error("Tool was not registered");
      }
      return tool;
    },
  };
}

describe("exa_search extension", () => {
  const originalApiKey = process.env.EXA_API_KEY;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env.EXA_API_KEY;
      return;
    }
    process.env.EXA_API_KEY = originalApiKey;
  });

  it("registers exa_search tool", () => {
    const { pi, getTool } = createMockPi();
    exaSearchExtension(pi as never);

    expect(getTool().name).toBe("exa_search");
  });

  it("returns a clear error when EXA_API_KEY is missing", async () => {
    delete process.env.EXA_API_KEY;

    const { pi, getTool } = createMockPi();
    exaSearchExtension(pi as never);

    const result = await getTool().execute(
      "call_1",
      { query: "latest AI news" },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("EXA_API_KEY is not set");
  });

  it("returns formatted search results on success", async () => {
    process.env.EXA_API_KEY = "test-key";

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          requestId: "req_123",
          resolvedSearchType: "neural",
          searchTime: 42,
          results: [
            {
              title: "Exa Blog",
              url: "https://exa.ai/blog",
              publishedDate: "2026-02-15",
              score: 0.99,
              text: "A post about search APIs for agents.",
            },
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const { pi, getTool } = createMockPi();
    exaSearchExtension(pi as never);

    const result = await getTool().execute(
      "call_2",
      { query: "exa search api", numResults: 1, type: "fast", textMaxCharacters: 300 },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("Exa search results for: exa search api");
    expect(result.content[0]?.text).toContain("Exa Blog");
    expect(result.content[0]?.text).toContain("https://exa.ai/blog");

    const fetchCall = fetchMock.mock.calls[0];
    expect(fetchCall?.[0]).toBe("https://api.exa.ai/search");

    const init = fetchCall?.[1] as RequestInit | undefined;
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      "Content-Type": "application/json",
      "x-api-key": "test-key",
    });
  });
});
