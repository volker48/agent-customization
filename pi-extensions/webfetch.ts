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
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type TruncationResult,
} from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ACCEPT_HEADER = "text/markdown, text/html";
const DEFAULT_MAX_CHARS = 12000;
const MIN_MAX_CHARS = 1000;
const MAX_MAX_CHARS = 100000;

const PRIVATE_HOST_OVERRIDE_ENV = "WEBFETCH_ALLOW_PRIVATE_HOSTS";
const REDACTED_CREDENTIALS = "[redacted]";

const TEXTUAL_CONTENT_TYPES = new Set([
  "application/json",
  "application/javascript",
  "application/xml",
  "application/xhtml+xml",
  "application/x-www-form-urlencoded",
]);

const METADATA_HOSTS = new Set(["metadata.google.internal"]);

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
  fullOutputPath?: string;
  truncation?: TruncationResult;
}

interface StreamedResponseText {
  text: string;
  truncated: boolean;
  totalCharacters: number;
  fullOutputPath?: string;
  truncation?: TruncationResult;
}

interface ToolResultContent {
  type: "text";
  text: string;
}

interface WebFetchToolResult {
  content: ToolResultContent[];
  details: WebFetchDetails;
  isError?: boolean;
}

function normalizeUrl(rawUrl: string): URL {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new Error("URL must not be empty");
  }

  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
  const parsed = new URL(hasScheme ? trimmed : `https://${trimmed}`);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported URL scheme: ${parsed.protocol}`);
  }

  return parsed;
}

function redactRawUrlCredentials(rawUrl: string): string {
  if (!rawUrl.includes("@")) {
    return rawUrl;
  }

  return rawUrl
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, `$1${REDACTED_CREDENTIALS}@`)
    .replace(/(^|\s)\/\/[^/\s@]+@/g, `$1//${REDACTED_CREDENTIALS}@`)
    .replace(/^([^/\s:@]+:[^/\s@]+)@/, `${REDACTED_CREDENTIALS}@`);
}

function redactUrlCredentials(url: string): string {
  if (!url) {
    return "";
  }

  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return redactRawUrlCredentials(url);
  }
}

function isTextContentType(contentTypeHeader: string): boolean {
  const normalized = contentTypeHeader.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!normalized) {
    return false;
  }

  if (normalized.startsWith("text/")) {
    return true;
  }

  if (normalized.endsWith("+json") || normalized.endsWith("+xml")) {
    return true;
  }

  return TEXTUAL_CONTENT_TYPES.has(normalized);
}

function parseIPv4(hostname: string): number[] | undefined {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) {
    return undefined;
  }

  const octets = hostname.split(".").map((part) => Number(part));
  if (octets.some((octet) => Number.isNaN(octet) || octet < 0 || octet > 255)) {
    return undefined;
  }

  return octets;
}

function isPrivateIPv4(hostname: string): boolean {
  const octets = parseIPv4(hostname);
  if (!octets) {
    return false;
  }

  const [a, b] = octets;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;

  return false;
}

function isPrivateIPv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (!normalized.includes(":")) {
    return false;
  }

  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fe80:")) return true;
  if (/^(fc|fd)[0-9a-f]{2}:/.test(normalized)) return true;

  if (normalized.startsWith("::ffff:")) {
    const mappedIpv4 = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mappedIpv4?.[1]) {
      return isPrivateIPv4(mappedIpv4[1]);
    }
    return true;
  }

  return false;
}

function shouldAllowPrivateHosts(): boolean {
  const raw = process.env[PRIVATE_HOST_OVERRIDE_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function normalizeHostname(hostname: string): string {
  const withoutTrailingDot = hostname.toLowerCase().replace(/\.$/, "");
  const withoutBrackets = withoutTrailingDot.replace(/^\[(.*)\]$/, "$1");
  return withoutBrackets.split("%")[0] ?? withoutBrackets;
}

function getPrivateHostBlockReason(hostname: string): string | undefined {
  if (shouldAllowPrivateHosts()) {
    return undefined;
  }

  const normalized = normalizeHostname(hostname);
  if (!normalized) {
    return "Target host is empty";
  }

  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return `Blocked private host: ${normalized}`;
  }

  if (METADATA_HOSTS.has(normalized)) {
    return `Blocked metadata host: ${normalized}`;
  }

  if (isPrivateIPv4(normalized) || isPrivateIPv6(normalized)) {
    return `Blocked private IP host: ${normalized}`;
  }

  return undefined;
}

function isAbortError(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) {
    return true;
  }

  return error instanceof Error && error.name === "AbortError";
}

