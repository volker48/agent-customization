/**
 * Generic web access extension for pi.
 *
 * Registers a `webfetch` tool used to access website URLs directly.
 *
 * Key header behavior:
 *   Accept: "text/markdown, text/html"
 * (in this exact order, preferring markdown first)
 */

import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const ACCEPT_HEADER = "text/markdown, text/html";
const DEFAULT_MAX_CHARS = 12000;
const MIN_MAX_CHARS = 1000;
const MAX_MAX_CHARS = 100000;

const WebFetchParams = Type.Object({
  url: Type.String({
    description:
      "Website URL to access (http:// or https://). If scheme is omitted, https:// is assumed.",
    minLength: 1,
  }),
  maxChars: Type.Optional(
    Type.Integer({
      description: `Maximum characters returned (default: ${DEFAULT_MAX_CHARS})`,
      minimum: MIN_MAX_CHARS,
      maximum: MAX_MAX_CHARS,
    }),
  ),
});

interface WebFetchDetails {
  requestedUrl: string;
  resolvedUrl: string;
  acceptHeader: string;
  status: number;
  statusText: string;
  contentType: string;
  truncated: boolean;
  originalCharacters: number;
  returnedCharacters: number;
}

function normalizeUrl(rawUrl: string): URL {
  const trimmed = rawUrl.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return new URL(trimmed);
  }
  return new URL(`https://${trimmed}`);
}

function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }

  return {
    text: `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} characters]`,
    truncated: true,
  };
}

export default function webfetchExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "webfetch",
    label: "Web Fetch",
    description:
      "Access a website URL and return page content. Use when the user asks to open or read a webpage.",
    parameters: WebFetchParams,

    async execute(_toolCallId, params, signal) {
      let targetUrl: URL;
      try {
        targetUrl = normalizeUrl(params.url);
      } catch {
        return {
          content: [{ type: "text", text: `Invalid URL: ${params.url}` }],
          details: {
            requestedUrl: params.url,
            resolvedUrl: "",
            acceptHeader: ACCEPT_HEADER,
            status: 400,
            statusText: "Bad Request",
            contentType: "",
            truncated: false,
            originalCharacters: 0,
            returnedCharacters: 0,
          } as WebFetchDetails,
        };
      }

      try {
        const response = await fetch(targetUrl.toString(), {
          method: "GET",
          headers: {
            Accept: ACCEPT_HEADER,
            "Accept-Encoding": "identity",
          },
          signal,
          redirect: "follow",
        });

        const rawText = await response.text();
        const maxChars = params.maxChars ?? DEFAULT_MAX_CHARS;
        const truncated = truncate(rawText, maxChars);
        const contentType = response.headers.get("content-type") ?? "";

        if (!response.ok) {
          return {
            content: [
              {
                type: "text",
                text: `Web request failed (${response.status} ${response.statusText})\nURL: ${response.url}\n\n${truncated.text}`,
              },
            ],
            details: {
              requestedUrl: params.url,
              resolvedUrl: response.url,
              acceptHeader: ACCEPT_HEADER,
              status: response.status,
              statusText: response.statusText,
              contentType,
              truncated: truncated.truncated,
              originalCharacters: rawText.length,
              returnedCharacters: truncated.text.length,
            } as WebFetchDetails,
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Fetched: ${response.url}\n\n${truncated.text}`,
            },
          ],
          details: {
            requestedUrl: params.url,
            resolvedUrl: response.url,
            acceptHeader: ACCEPT_HEADER,
            status: response.status,
            statusText: response.statusText,
            contentType,
            truncated: truncated.truncated,
            originalCharacters: rawText.length,
            returnedCharacters: truncated.text.length,
          } as WebFetchDetails,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Web request failed: ${message}` }],
          details: {
            requestedUrl: params.url,
            resolvedUrl: targetUrl.toString(),
            acceptHeader: ACCEPT_HEADER,
            status: 500,
            statusText: "Request Failed",
            contentType: "",
            truncated: false,
            originalCharacters: 0,
            returnedCharacters: 0,
          } as WebFetchDetails,
        };
      }
    },
  });
}
