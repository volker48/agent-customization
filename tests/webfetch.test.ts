import { access, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import webfetchExtension from "../pi-extensions/webfetch.js";
import type { WebFetchInput, WebFetchToolResult } from "../pi-extensions/lib/webfetch-core.js";

type RegisteredTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: WebFetchInput,
    signal: AbortSignal,
  ) => Promise<WebFetchToolResult>;
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
  converted?: boolean;
  conversionMethod?: "readability" | "full-page" | "none";
  originalHtmlBytes?: number;
};

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

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
  const originalGithubToken = process.env.GITHUB_TOKEN;
  const originalGhToken = process.env.GH_TOKEN;

  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.WEBFETCH_ALLOW_PRIVATE_HOSTS;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreEnv("WEBFETCH_ALLOW_PRIVATE_HOSTS", originalPrivateHostOverride);
    restoreEnv("GITHUB_TOKEN", originalGithubToken);
    restoreEnv("GH_TOKEN", originalGhToken);
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
      Accept:
        "text/markdown;q=1.0, text/x-markdown;q=0.95, application/markdown;q=0.95, text/html;q=0.8",
      "Accept-Encoding": "identity",
    });
  });

  it("accepts application/markdown responses as text", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("# Markdown", {
        status: 200,
        headers: { "Content-Type": "application/markdown" },
      }),
    );

    const { pi, getTool } = createMockPi();
    webfetchExtension(pi as never);

    const result = await getTool().execute(
      "call_application_markdown",
      { url: "https://example.com/page" },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("# Markdown");
  });

  it("converts HTML articles to markdown with source metadata", async () => {
    const articleText = Array.from(
      { length: 30 },
      (_, index) => `Paragraph ${index} explains the release notes in useful detail.`,
    ).join(" ");
    const html = [
      "<!doctype html><html><head><title>Release Notes</title></head><body>",
      `<main><article><h1>Release Notes</h1><p>${articleText}</p></article>`,
      `<nav>${"<a>noise</a>".repeat(100)}</nav></main></body></html>`,
    ].join("");

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
    );

    const { pi, getTool } = createMockPi();
    webfetchExtension(pi as never);

    const result = await getTool().execute(
      "call_html_article",
      { url: "https://example.com/release" },
      new AbortController().signal,
    );

    const body = result.content[0]?.text ?? "";
    const details = result.details as WebFetchTestDetails | undefined;

    expect(result.isError).toBeUndefined();
    expect(body).toContain("# Release Notes");
    expect(body).toContain("Source: https://example.com/release");
    expect(body).not.toContain("<!doctype html>");
    expect(details?.converted).toBe(true);
    expect(details?.conversionMethod).toBe("readability");
    expect(details?.originalHtmlBytes).toBeGreaterThan(0);
  });

  it("preserves HTML tables as GFM markdown tables", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        "<html><body><table><thead><tr><th>Name</th><th>Done</th></tr></thead>" +
          "<tbody><tr><td>Docs</td><td>Yes</td></tr></tbody></table></body></html>",
        { status: 200, headers: { "Content-Type": "text/html" } },
      ),
    );

    const { pi, getTool } = createMockPi();
    webfetchExtension(pi as never);

    const result = await getTool().execute(
      "call_html_table",
      { url: "https://example.com/table" },
      new AbortController().signal,
    );

    expect(result.content[0]?.text).toContain("| Name | Done |");
    expect(result.content[0]?.text).toContain("| Docs | Yes |");
    expect((result.details as WebFetchTestDetails).conversionMethod).toBe("full-page");
  });

  it("falls back to full-page markdown for thin HTML", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html><body><h1>Thin</h1><p>Small page.</p></body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );

    const { pi, getTool } = createMockPi();
    webfetchExtension(pi as never);

    const result = await getTool().execute(
      "call_thin_html",
      { url: "https://example.com/thin" },
      new AbortController().signal,
    );

    expect(result.content[0]?.text).toContain("# Thin");
    expect((result.details as WebFetchTestDetails).conversionMethod).toBe("full-page");
  });

  it("converts RustSec advisory HTML to markdown", async () => {
    const fixtureUrl = new URL("./fixtures/rustsec-advisory.html", import.meta.url);
    const html = await readFile(fixtureUrl, "utf8");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
    );

    const { pi, getTool } = createMockPi();
    webfetchExtension(pi as never);

    const result = await getTool().execute(
      "call_rustsec_advisory",
      { url: "https://rustsec.org/advisories/RUSTSEC-2026-0097" },
      new AbortController().signal,
    );

    const output = result.content[0]?.text ?? "";
    const details = result.details as WebFetchTestDetails;
    expect(output).toContain("## RUSTSEC-2026-0097");
    expect(output).toContain("Rand is unsound with a custom logger using");
    expect(output).not.toContain("<!DOCTYPE html>");
    expect(output).not.toContain("<meta");
    expect(output).not.toContain("<main");
    expect(details.converted).toBe(true);
    expect(details.conversionMethod).toBe("readability");
  });

  it("degrades to raw HTML when conversion throws", async () => {
    vi.spyOn(TurndownService.prototype, "turndown").mockImplementation(() => {
      throw new Error("converter failed");
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html><body><h1>Still returned</h1></body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );

    const { pi, getTool } = createMockPi();
    webfetchExtension(pi as never);

    const result = await getTool().execute(
      "call_conversion_throw",
      { url: "https://example.com/throws" },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("<h1>Still returned</h1>");
    expect((result.details as WebFetchTestDetails).conversionMethod).toBe("none");
  });

  it("converts HTML error responses to markdown instead of raw HTML", async () => {
    const html = [
      "<html><head><script>window.challenge = true;</script></head><body>",
      "<main><h1>Access denied</h1><p>The site blocked this fetch.</p>",
      '<img alt="challenge" src="data:image/png;base64,AAAAAA"></main>',
      "</body></html>",
    ].join("");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(html, {
        status: 403,
        statusText: "Forbidden",
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
    );

    const { pi, getTool } = createMockPi();
    webfetchExtension(pi as never);

    const result = await getTool().execute(
      "call_html_error",
      { url: "https://example.com/blocked" },
      new AbortController().signal,
    );

    const output = result.content[0]?.text ?? "";
    const details = result.details as WebFetchTestDetails;
    expect(result.isError).toBe(true);
    expect(output).toContain("# Access denied");
    expect(output).toContain("The site blocked this fetch.");
    expect(output).not.toContain("<html");
    expect(output).not.toContain("<script");
    expect(output).not.toContain("data:image/png");
    expect(details.status).toBe(403);
    expect(details.converted).toBe(true);
  });

  it("bypasses HTML conversion when raw is true", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html><body><h1>Raw</h1></body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );

    const { pi, getTool } = createMockPi();
    webfetchExtension(pi as never);

    const result = await getTool().execute(
      "call_raw_html",
      { url: "https://example.com/raw", raw: true },
      new AbortController().signal,
    );

    expect(result.content[0]?.text).toContain("<html><body><h1>Raw</h1></body></html>");
    expect((result.details as WebFetchTestDetails).converted).toBe(false);
  });

  it("skips conversion for oversized HTML", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html><body><h1>Large</h1></body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html", "Content-Length": "5242881" },
      }),
    );

    const { pi, getTool } = createMockPi();
    webfetchExtension(pi as never);

    const result = await getTool().execute(
      "call_large_html",
      { url: "https://example.com/large" },
      new AbortController().signal,
    );

    expect(result.content[0]?.text).toContain("<html><body><h1>Large</h1></body></html>");
    expect((result.details as WebFetchTestDetails).converted).toBe(false);
  });

  it("applies maxChars truncation after HTML conversion", async () => {
    const html = [
      "<html><body><main><article><h1>Long</h1><p>",
      "converted text ".repeat(500),
      "</p></article></main></body></html>",
    ].join("");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(html, { status: 200, headers: { "Content-Type": "text/html" } }),
    );

    const { pi, getTool } = createMockPi();
    webfetchExtension(pi as never);

    const result = await getTool().execute(
      "call_converted_truncated",
      { url: "https://example.com/long", maxChars: 1000 },
      new AbortController().signal,
    );

    const details = result.details as WebFetchTestDetails;
    expect(details.converted).toBe(true);
    expect(details.truncatedByMaxChars).toBe(true);
    expect(result.content[0]?.text).toContain("Output truncated");
  });

  it("compacts converted markdown images, whitespace, and blank lines", async () => {
    const html = [
      "<html><body><h1>Compact</h1>",
      '<p><img alt="Diagram" src="data:image/png;base64,AAAAAA"></p>',
      '<p><img alt="Logo" src="https://example.com/logo.png"></p>',
      "<p>Alpha   </p>",
      "<div><br><br><br></div>",
      "<p>Omega</p></body></html>",
    ].join("");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(html, { status: 200, headers: { "Content-Type": "text/html" } }),
    );

    const { pi, getTool } = createMockPi();
    webfetchExtension(pi as never);

    const result = await getTool().execute(
      "call_compact_markdown",
      { url: "https://example.com/compact" },
      new AbortController().signal,
    );

    const body = result.content[0]?.text ?? "";
    expect(body).toContain("![Diagram]");
    expect(body).toContain("![Logo]");
    expect(body).not.toContain("data:image/png");
    expect(body).not.toContain("https://example.com/logo.png");
    expect(body).not.toMatch(/\n{3,}/);
    expect(body.split("\n").some((line) => /\s$/.test(line))).toBe(false);
  });

  it("prunes boilerplate in full-page fallback conversion", async () => {
    vi.spyOn(Readability.prototype, "parse").mockReturnValue(null);
    const html = [
      "<html><body>",
      "<nav><h2>Navigation menu</h2><a>Products</a></nav>",
      "<main><h1>Main Content</h1><table><tr><td>Keep useful content</td></tr></table></main>",
      "<footer>Legal footer noise</footer>",
      "</body></html>",
    ].join("");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(html, { status: 200, headers: { "Content-Type": "text/html" } }),
    );

    const { pi, getTool } = createMockPi();
    webfetchExtension(pi as never);

    const result = await getTool().execute(
      "call_pruned_fallback",
      { url: "https://example.com/pruned" },
      new AbortController().signal,
    );

    const body = result.content[0]?.text ?? "";
    expect(body).toContain("# Main Content");
    expect(body).toContain("Keep useful content");
    expect(body).not.toContain("Navigation menu");
    expect(body).not.toContain("Legal footer noise");
    expect((result.details as WebFetchTestDetails).conversionMethod).toBe("full-page");
  });

  it("adds a capped outline when converted markdown is truncated", async () => {
    const sections = Array.from({ length: 35 }, (_, index) => {
      const lines = Array.from({ length: 70 }, (__, line) => `<p>${index + 1}.${line}</p>`);
      return [`<h2>Section ${index + 1}</h2>`, ...lines].join("");
    }).join("");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(`<html><body>${sections}</body></html>`, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );

    const { pi, getTool } = createMockPi();
    webfetchExtension(pi as never);

    const result = await getTool().execute(
      "call_converted_outline",
      { url: "https://example.com/outline", maxChars: 100000 },
      new AbortController().signal,
    );

    const details = result.details as WebFetchTestDetails;
    const fullOutputPath = details.fullOutputPath;
    if (!fullOutputPath) throw new Error("Expected full output path");

    try {
      const saved = await readFile(fullOutputPath, "utf8");
      const headings = saved
        .split("\n")
        .map((line, index) => ({ line, lineNumber: index + 1 }))
        .filter(({ line }) => /^#{1,6} /.test(line));
      const output = result.content[0]?.text ?? "";

      expect(details.truncated).toBe(true);
      expect(output).toContain("[Outline of full content");
      for (const heading of headings.slice(0, 30)) {
        expect(output).toContain(`  ${heading.lineNumber}: ${heading.line}`);
      }
      expect(output).toContain("  ...and 5 more headings");
      expect(output).not.toContain(`  ${headings[30]?.lineNumber}: ${headings[30]?.line}`);
    } finally {
      await rm(dirname(fullOutputPath), { recursive: true, force: true });
    }
  });

  it("extracts matching URL fragments from converted markdown sections", async () => {
    const html = [
      "<html><body><h1>Guide</h1><p>Intro text.</p>",
      "<h2>Installation</h2><p>Install text.</p>",
      "<h2>Configuration</h2><p>Config text.</p><h3>Advanced</h3><p>Advanced text.</p>",
      "<h2>Usage</h2><p>Usage text.</p></body></html>",
    ].join("");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(html, { status: 200, headers: { "Content-Type": "text/html" } }),
    );

    const { pi, getTool } = createMockPi();
    webfetchExtension(pi as never);

    const result = await getTool().execute(
      "call_fragment_match",
      { url: "https://example.com/guide#configuration" },
      new AbortController().signal,
    );

    const details = result.details as WebFetchTestDetails;
    const output = result.content[0]?.text ?? "";
    expect(output).toContain('[Extracted section "#configuration"');
    expect(output).toContain("## Configuration");
    expect(output).toContain("Config text.");
    expect(output).toContain("### Advanced");
    expect(output).not.toContain("## Installation");
    expect(output).not.toContain("## Usage");
    expect(details.fullOutputPath).toBeTruthy();

    if (details.fullOutputPath) {
      await rm(dirname(details.fullOutputPath), { recursive: true, force: true });
    }
  });

  it("matches GitHub-style duplicate heading URL fragments", async () => {
    const html = [
      "<html><body><h1>Guide</h1>",
      "<h2>Usage</h2><p>First usage.</p>",
      "<h2>Usage</h2><p>Second usage.</p>",
      "</body></html>",
    ].join("");
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(html, { status: 200, headers: { "Content-Type": "text/html" } }),
    );

    const { pi, getTool } = createMockPi();
    webfetchExtension(pi as never);

    const firstResult = await getTool().execute(
      "call_fragment_first_duplicate",
      { url: "https://example.com/guide#usage" },
      new AbortController().signal,
    );
    const secondResult = await getTool().execute(
      "call_fragment_second_duplicate",
      { url: "https://example.com/guide#usage-1" },
      new AbortController().signal,
    );

    const firstOutput = firstResult.content[0]?.text ?? "";
    const secondOutput = secondResult.content[0]?.text ?? "";
    expect(firstOutput).toContain("First usage.");
    expect(firstOutput).not.toContain("Second usage.");
    expect(secondOutput).toContain("Second usage.");
    expect(secondOutput).not.toContain("First usage.");

    for (const result of [firstResult, secondResult]) {
      const fullOutputPath = (result.details as WebFetchTestDetails).fullOutputPath;
      if (fullOutputPath) {
        await rm(dirname(fullOutputPath), { recursive: true, force: true });
      }
    }
  });

  it("notes unmatched URL fragments without dropping converted content", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html><body><h1>Guide</h1><p>Intro.</p></body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );

    const { pi, getTool } = createMockPi();
    webfetchExtension(pi as never);

    const result = await getTool().execute(
      "call_fragment_missing",
      { url: "https://example.com/guide#missing" },
      new AbortController().signal,
    );

    const output = result.content[0]?.text ?? "";
    expect(output).toContain("# Guide");
    expect(output).toContain('[URL fragment "#missing" did not match any heading.]');
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

  it("returns orientation for GitHub repository root URLs", async () => {
    process.env.GITHUB_TOKEN = "secret-token";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          description: "Widget toolkit.",
          default_branch: "main",
          language: "TypeScript",
          topics: ["cli", "agent"],
          homepage: "https://widgets.example",
        }),
      )
      .mockResolvedValueOnce(
        Response.json([
          { name: "docs", type: "dir" },
          { name: "package.json", type: "file" },
        ]),
      )
      .mockResolvedValueOnce(
        new Response("# Project README\n\nLoaded from README source.", {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        }),
      );

    const { pi, getTool } = createMockPi();
    webfetchExtension(pi as never);

    const result = await getTool().execute(
      "call_github_repo",
      { url: "https://github.com/acme/widgets" },
      new AbortController().signal,
    );

    const details = result.details as WebFetchTestDetails | undefined;
    const output = result.content[0]?.text ?? "";
    const metadataInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const readmeInit = fetchMock.mock.calls[2]?.[1] as RequestInit;
    const metadataHeaders = metadataInit.headers as Record<string, string>;
    const readmeHeaders = readmeInit.headers as Record<string, string>;

    expect(result.isError).toBeUndefined();
    expect(output).toContain("acme/widgets");
    expect(output).toContain("Widget toolkit.");
    expect(output).toContain("default_branch: main");
    expect(output).toContain("language: TypeScript   topics: cli, agent");
    expect(output).toContain("homepage: https://widgets.example");
    expect(output).toContain("  docs/");
    expect(output).toContain("# Project README");
    expect(output.indexOf("acme/widgets")).toBeLessThan(output.indexOf("default_branch: main"));
    expect(output.indexOf("default_branch: main")).toBeLessThan(output.indexOf("  docs/"));
    expect(output.indexOf("  docs/")).toBeLessThan(output.indexOf("# Project README"));
    expect(details?.finalUrl).toBe("https://github.com/acme/widgets");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.github.com/repos/acme/widgets");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://api.github.com/repos/acme/widgets/contents");
    expect(fetchMock.mock.calls[2]?.[0]).toBe("https://api.github.com/repos/acme/widgets/readme");
    expect(metadataHeaders.Authorization).toBe("Bearer secret-token");
    expect(readmeHeaders.Authorization).toBe("Bearer secret-token");
    expect(readmeHeaders.Accept).toBe("application/vnd.github.raw");
  });

  it("returns GitHub repository orientation when the repo has no README", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          description: "Widget toolkit.",
          default_branch: "main",
          language: "TypeScript",
          topics: [],
          homepage: "",
        }),
      )
      .mockResolvedValueOnce(Response.json([{ name: "src", type: "dir" }]))
      .mockResolvedValueOnce(
        new Response("not found", {
          status: 404,
          statusText: "Not Found",
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        }),
      );

    const { pi, getTool } = createMockPi();
    webfetchExtension(pi as never);

    const result = await getTool().execute(
      "call_github_repo_no_readme",
      { url: "https://github.com/acme/widgets" },
      new AbortController().signal,
    );

    const output = result.content[0]?.text ?? "";

    expect(result.isError).toBeUndefined();
    expect(output).toContain("acme/widgets");
    expect(output).toContain("default_branch: main");
    expect(output).toContain("  src/");
    expect(output).not.toContain("README:");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]?.[0]).toBe("https://api.github.com/repos/acme/widgets/readme");
  });

  it("falls back gracefully with a clear GitHub API rate-limit note", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          description: "Widget toolkit.",
          default_branch: "main",
          language: "TypeScript",
          topics: [],
          homepage: "",
        }),
      )
      .mockResolvedValueOnce(Response.json([{ name: "src", type: "dir" }]))
      .mockResolvedValueOnce(
        Response.json(
          { message: "API rate limit exceeded for 203.0.113.1." },
          { status: 403, statusText: "Forbidden", headers: { "x-ratelimit-remaining": "0" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response("# Project README\n\nFallback body.", {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        }),
      );

    const { pi, getTool } = createMockPi();
    webfetchExtension(pi as never);

    const result = await getTool().execute(
      "call_github_repo_rate_limited",
      { url: "https://github.com/acme/widgets" },
      new AbortController().signal,
    );

    const details = result.details as WebFetchTestDetails | undefined;

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("Fallback body.");
    expect(details?.smartNotes?.[0]).toContain("GitHub API rate limit hit; set GITHUB_TOKEN");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.github.com/repos/acme/widgets");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://api.github.com/repos/acme/widgets/contents");
    expect(fetchMock.mock.calls[2]?.[0]).toBe("https://api.github.com/repos/acme/widgets/readme");
    expect(fetchMock.mock.calls[3]?.[0]).toBe(
      "https://raw.githubusercontent.com/acme/widgets/HEAD/README.md",
    );
  });

  it("falls back to GitHub HTML when orientation and README lookup are unavailable", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("metadata unavailable"))
      .mockResolvedValueOnce(
        new Response("not found", {
          status: 404,
          statusText: "Not Found",
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("<html><body><article><h1>Rendered fallback</h1></article></body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
      );

    const { pi, getTool } = createMockPi();
    webfetchExtension(pi as never);

    const result = await getTool().execute(
      "call_github_repo_fallback",
      { url: "https://github.com/acme/widgets" },
      new AbortController().signal,
    );

    const details = result.details as WebFetchTestDetails | undefined;

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("Rendered fallback");
    expect(details?.finalUrl).toBe("https://github.com/acme/widgets");
    expect(details?.smartNotes?.[0]).toContain("GitHub orientation failed");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.github.com/repos/acme/widgets");
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://raw.githubusercontent.com/acme/widgets/HEAD/README.md",
    );
    expect(fetchMock.mock.calls[2]?.[0]).toBe("https://github.com/acme/widgets");
  });

  it("falls back to GitHub HTML when orientation and README lookup throw", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("metadata lookup failed"))
      .mockRejectedValueOnce(new Error("raw lookup failed"))
      .mockResolvedValueOnce(
        new Response("<html><body><article><h1>Rendered after throw</h1></article></body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
      );

    const { pi, getTool } = createMockPi();
    webfetchExtension(pi as never);

    const result = await getTool().execute(
      "call_github_repo_throw_fallback",
      { url: "https://github.com/acme/widgets" },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("Rendered after throw");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("fetches raw content for GitHub blob URLs", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("# Raw file\n\nLoaded from GitHub raw.", {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
    );

    const { pi, getTool } = createMockPi();
    webfetchExtension(pi as never);

    const result = await getTool().execute(
      "call_github_blob",
      { url: "https://github.com/acme/widgets/blob/main/docs/README.md" },
      new AbortController().signal,
    );

    const details = result.details as WebFetchTestDetails | undefined;

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("# Raw file");
    expect(details?.finalUrl).toBe(
      "https://raw.githubusercontent.com/acme/widgets/main/docs/README.md",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://raw.githubusercontent.com/acme/widgets/main/docs/README.md",
    );
  });

  it("renders GitHub issue URLs through the REST API", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          number: 42,
          title: "Fix widgets",
          state: "open",
          user: { login: "octo" },
          labels: [{ name: "bug" }, { name: "help wanted" }],
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-02T00:00:00Z",
          comments: 1,
          body: "Issue body text.",
        }),
      )
      .mockResolvedValueOnce(
        Response.json([
          {
            user: { login: "maintainer" },
            created_at: "2024-01-03T00:00:00Z",
            body: "Comment body text.",
          },
        ]),
      );

    const { pi, getTool } = createMockPi();
    webfetchExtension(pi as never);

    const result = await getTool().execute(
      "call_github_issue",
      { url: "https://github.com/acme/widgets/issues/42" },
      new AbortController().signal,
    );

    const details = result.details as WebFetchTestDetails;
    const output = result.content[0]?.text ?? "";
    const firstInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const firstHeaders = firstInit.headers as Record<string, string>;

    expect(output).toContain("# Fix widgets (#42)");
    expect(output).toContain("State: open");
    expect(output).toContain("Author: @octo");
    expect(output).toContain("Labels: bug, help wanted");
    expect(output).toContain("Issue body text.");
    expect(output).toContain("**@maintainer** (2024-01-03T00:00:00Z):");
    expect(output).toContain("Comment body text.");
    expect(details.alternateUrlUsed).toBe("https://api.github.com/repos/acme/widgets/issues/42");
    expect(details.smartNotes?.[0]).toContain("REST API");
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repos/acme/widgets/issues/42",
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://api.github.com/repos/acme/widgets/issues/42/comments?per_page=30",
    );
    expect(firstHeaders.Authorization).toBeUndefined();
    expect(firstHeaders["User-Agent"]).toBe("pi-webfetch");
  });

  it("falls back from malformed GitHub API payloads", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(
        new Response("<html><body><h1>Malformed payload fallback</h1></body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
      );

    const { pi, getTool } = createMockPi();
    webfetchExtension(pi as never);

    const result = await getTool().execute(
      "call_github_issue_malformed",
      { url: "https://github.com/acme/widgets/issues/42" },
      new AbortController().signal,
    );
    const details = result.details as WebFetchTestDetails;

    expect(result.content[0]?.text).toContain("Malformed payload fallback");
    expect(details.smartNotes?.join(" ")).toContain("GitHub issue payload was not an object");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back from GitHub API failures without leaking token to HTML fetch", async () => {
    process.env.GITHUB_TOKEN = "secret-token";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response("rate limited", {
          status: 403,
          statusText: "Forbidden",
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("<html><body><h1>Issue HTML fallback</h1></body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
      );

    const { pi, getTool } = createMockPi();
    webfetchExtension(pi as never);

    const result = await getTool().execute(
      "call_github_issue_fallback",
      { url: "https://github.com/acme/widgets/issues/42#discussion" },
      new AbortController().signal,
    );

    const apiInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const htmlInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const apiHeaders = apiInit.headers as Record<string, string>;
    const htmlHeaders = htmlInit.headers as Record<string, string>;
    const details = result.details as WebFetchTestDetails;

    expect(result.content[0]?.text).toContain("Issue HTML fallback");
    expect(details.smartNotes?.[0]).toContain("GitHub API fetch failed");
    expect(apiHeaders.Authorization).toBe("Bearer secret-token");
    expect(htmlHeaders.Authorization).toBeUndefined();
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://github.com/acme/widgets/issues/42");
  });

  it("renders merged GitHub pull request state from the issue API", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        number: 7,
        title: "Add feature",
        state: "closed",
        user: { login: "contributor" },
        labels: [],
        created_at: "2024-02-01T00:00:00Z",
        updated_at: "2024-02-02T00:00:00Z",
        comments: 0,
        body: "PR body text.",
        pull_request: { merged_at: "2024-02-03T00:00:00Z" },
      }),
    );

    const { pi, getTool } = createMockPi();
    webfetchExtension(pi as never);

    const result = await getTool().execute(
      "call_github_pr",
      { url: "https://github.com/acme/widgets/pull/7" },
      new AbortController().signal,
    );

    const output = result.content[0]?.text ?? "";
    expect(output).toContain("# Add feature (#7)");
    expect(output).toContain("State: merged");
    expect(output).toContain("Author: @contributor");
  });

  it("returns orientation for GitLab repository root URLs", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          path_with_namespace: "acme/widgets",
          description: "Widget toolkit.",
          default_branch: "main",
          topics: ["cli", "agent"],
          web_url: "https://gitlab.com/acme/widgets",
        }),
      )
      .mockResolvedValueOnce(
        Response.json([
          { name: "docs", type: "tree" },
          { name: "README.md", type: "blob" },
        ]),
      )
      .mockResolvedValueOnce(
        new Response("# GitLab README\n\nLoaded from README source.", {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        }),
      );

    const { pi, getTool } = createMockPi();
    webfetchExtension(pi as never);

    const result = await getTool().execute(
      "call_gitlab_repo",
      { url: "https://gitlab.com/acme/widgets" },
      new AbortController().signal,
    );

    const details = result.details as WebFetchTestDetails;
    const output = result.content[0]?.text ?? "";
    expect(result.isError).toBeUndefined();
    expect(output).toContain("acme/widgets");
    expect(output).toContain("Widget toolkit.");
    expect(output).toContain("default_branch: main");
    expect(output).toContain("topics: cli, agent");
    expect(output).toContain("  docs/");
    expect(output).toContain("# GitLab README");
    expect(details.finalUrl).toBe("https://gitlab.com/acme/widgets");
    expect(details.alternateUrlUsed).toBe("https://gitlab.com/api/v4/projects/acme%2Fwidgets");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://gitlab.com/api/v4/projects/acme%2Fwidgets");
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://gitlab.com/api/v4/projects/acme%2Fwidgets/repository/tree?ref=main&per_page=100",
    );
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      "https://gitlab.com/api/v4/projects/acme%2Fwidgets/repository/files/README.md/raw?ref=main",
    );
  });

  it("fetches conventional GitLab README when the first tree page omits it", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          path_with_namespace: "acme/widgets",
          description: "Widget toolkit.",
          default_branch: "main",
          topics: [],
          web_url: "https://gitlab.com/acme/widgets",
        }),
      )
      .mockResolvedValueOnce(Response.json([{ name: "src", type: "tree" }]))
      .mockResolvedValueOnce(
        new Response("# Conventional README\n\nLoaded despite pagination.", {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        }),
      );

    const { pi, getTool } = createMockPi();
    webfetchExtension(pi as never);

    const result = await getTool().execute(
      "call_gitlab_repo_readme_fallback",
      { url: "https://gitlab.com/acme/widgets" },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("# Conventional README");
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      "https://gitlab.com/api/v4/projects/acme%2Fwidgets/repository/files/README.md/raw?ref=main",
    );
  });

  it("fetches raw content for GitLab blob URLs", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("# Raw GitLab file\n\nLoaded from GitLab raw API.", {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
    );

    const { pi, getTool } = createMockPi();
    webfetchExtension(pi as never);

    const result = await getTool().execute(
      "call_gitlab_blob",
      { url: "https://gitlab.com/acme/widgets/-/blob/main/docs/README.md" },
      new AbortController().signal,
    );

    const details = result.details as WebFetchTestDetails;
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("# Raw GitLab file");
    expect(details.finalUrl).toBe(
      "https://gitlab.com/api/v4/projects/acme%2Fwidgets/repository/files/" +
        "docs%2FREADME.md/raw?ref=main",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("extracts README fragments from GitLab tree URLs", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          path_with_namespace: "acme/widgets",
          description: "Widget toolkit.",
          default_branch: "main",
          topics: [],
          web_url: "https://gitlab.com/acme/widgets",
        }),
      )
      .mockResolvedValueOnce(
        Response.json([
          { name: "api", type: "tree" },
          { name: "README.md", type: "blob" },
        ]),
      )
      .mockResolvedValueOnce(
        new Response("# Docs\n\n## Quick Start\n\nInstall from source.\n\n## Later\n\nSkip.", {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        }),
      );

    const { pi, getTool } = createMockPi();
    webfetchExtension(pi as never);

    const result = await getTool().execute(
      "call_gitlab_tree_fragment",
      { url: "https://gitlab.com/acme/widgets/-/tree/main/docs#quick-start" },
      new AbortController().signal,
    );

    const details = result.details as WebFetchTestDetails;
    const output = result.content[0]?.text ?? "";
    expect(result.isError).toBeUndefined();
    expect(output).toContain('[Extracted section "#quick-start"');
    expect(output).toContain("## Quick Start");
    expect(output).toContain("Install from source.");
    expect(output).not.toContain("## Later");
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://gitlab.com/api/v4/projects/acme%2Fwidgets/repository/tree" +
        "?ref=main&per_page=100&path=docs",
    );

    if (details.fullOutputPath) {
      await rm(dirname(details.fullOutputPath), { recursive: true, force: true });
    }
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
