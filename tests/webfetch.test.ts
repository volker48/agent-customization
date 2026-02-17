import { access, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import webfetchExtension from "../pi-extensions/webfetch.js";

type WebFetchParams = {
  url: string;
  maxChars?: number;
  mode?: "full" | "probe";
  strategy?: "direct" | "smart";
  accept?: string;
  headers?: Record<string, string>;
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
  finalUrl?: string;
  redirectChain?: string[];
  acceptHeader?: string;
  requestHeaders?: Record<string, string>;
  blockedRequestHeaders?: string[];
  mode?: "full" | "probe";
  strategy?: "direct" | "smart";
  status: number;
  statusText: string;
  contentType: string;
  contentLength?: number;
  durationMs?: number;
  truncated: boolean;
  truncatedByLines?: boolean;
  truncatedByBytes?: boolean;
  truncatedByMaxChars?: boolean;
  detectedJsShell?: boolean;
  jsShellSignals?: string[];
  alternateCandidates?: string[];
  alternateUrlUsed?: string;
  smartNotes?: string[];
  probeBytesRead?: number;
  probeByteLimit?: number;
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
    expect(details?.strategy).toBe("direct");
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

  it("supports Accept override, custom headers, and redacts sensitive header diagnostics", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('{"ok":true}', {
        status: 200,
        headers: { "Content-Type": "application/json", "Content-Length": "11" },
      }),
    );

    const { pi, getTool } = createMockPi();
    webfetchExtension(pi as never);

    const result = await getTool().execute(
      "call_headers",
      {
        url: "https://api.example.com/data",
        accept: "application/json",
        headers: {
          Authorization: "Bearer super-secret",
          Connection: "keep-alive",
          "X-Test": "hello",
        },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const sentHeaders = init?.headers as Record<string, string>;
    expect(sentHeaders.Accept).toBe("application/json");
    expect(sentHeaders["Accept-Encoding"]).toBe("identity");
    expect(sentHeaders.Authorization).toBe("Bearer super-secret");
    expect(sentHeaders["X-Test"]).toBe("hello");
    expect(sentHeaders.Connection).toBeUndefined();

    const details = result.details as WebFetchTestDetails | undefined;
    expect(details?.acceptHeader).toBe("application/json");
    expect(details?.requestHeaders?.Authorization).toBe("[redacted]");
    expect(details?.blockedRequestHeaders).toContain("Connection");
    expect(details?.contentLength).toBe(11);
    expect(typeof details?.durationMs).toBe("number");
  });

  it("tracks redirect chain and final URL", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response("", {
          status: 302,
          statusText: "Found",
          headers: { Location: "/final" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("done", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        }),
      );

    const { pi, getTool } = createMockPi();
    webfetchExtension(pi as never);

    const result = await getTool().execute(
      "call_redirect",
      { url: "https://example.com/start" },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.content[0]?.text).toContain("URL: https://example.com/final");

    const details = result.details as WebFetchTestDetails | undefined;
    expect(details?.finalUrl).toBe("https://example.com/final");
    expect(details?.redirectChain).toEqual([
      "https://example.com/start",
      "https://example.com/final",
    ]);
  });

  it("supports probe mode diagnostics and JS-shell detection", async () => {
    const shellHtml = [
      "<!doctype html>",
      "<html><head>",
      '<script src="/static/app.js"></script>',
      "<script>window.__NEXT_DATA__={}</script>",
      "</head><body>",
      '<div id="root"></div>',
      "<noscript>This app requires JavaScript.</noscript>",
      "</body></html>",
    ].join("");

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(shellHtml, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
    );

    const { pi, getTool } = createMockPi();
    webfetchExtension(pi as never);

    const result = await getTool().execute(
      "call_probe",
      { url: "https://example.com/spa", mode: "probe", maxChars: 100000 },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("Probe mode: sampled");

    const details = result.details as WebFetchTestDetails | undefined;
    expect(details?.mode).toBe("probe");
    expect(details?.detectedJsShell).toBe(true);
    expect(details?.jsShellSignals?.length).toBeGreaterThan(0);
    expect(details?.probeBytesRead).toBeGreaterThan(0);
  });

  it("smart strategy auto-follows markdown alternates from Link headers", async () => {
    const shellHtml = [
      "<!doctype html>",
      "<html><head>",
      '<script src="/static/app.js"></script>',
      "<script>window.__NEXT_DATA__={}</script>",
      "</head><body>",
      '<div id="root"></div>',
      "<noscript>This app requires JavaScript.</noscript>",
      "</body></html>",
    ].join("");

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(shellHtml, {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            Link: '</docs/page.md>; rel="alternate"; type="text/markdown"',
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response("# Docs\n\nLoaded from alternate markdown.", {
          status: 200,
          headers: { "Content-Type": "text/markdown" },
        }),
      );

    const { pi, getTool } = createMockPi();
    webfetchExtension(pi as never);

    const result = await getTool().execute(
      "call_smart_alternate",
      { url: "https://example.com/docs/page", strategy: "smart" },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.content[0]?.text).toContain("URL: https://example.com/docs/page.md");

    const details = result.details as WebFetchTestDetails | undefined;
    expect(details?.strategy).toBe("smart");
    expect(details?.alternateCandidates).toContain("https://example.com/docs/page.md");
    expect(details?.alternateUrlUsed).toBe("https://example.com/docs/page.md");
    expect(details?.smartNotes?.length).toBeGreaterThan(0);
  });

  it("smart strategy returns guidance when JS-shell page has no useful alternate", async () => {
    const shellHtml = [
      "<!doctype html>",
      "<html><head>",
      '<script src="/static/app.js"></script>',
      "<script>window.__NEXT_DATA__={}</script>",
      "</head><body>",
      '<div id="root"></div>',
      "<noscript>This app requires JavaScript.</noscript>",
      "</body></html>",
    ].join("");

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(shellHtml, {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("not found", {
          status: 404,
          statusText: "Not Found",
          headers: { "Content-Type": "text/plain" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(shellHtml, {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
      );

    const { pi, getTool } = createMockPi();
    webfetchExtension(pi as never);

    const result = await getTool().execute(
      "call_smart_fallback",
      { url: "https://example.com/spa", strategy: "smart" },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.content[0]?.text).toContain("[Smart strategy note]");

    const details = result.details as WebFetchTestDetails | undefined;
    expect(details?.strategy).toBe("smart");
    expect(details?.detectedJsShell).toBe(true);
    expect(details?.alternateCandidates).toContain("https://example.com/wp-json");
    expect(details?.smartNotes?.length).toBeGreaterThan(0);
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
    expect(details?.truncatedByLines).toBe(true);
    expect(details?.truncatedByBytes).toBe(false);
    expect(details?.truncatedByMaxChars).toBe(false);
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