function buildDetails(args: {
  requestedUrl: string;
  resolvedUrl: string;
  status: number;
  statusText: string;
  contentType: string;
  truncated: boolean;
  originalCharacters: number;
  returnedCharacters: number;
  fullOutputPath?: string;
  truncation?: TruncationResult;
}): WebFetchDetails {
  return {
    requestedUrl: redactRawUrlCredentials(args.requestedUrl),
    resolvedUrl: redactUrlCredentials(args.resolvedUrl),
    acceptHeader: ACCEPT_HEADER,
    status: args.status,
    statusText: args.statusText,
    contentType: args.contentType,
    truncated: args.truncated,
    originalCharacters: args.originalCharacters,
    returnedCharacters: args.returnedCharacters,
    fullOutputPath: args.fullOutputPath,
    truncation: args.truncation,
  };
}

function buildTruncationNotice(args: {
  truncation?: TruncationResult;
  charTruncated: boolean;
  maxChars: number;
  totalCharacters: number;
  fullOutputPath: string;
}): string {
  const reasons: string[] = [];

  if (args.truncation?.truncated) {
    reasons.push(
      `showing ${args.truncation.outputLines} of ${args.truncation.totalLines} lines ` +
        `(${formatSize(args.truncation.outputBytes)} of ${formatSize(args.truncation.totalBytes)})`,
    );
  }

  if (args.charTruncated) {
    reasons.push(`showing first ${args.maxChars} of ${args.totalCharacters} characters`);
  }

  return `[Output truncated: ${reasons.join("; ")}. Full output saved to: ${args.fullOutputPath}]`;
}

