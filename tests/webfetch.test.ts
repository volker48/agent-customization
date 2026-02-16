import { access, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import webfetchExtension from "../pi-extensions/webfetch.js";

type WebFetchParams = {
  url: string;
  maxChars?: number;
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  details?: Record<string, unknown>;
};

type RegisteredTool = {
  name: string;
  execute: (toolCallId: string, params: WebFetchParams, signal: AbortSignal) => Promise<ToolResult>;
};

type WebFetchTestDetails = {
  requestedUrl: string;
  resolvedUrl: string;
  status: number;
  statusText: string;
  contentType: string;
  truncated: boolean;
  fullOutputPath?: string;
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

describe("webfetch extension", () => {
  const originalPrivateHostOverride = process.env.WEBFETCH_ALLOW_PRIVATE_HOSTS;

  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.WEBFETCH_ALLOW_PRIVATE_HOSTS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalPrivateHostOverride === undefined) {
      delete process.env.WEBFETCH_ALLOW_PRIVATE_HOSTS;
      return;
    }
    process.env.WEBFETCH_ALLOW_PRIVATE_HOSTS = originalPrivateHostOverride;
  });

  it("registers webfetch tool", () => {
    const { pi, getTool } = createMockPi();
    webfetchExtension(pi as never);

    expect(getTool().name).toBe("webfetch");
  });

  it("marks invalid URLs as errors", async () => {
    const { pi, getTool } = createMockPi();
    webfetchExtension(pi as never);

    const result = await getTool().execute(
      "call_invalid",
      { url: "?" },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Web fetch failed");
    expect(result.content[0]?.text).toContain("Status: 400 Bad Request");
  });

  it("rejects unsupported schemes instead of rewriting them", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const { pi, getTool } = createMockPi();
    webfetchExtension(pi as never);

    const result = await getTool().execute(
      "call_scheme",
      { url: "ftp://example.com" },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Unsupported URL scheme: ftp:");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("marks non-2xx responses as errors with consistent metadata headers", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("not found", {
        status: 404,
        statusText: "Not Found",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
    );

    const { pi, getTool } = createMockPi();
    webfetchExtension(pi as never);

    const result = await getTool().execute(
      "call_404",
      { url: "https://example.com/missing" },
      new AbortController().signal,
    );

    const details = result.details as WebFetchTestDetails | undefined;

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Web fetch failed");
    expect(result.content[0]?.text).toContain("URL: https://example.com/missing");
    expect(result.content[0]?.text).toContain("Status: 404 Not Found");
    expect(result.content[0]?.text).toContain("Content-Type: text/plain; charset=utf-8");
    expect(details?.status).toBe(404);
  });

  it("rejects binary content and preserves markdown-first Accept header", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([0, 1, 2, 3]), {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      }),
    );

    const { pi, getTool } = createMockPi();
    webfetchExtension(pi as never);

    const result = await getTool().execute(
      "call_binary",
      { url: "https://example.com/binary" },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Unsupported content-type");

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.headers).toEqual({
      Accept: "text/markdown, text/html",
      "Accept-Encoding": "identity",
    });
  });

  it("blocks localhost/private IP targets by default", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const { pi, getTool } = createMockPi();
    webfetchExtension(pi as never);

    const result = await getTool().execute(
      "call_private",
      { url: "http://127.0.0.1:8080" },
      new AbortController().signal,
    );

    const details = result.details as WebFetchTestDetails | undefined;

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Blocked private IP host: 127.0.0.1");
    expect(details?.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks IPv6 loopback targets by default", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const { pi, getTool } = createMockPi();
    webfetchExtension(pi as never);

    const result = await getTool().execute(
      "call_private_ipv6",
      { url: "http://[::1]:8080" },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Blocked private IP host: ::1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows private hosts only when WEBFETCH_ALLOW_PRIVATE_HOSTS=1", async () => {
    process.env.WEBFETCH_ALLOW_PRIVATE_HOSTS = "1";

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      }),
    );

    const { pi, getTool } = createMockPi();
    webfetchExtension(pi as never);

    const result = await getTool().execute(
      "call_private_allowed",
      { url: "http://127.0.0.1:8080" },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("Web fetch succeeded");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("classifies aborted requests as cancellation", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new DOMException("The operation was aborted", "AbortError"),
    );

    const { pi, getTool } = createMockPi();
    webfetchExtension(pi as never);

    const result = await getTool().execute(
      "call_abort",
      { url: "https://example.com" },
      new AbortController().signal,
    );

    const details = result.details as WebFetchTestDetails | undefined;

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Status: 499 Cancelled");
    expect(details?.status).toBe(499);
    expect(details?.statusText).toBe("Cancelled");
  });

  it("redacts credentials from output and details", async () => {
    const response = new Response("ok", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
    Object.defineProperty(response, "url", {
      configurable: true,
      value: "https://user:secret@example.com/private",
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

    const { pi, getTool } = createMockPi();
    webfetchExtension(pi as never);

    const result = await getTool().execute(
      "call_redact",
      { url: "https://user:secret@example.com/private" },
      new AbortController().signal,
    );

    const details = result.details as WebFetchTestDetails | undefined;
    const output = result.content[0]?.text ?? "";

    expect(output).not.toContain("user:secret");
    expect(details?.requestedUrl).not.toContain("user:secret");
    expect(details?.resolvedUrl).not.toContain("user:secret");
    expect(details?.resolvedUrl).toContain("https://example.com/private");
  });

  it("truncates large responses and persists full output path", async () => {
    const hugeText = Array.from({ length: 2500 }, (_, index) => `line-${index}`).join("\n");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(hugeText, {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      }),
    );

    const { pi, getTool } = createMockPi();
    webfetchExtension(pi as never);

    const result = await getTool().execute(
      "call_truncated",
      { url: "https://example.com/huge", maxChars: 100000 },
      new AbortController().signal,
    );

    const details = result.details as WebFetchTestDetails | undefined;
    const fullOutputPath = details?.fullOutputPath;

    expect(result.isError).toBeUndefined();
    expect(details?.truncated).toBe(true);
    expect(fullOutputPath).toBeTruthy();
    expect(result.content[0]?.text).toContain("Output truncated");
    expect(result.content[0]?.text).toContain("Full output saved to:");

    if (!fullOutputPath) {
      throw new Error("Expected fullOutputPath when output is truncated");
    }

    try {
      await access(fullOutputPath);
    } finally {
      await rm(dirname(fullOutputPath), { recursive: true, force: true });
    }
  });
});