function appendChunkToHead(args: {
  headText: string;
  headTruncation: TruncationResult | undefined;
  chunkText: string;
}): { headText: string; headTruncation: TruncationResult | undefined } {
  if (args.headTruncation || !args.chunkText) {
    return { headText: args.headText, headTruncation: args.headTruncation };
  }

  const next = truncateHead(`${args.headText}${args.chunkText}`, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  return {
    headText: next.content,
    headTruncation: next.truncated ? next : undefined,
  };
}

function buildStreamedText(args: {
  headText: string;
  totalCharacters: number;
  maxChars: number;
  fullOutputPath: string;
  headTruncation: TruncationResult | undefined;
}): StreamedResponseText {
  const charTruncated = args.headText.length > args.maxChars;
  const truncated = Boolean(args.headTruncation) || charTruncated;
  const limitedText = charTruncated ? args.headText.slice(0, args.maxChars) : args.headText;

  if (!truncated) {
    return {
      text: limitedText,
      truncated: false,
      totalCharacters: args.totalCharacters,
    };
  }

  const notice = buildTruncationNotice({
    truncation: args.headTruncation,
    charTruncated,
    maxChars: args.maxChars,
    totalCharacters: args.totalCharacters,
    fullOutputPath: args.fullOutputPath,
  });

  return {
    text: `${limitedText}\n\n${notice}`,
    truncated: true,
    totalCharacters: args.totalCharacters,
    fullOutputPath: args.fullOutputPath,
    truncation: args.headTruncation,
  };
}

async function streamResponseText(
  response: Response,
  maxChars: number,
): Promise<StreamedResponseText> {
  if (!response.body) {
    return { text: "", truncated: false, totalCharacters: 0 };
  }

  const tempDir = await mkdtemp(join(tmpdir(), "pi-webfetch-"));
  const fullOutputPath = join(tempDir, "output.txt");
  const outputFile = await open(fullOutputPath, "w");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let headText = "";
  let totalCharacters = 0;
  let headTruncation: TruncationResult | undefined;
  let keepTempDir = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      await outputFile.write(value);
      const chunkText = decoder.decode(value, { stream: true });
      totalCharacters += chunkText.length;
      ({ headText, headTruncation } = appendChunkToHead({ headText, headTruncation, chunkText }));
    }

    const trailingText = decoder.decode();
    totalCharacters += trailingText.length;
    ({ headText, headTruncation } = appendChunkToHead({
      headText,
      headTruncation,
      chunkText: trailingText,
    }));

    const streamed = buildStreamedText({
      headText,
      totalCharacters,
      maxChars,
      fullOutputPath,
      headTruncation,
    });

    keepTempDir = streamed.truncated;
    return streamed;
  } finally {
    await outputFile.close();
    if (!keepTempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

function formatToolOutput(args: {
  isError: boolean;
  url: string;
  status: number;
  statusText: string;
  contentType: string;
  body: string;
}): string {
  const statusLabel = args.statusText ? `${args.status} ${args.statusText}` : `${args.status}`;

  return [
    args.isError ? "Web fetch failed" : "Web fetch succeeded",
    `URL: ${args.url || "(unknown)"}`,
    `Status: ${statusLabel}`,
    `Content-Type: ${args.contentType || "(missing)"}`,
    "",
    args.body || "(empty response body)",
  ].join("\n");
}

function createToolResult(args: {
  isError: boolean;
  requestedUrl: string;
  resolvedUrl: string;
  status: number;
  statusText: string;
  contentType: string;
  body: string;
  truncated?: boolean;
  originalCharacters?: number;
  returnedCharacters?: number;
  fullOutputPath?: string;
  truncation?: TruncationResult;
}): WebFetchToolResult {
  const safeResolvedUrl = redactUrlCredentials(args.resolvedUrl);
  const result: WebFetchToolResult = {
    content: [
      {
        type: "text",
        text: formatToolOutput({
          isError: args.isError,
          url: safeResolvedUrl,
          status: args.status,
          statusText: args.statusText,
          contentType: args.contentType,
          body: args.body,
        }),
      },
    ],
    details: buildDetails({
      requestedUrl: args.requestedUrl,
      resolvedUrl: args.resolvedUrl,
      status: args.status,
      statusText: args.statusText,
      contentType: args.contentType,
      truncated: args.truncated ?? false,
      originalCharacters: args.originalCharacters ?? 0,
      returnedCharacters: args.returnedCharacters ?? 0,
      fullOutputPath: args.fullOutputPath,
      truncation: args.truncation,
    }),
  };

  if (args.isError) {
    result.isError = true;
  }

  return result;
}

export default function webfetchExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "webfetch",
    label: "Web Fetch",
    description:
      "Fetch HTTP(S) pages without JS rendering. Sends Accept: text/markdown, text/html " +
      "(markdown first). Returns only text-like content types. Output is truncated to " +
      `${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first), ` +
      "then by maxChars; full output is saved to a temp file when truncated.",
    parameters: WebFetchParams,

    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) {
        return createToolResult({
          isError: true,
          requestedUrl: params.url,
          resolvedUrl: "",
          status: 499,
          statusText: "Cancelled",
          contentType: "",
          body: "Request cancelled before execution.",
        });
      }

      let targetUrl: URL;
      try {
        targetUrl = normalizeUrl(params.url);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return createToolResult({
          isError: true,
          requestedUrl: params.url,
          resolvedUrl: "",
          status: 400,
          statusText: "Bad Request",
          contentType: "",
          body: message,
        });
      }

      const blockReason = getPrivateHostBlockReason(targetUrl.hostname);
      if (blockReason) {
        return createToolResult({
          isError: true,
          requestedUrl: params.url,
          resolvedUrl: targetUrl.toString(),
          status: 403,
          statusText: "Forbidden",
          contentType: "",
          body:
            `${blockReason}. Set ${PRIVATE_HOST_OVERRIDE_ENV}=1 to allow private/internal hosts ` +
            "for trusted workflows.",
        });
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

        const contentType = response.headers.get("content-type") ?? "";
        if (!isTextContentType(contentType)) {
          const normalized = contentType.trim() || "(missing)";
          return createToolResult({
            isError: true,
            requestedUrl: params.url,
            resolvedUrl: response.url || targetUrl.toString(),
            status: response.status,
            statusText: response.statusText,
            contentType,
            body:
              `Unsupported content-type: ${normalized}. ` +
              "Only text responses are supported by this tool.",
          });
        }

        const maxChars = params.maxChars ?? DEFAULT_MAX_CHARS;
        const streamed = await streamResponseText(response, maxChars);

        if (!response.ok) {
          return createToolResult({
            isError: true,
            requestedUrl: params.url,
            resolvedUrl: response.url || targetUrl.toString(),
            status: response.status,
            statusText: response.statusText,
            contentType,
            body: streamed.text,
            truncated: streamed.truncated,
            originalCharacters: streamed.totalCharacters,
            returnedCharacters: streamed.text.length,
            fullOutputPath: streamed.fullOutputPath,
            truncation: streamed.truncation,
          });
        }

        return createToolResult({
          isError: false,
          requestedUrl: params.url,
          resolvedUrl: response.url || targetUrl.toString(),
          status: response.status,
          statusText: response.statusText,
          contentType,
          body: streamed.text,
          truncated: streamed.truncated,
          originalCharacters: streamed.totalCharacters,
          returnedCharacters: streamed.text.length,
          fullOutputPath: streamed.fullOutputPath,
          truncation: streamed.truncation,
        });
      } catch (error) {
        if (isAbortError(error, signal)) {
          return createToolResult({
            isError: true,
            requestedUrl: params.url,
            resolvedUrl: targetUrl.toString(),
            status: 499,
            statusText: "Cancelled",
            contentType: "",
            body: "Request cancelled.",
          });
        }

        const message = error instanceof Error ? error.message : String(error);
        return createToolResult({
          isError: true,
          requestedUrl: params.url,
          resolvedUrl: targetUrl.toString(),
          status: 500,
          statusText: "Request Failed",
          contentType: "",
          body: message,
        });
      }
    },
  });
}
