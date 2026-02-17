/**
 * Generic web access extension for pi.
 *
 * Registers a `webfetch` tool used to access website URLs directly.
 *
 * Default Accept header behavior:
 *   "text/markdown, text/html" (markdown first)
 * Can be overridden with the `accept` parameter.
 */

import { StringEnum, Type } from "@mariozechner/pi-ai";
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

const DEFAULT_ACCEPT_HEADER = "text/markdown, text/html";
const DEFAULT_ACCEPT_ENCODING = "identity";
const DEFAULT_MAX_CHARS = 12000;
const MIN_MAX_CHARS = 1000;
const MAX_MAX_CHARS = 100000;
const DEFAULT_PROBE_MAX_BYTES = 8192;
const MAX_REDIRECTS = 10;

const FETCH_MODES = ["full", "probe"] as const;
type FetchMode = (typeof FETCH_MODES)[number];
const DEFAULT_FETCH_MODE: FetchMode = "full";

const FETCH_STRATEGIES = ["direct", "smart"] as const;
type FetchStrategy = (typeof FETCH_STRATEGIES)[number];
const DEFAULT_FETCH_STRATEGY: FetchStrategy = "direct";

const PRIVATE_HOST_OVERRIDE_ENV = "WEBFETCH_ALLOW_PRIVATE_HOSTS";
const REDACTED_CREDENTIALS = "[redacted]";

const TEXTUAL_CONTENT_TYPES = new Set([
  "application/json",
  "application/javascript",
  "application/xml",
  "application/xhtml+xml",
  "application/x-www-form-urlencoded",
  "application/x-sh",
  "application/x-shellscript",
  "application/shellscript",
]);

const METADATA_HOSTS = new Set(["metadata.google.internal"]);

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const RESERVED_REQUEST_HEADERS = new Set(["accept-encoding", "content-length", "host"]);

const SENSITIVE_REQUEST_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "x-api-key",
  "x-auth-token",
]);

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
  mode: Type.Optional(
    StringEnum(FETCH_MODES, {
      description: `Fetch mode: full response or quick probe (default: ${DEFAULT_FETCH_MODE})`,
    }),
  ),
  strategy: Type.Optional(
    StringEnum(FETCH_STRATEGIES, {
      description:
        `Fetch strategy: direct fetch or smart probe+fallback behavior (default: ` +
        `${DEFAULT_FETCH_STRATEGY})`,
    }),
  ),
  accept: Type.Optional(
    Type.String({
      description: `Optional Accept header override (default: ${DEFAULT_ACCEPT_HEADER})`,
      minLength: 1,
    }),
  ),
  headers: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description:
        "Optional custom request headers. Hop-by-hop and restricted headers are ignored.",
    }),
  ),
});

interface WebFetchDetails {
  requestedUrl: string;
  resolvedUrl: string;
  finalUrl: string;
  redirectChain: string[];
  acceptHeader: string;
  requestHeaders: Record<string, string>;
  blockedRequestHeaders: string[];
  mode: FetchMode;
  strategy: FetchStrategy;
  status: number;
  statusText: string;
  contentType: string;
  contentLength?: number;
  durationMs: number;
  truncated: boolean;
  truncatedByLines: boolean;
  truncatedByBytes: boolean;
  truncatedByMaxChars: boolean;
  originalCharacters: number;
  returnedCharacters: number;
  fullOutputPath?: string;
  truncation?: TruncationResult;
  detectedJsShell: boolean;
  jsShellSignals: string[];
  alternateCandidates: string[];
  alternateUrlUsed?: string;
  smartNotes: string[];
  probeBytesRead?: number;
  probeByteLimit?: number;
}

interface StreamedResponseText {
  text: string;
  truncated: boolean;
  charTruncated: boolean;
  totalCharacters: number;
  fullOutputPath?: string;
  truncation?: TruncationResult;
}

interface ProbeResponseText extends StreamedResponseText {
  probeBytesRead: number;
  probeByteLimit: number;
}

interface RequestHeaderPreparation {
  requestHeaders: Record<string, string>;
  redactedHeaders: Record<string, string>;
  blockedHeaders: string[];
  acceptHeader: string;
}

interface JsShellDetection {
  detected: boolean;
  signals: string[];
}

interface FetchWithRedirectsResult {
  response: Response;
  redirectChain: string[];
  finalUrl: string;
}

interface FetchAttemptSuccess {
  status: number;
  statusText: string;
  contentType: string;
  contentLength?: number;
  linkHeader: string | null;
  finalUrl: string;
  redirectChain: string[];
  streamed: StreamedResponseText | ProbeResponseText;
  jsShellDetection: JsShellDetection;
}

interface FetchAttemptUnsupportedContent {
  status: number;
  statusText: string;
  contentType: string;
  contentLength?: number;
  finalUrl: string;
  redirectChain: string[];
}

type FetchAttemptResult =
  | { kind: "success"; value: FetchAttemptSuccess }
  | { kind: "unsupported-content"; value: FetchAttemptUnsupportedContent };

interface SmartCandidate {
  url: string;
  source: "http-link-header" | "html-link-alternate" | "github-raw" | "wordpress-api";
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

class RedirectBlockedError extends Error {
  blockedUrl: string;
  reason: string;

  constructor(blockedUrl: string, reason: string) {
    super(`${reason} while following redirect to ${blockedUrl}`);
    this.name = "RedirectBlockedError";
    this.blockedUrl = blockedUrl;
    this.reason = reason;
  }
}

class TooManyRedirectsError extends Error {
  redirectChain: string[];

  constructor(redirectChain: string[]) {
    super(`Too many redirects (>${MAX_REDIRECTS})`);
    this.name = "TooManyRedirectsError";
    this.redirectChain = redirectChain;
  }
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

function buildUnsupportedContentMessage(contentType: string): string {
  const normalized = contentType.trim() || "(missing)";
  const guidance =
    "If this endpoint should be text, try an explicit Accept header (for example: " +
    '"text/plain, text/markdown, text/html").';

  return (
    `Unsupported content-type: ${normalized}. ` +
    "This tool only returns text-like responses. " +
    `${guidance} ` +
    "If the server uses a custom text MIME type, add it to the allowlist."
  );
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

function normalizeHeaderName(headerName: string): string {
  return headerName.trim().toLowerCase();
}

function isSensitiveHeader(headerName: string): boolean {
  const normalized = normalizeHeaderName(headerName);
  if (SENSITIVE_REQUEST_HEADERS.has(normalized)) {
    return true;
  }

  return (
    normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("password") ||
    normalized.includes("session")
  );
}

function redactHeaderValue(headerName: string, value: string): string {
  return isSensitiveHeader(headerName) ? REDACTED_CREDENTIALS : value;
}

function prepareRequestHeaders(args: {
  accept?: string;
  customHeaders?: Record<string, string>;
}): RequestHeaderPreparation {
  const acceptHeader = args.accept?.trim() || DEFAULT_ACCEPT_HEADER;
  const requestHeaders: Record<string, string> = {
    Accept: acceptHeader,
    "Accept-Encoding": DEFAULT_ACCEPT_ENCODING,
  };
  const blockedHeaders: string[] = [];

  for (const [rawName, rawValue] of Object.entries(args.customHeaders ?? {})) {
    const trimmedName = rawName.trim();
    if (!trimmedName) {
      continue;
    }

    const normalizedName = normalizeHeaderName(trimmedName);

    if (normalizedName === "accept") {
      if (!args.accept) {
        requestHeaders.Accept = rawValue;
      }
      continue;
    }

    if (
      HOP_BY_HOP_REQUEST_HEADERS.has(normalizedName) ||
      RESERVED_REQUEST_HEADERS.has(normalizedName)
    ) {
      blockedHeaders.push(trimmedName);
      continue;
    }

    requestHeaders[trimmedName] = rawValue;
  }

  const redactedHeaders = Object.fromEntries(
    Object.entries(requestHeaders).map(([name, value]) => [name, redactHeaderValue(name, value)]),
  );

  return {
    requestHeaders,
    redactedHeaders,
    blockedHeaders,
    acceptHeader: requestHeaders.Accept ?? acceptHeader,
  };
}

function detectJsShell(contentType: string, body: string): JsShellDetection {
  const normalizedType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (normalizedType !== "text/html") {
    return { detected: false, signals: [] };
  }

  const signals: string[] = [];
  const scriptTagCount = body.match(/<script\b/gi)?.length ?? 0;
  const hasRootContainer = /id=["'](?:root|app|__next|__nuxt)["']/i.test(body);
  const hasJavascriptRequiredText =
    /requires javascript|enable javascript|javascript is disabled/i.test(body);
  const hasHydrationMarker =
    /__NEXT_DATA__|window\.__NUXT__|data-reactroot|hydrateRoot\(|createRoot\(/i.test(body);

  const visibleText = body
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (scriptTagCount >= 5) {
    signals.push(`high script tag count (${scriptTagCount})`);
  }

  if (visibleText.length > 0 && visibleText.length < 220 && scriptTagCount >= 1) {
    signals.push(`very low visible text content (${visibleText.length} chars)`);
  }

  if (hasRootContainer) {
    signals.push("empty SPA root container detected");
  }

  if (hasJavascriptRequiredText) {
    signals.push("page indicates JavaScript is required");
  }

  if (hasHydrationMarker) {
    signals.push("framework hydration marker detected");
  }

  return {
    detected: signals.length >= 2,
    signals,
  };
}

function normalizeContentType(contentType: string): string {
  return contentType.split(";")[0]?.trim().toLowerCase() ?? "";
}

function isMarkdownMediaType(contentType: string): boolean {
  const normalized = normalizeContentType(contentType);
  return (
    normalized === "text/markdown" ||
    normalized === "text/x-markdown" ||
    normalized === "application/markdown" ||
    normalized.endsWith("+markdown")
  );
}

function isMarkdownLikeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return /\.(md|markdown)(?:$|\?)/i.test(parsed.pathname);
  } catch {
    return /\.(md|markdown)(?:$|\?)/i.test(url);
  }
}

function extractLinkHeaderParam(rawParams: string, paramName: string): string | undefined {
  const escapedName = paramName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`;\\s*${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^;,]+))`, "i");
  const match = rawParams.match(regex);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value?.trim();
}

function parseLinkHeaderAlternates(linkHeader: string | null, baseUrl: string): SmartCandidate[] {
  if (!linkHeader?.trim()) {
    return [];
  }

  const candidates: SmartCandidate[] = [];
  const entryRegex = /<([^>]+)>\s*((?:;\s*[^,]+)*)/g;

  let match: RegExpExecArray | null;
  while ((match = entryRegex.exec(linkHeader)) !== null) {
    const href = match[1]?.trim();
    const rawParams = match[2] ?? "";
    if (!href) {
      continue;
    }

    const relValue = extractLinkHeaderParam(rawParams, "rel") ?? "";
    const relTokens = relValue
      .toLowerCase()
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(Boolean);

    if (!relTokens.includes("alternate")) {
      continue;
    }

    const typeValue = extractLinkHeaderParam(rawParams, "type") ?? "";
    if (!isMarkdownMediaType(typeValue) && !isMarkdownLikeUrl(href)) {
      continue;
    }

    try {
      candidates.push({
        url: new URL(href, baseUrl).toString(),
        source: "http-link-header",
      });
    } catch {
      continue;
    }
  }

  return candidates;
}

function extractHtmlAttribute(tag: string, name: string): string | undefined {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
  const match = tag.match(regex);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function parseHtmlAlternates(html: string, baseUrl: string): SmartCandidate[] {
  if (!html.trim()) {
    return [];
  }

  const candidates: SmartCandidate[] = [];
  const linkTags = html.match(/<link\b[^>]*>/gi) ?? [];

  for (const linkTag of linkTags) {
    const relValue = extractHtmlAttribute(linkTag, "rel") ?? "";
    const relTokens = relValue
      .toLowerCase()
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(Boolean);
    if (!relTokens.includes("alternate")) {
      continue;
    }

    const href = extractHtmlAttribute(linkTag, "href")?.trim();
    if (!href) {
      continue;
    }

    const typeValue = extractHtmlAttribute(linkTag, "type") ?? "";
    if (!isMarkdownMediaType(typeValue) && !isMarkdownLikeUrl(href)) {
      continue;
    }

    try {
      candidates.push({
        url: new URL(href, baseUrl).toString(),
        source: "html-link-alternate",
      });
    } catch {
      continue;
    }
  }

  return candidates;
}

function buildGithubRawCandidate(url: string): SmartCandidate | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }

  if (parsed.hostname.toLowerCase() !== "github.com") {
    return undefined;
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 5 || segments[2] !== "blob") {
    return undefined;
  }

  const owner = segments[0];
  const repo = segments[1];
  const branch = segments[3];
  const filePath = segments.slice(4).join("/");
  if (!owner || !repo || !branch || !filePath) {
    return undefined;
  }

  return {
    url: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`,
    source: "github-raw",
  };
}

function buildWordPressApiCandidate(url: string): SmartCandidate | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }

  if (parsed.pathname.startsWith("/wp-json")) {
    return undefined;
  }

  return {
    url: `${parsed.origin}/wp-json`,
    source: "wordpress-api",
  };
}

function dedupeSmartCandidates(candidates: SmartCandidate[]): SmartCandidate[] {
  const seen = new Set<string>();
  const deduped: SmartCandidate[] = [];

  for (const candidate of candidates) {
    const normalized = candidate.url.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    deduped.push({ ...candidate, url: normalized });
  }

  return deduped;
}

function collectSmartCandidates(args: {
  linkHeader: string | null;
  body: string;
  finalUrl: string;
  jsShellDetected: boolean;
}): SmartCandidate[] {
  const linkHeaderCandidates = parseLinkHeaderAlternates(args.linkHeader, args.finalUrl);

  const htmlCandidates = parseHtmlAlternates(args.body, args.finalUrl);

  const heuristicCandidates: SmartCandidate[] = [];
  if (args.jsShellDetected) {
    const githubRaw = buildGithubRawCandidate(args.finalUrl);
    if (githubRaw) {
      heuristicCandidates.push(githubRaw);
    }

    const wpJson = buildWordPressApiCandidate(args.finalUrl);
    if (wpJson) {
      heuristicCandidates.push(wpJson);
    }
  }

  return dedupeSmartCandidates([
    ...linkHeaderCandidates,
    ...htmlCandidates,
    ...heuristicCandidates,
  ]);
}

function isUsefulSmartAlternate(result: FetchAttemptSuccess): boolean {
  if (result.status < 200 || result.status >= 300) {
    return false;
  }

  if (result.jsShellDetection.detected) {
    return false;
  }

  const normalizedText = result.streamed.text.replace(/\s+/g, " ").trim();
  return normalizedText.length > 0;
}

function buildSmartFallbackNotice(notes: string[]): string {
  const defaultNote =
    "Smart strategy: detected a JavaScript-heavy page but could not fetch a better markdown/API alternate.";
  const allNotes = notes.length > 0 ? notes : [defaultNote];

  return [
    "[Smart strategy note]",
    ...allNotes.map((note) => `- ${note}`),
    "- Try a machine-readable endpoint if available (e.g., /wp-json, raw markdown source, or project API).",
  ].join("\n");
}

function isRedirectStatus(status: number): boolean {
  return REDIRECT_STATUS_CODES.has(status);
}

async function fetchWithRedirects(args: {
  url: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
}): Promise<FetchWithRedirectsResult> {
  let currentUrl = args.url;
  const redirectChain = [currentUrl];

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const response = await fetch(currentUrl, {
      method: "GET",
      headers: args.headers,
      signal: args.signal,
      redirect: "manual",
    });

    if (!isRedirectStatus(response.status)) {
      return {
        response,
        redirectChain,
        finalUrl: currentUrl,
      };
    }

    const locationHeader = response.headers.get("location");
    if (!locationHeader) {
      return {
        response,
        redirectChain,
        finalUrl: currentUrl,
      };
    }

    const nextUrl = new URL(locationHeader, currentUrl).toString();
    const blockReason = getPrivateHostBlockReason(new URL(nextUrl).hostname);
    if (blockReason) {
      try {
        await response.body?.cancel();
      } catch {
        // ignore body cancel errors while aborting redirect handling
      }
      throw new RedirectBlockedError(nextUrl, blockReason);
    }

    try {
      await response.body?.cancel();
    } catch {
      // ignore body cancel errors while following redirects
    }

    redirectChain.push(nextUrl);
    currentUrl = nextUrl;

    if (redirectCount >= MAX_REDIRECTS) {
      throw new TooManyRedirectsError(redirectChain);
    }
  }

  throw new TooManyRedirectsError(redirectChain);
}

function parseContentLength(contentLengthHeader: string | null): number | undefined {
  if (!contentLengthHeader) {
    return undefined;
  }

  const parsed = Number.parseInt(contentLengthHeader, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }

  return parsed;
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
  finalUrl: string;
  redirectChain: string[];
  acceptHeader: string;
  requestHeaders: Record<string, string>;
  blockedRequestHeaders: string[];
  mode: FetchMode;
  strategy: FetchStrategy;
  status: number;
  statusText: string;
  contentType: string;
  contentLength?: number;
  durationMs: number;
  truncated: boolean;
  truncatedByLines: boolean;
  truncatedByBytes: boolean;
  truncatedByMaxChars: boolean;
  originalCharacters: number;
  returnedCharacters: number;
  fullOutputPath?: string;
  truncation?: TruncationResult;
  detectedJsShell: boolean;
  jsShellSignals: string[];
  alternateCandidates: string[];
  alternateUrlUsed?: string;
  smartNotes: string[];
  probeBytesRead?: number;
  probeByteLimit?: number;
}): WebFetchDetails {
  return {
    requestedUrl: redactRawUrlCredentials(args.requestedUrl),
    resolvedUrl: redactUrlCredentials(args.resolvedUrl),
    finalUrl: redactUrlCredentials(args.finalUrl),
    redirectChain: args.redirectChain.map((url) => redactUrlCredentials(url)),
    acceptHeader: args.acceptHeader,
    requestHeaders: args.requestHeaders,
    blockedRequestHeaders: args.blockedRequestHeaders,
    mode: args.mode,
    strategy: args.strategy,
    status: args.status,
    statusText: args.statusText,
    contentType: args.contentType,
    contentLength: args.contentLength,
    durationMs: args.durationMs,
    truncated: args.truncated,
    truncatedByLines: args.truncatedByLines,
    truncatedByBytes: args.truncatedByBytes,
    truncatedByMaxChars: args.truncatedByMaxChars,
    originalCharacters: args.originalCharacters,
    returnedCharacters: args.returnedCharacters,
    fullOutputPath: args.fullOutputPath,
    truncation: args.truncation,
    detectedJsShell: args.detectedJsShell,
    jsShellSignals: args.jsShellSignals,
    alternateCandidates: args.alternateCandidates.map((url) => redactUrlCredentials(url)),
    alternateUrlUsed: args.alternateUrlUsed
      ? redactUrlCredentials(args.alternateUrlUsed)
      : undefined,
    smartNotes: args.smartNotes,
    probeBytesRead: args.probeBytesRead,
    probeByteLimit: args.probeByteLimit,
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
      charTruncated: false,
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
    charTruncated,
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
    return { text: "", truncated: false, charTruncated: false, totalCharacters: 0 };
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

async function probeResponseText(
  response: Response,
  maxChars: number,
  probeByteLimit = DEFAULT_PROBE_MAX_BYTES,
): Promise<ProbeResponseText> {
  if (!response.body) {
    return {
      text: "",
      truncated: false,
      charTruncated: false,
      totalCharacters: 0,
      probeBytesRead: 0,
      probeByteLimit,
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let bytesRead = 0;
  let sampledText = "";
  let probeLimitReached = false;

  try {
    while (bytesRead < probeByteLimit) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }

      const remainingBytes = probeByteLimit - bytesRead;
      if (value.byteLength <= remainingBytes) {
        bytesRead += value.byteLength;
        sampledText += decoder.decode(value, { stream: true });
        continue;
      }

      const partialChunk = value.subarray(0, remainingBytes);
      bytesRead += partialChunk.byteLength;
      sampledText += decoder.decode(partialChunk, { stream: true });
      probeLimitReached = true;
      break;
    }

    sampledText += decoder.decode();
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore reader cancellation errors in probe mode
    }
  }

  if (bytesRead >= probeByteLimit) {
    probeLimitReached = true;
  }

  const charTruncated = sampledText.length > maxChars;
  const bodyText = charTruncated ? sampledText.slice(0, maxChars) : sampledText;

  const notices = [
    `Probe mode: sampled ${formatSize(bytesRead)}${probeLimitReached ? ` (limit ${formatSize(probeByteLimit)})` : ""}.`,
  ];
  if (charTruncated) {
    notices.push(`showing first ${maxChars} of ${sampledText.length} sampled characters.`);
  }

  return {
    text: bodyText ? `${bodyText}\n\n[${notices.join(" ")}]` : `[${notices.join(" ")}]`,
    truncated: probeLimitReached || charTruncated,
    charTruncated,
    totalCharacters: sampledText.length,
    probeBytesRead: bytesRead,
    probeByteLimit,
  };
}

async function fetchAttempt(args: {
  url: string;
  mode: FetchMode;
  maxChars: number;
  requestHeaders: Record<string, string>;
  signal?: AbortSignal;
}): Promise<FetchAttemptResult> {
  const { response, finalUrl, redirectChain } = await fetchWithRedirects({
    url: args.url,
    headers: args.requestHeaders,
    signal: args.signal,
  });

  const contentType = response.headers.get("content-type") ?? "";
  const contentLength = parseContentLength(response.headers.get("content-length"));
  const linkHeader = response.headers.get("link");

  if (!isTextContentType(contentType)) {
    try {
      await response.body?.cancel();
    } catch {
      // ignore response cancellation errors when content type is unsupported
    }

    return {
      kind: "unsupported-content",
      value: {
        status: response.status,
        statusText: response.statusText,
        contentType,
        contentLength,
        finalUrl,
        redirectChain,
      },
    };
  }

  const streamed =
    args.mode === "probe"
      ? await probeResponseText(response, args.maxChars)
      : await streamResponseText(response, args.maxChars);

  return {
    kind: "success",
    value: {
      status: response.status,
      statusText: response.statusText,
      contentType,
      contentLength,
      linkHeader,
      finalUrl,
      redirectChain,
      streamed,
      jsShellDetection: detectJsShell(contentType, streamed.text),
    },
  };
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
  finalUrl?: string;
  redirectChain?: string[];
  acceptHeader?: string;
  requestHeaders?: Record<string, string>;
  blockedRequestHeaders?: string[];
  mode?: FetchMode;
  strategy?: FetchStrategy;
  status: number;
  statusText: string;
  contentType: string;
  contentLength?: number;
  durationMs?: number;
  body: string;
  truncated?: boolean;
  truncatedByLines?: boolean;
  truncatedByBytes?: boolean;
  truncatedByMaxChars?: boolean;
  originalCharacters?: number;
  returnedCharacters?: number;
  fullOutputPath?: string;
  truncation?: TruncationResult;
  detectedJsShell?: boolean;
  jsShellSignals?: string[];
  alternateCandidates?: string[];
  alternateUrlUsed?: string;
  smartNotes?: string[];
  probeBytesRead?: number;
  probeByteLimit?: number;
}): WebFetchToolResult {
  const safeFinalUrl = redactUrlCredentials(args.finalUrl ?? args.resolvedUrl);
  const result: WebFetchToolResult = {
    content: [
      {
        type: "text",
        text: formatToolOutput({
          isError: args.isError,
          url: safeFinalUrl,
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
      finalUrl: args.finalUrl ?? args.resolvedUrl,
      redirectChain: args.redirectChain ?? [args.resolvedUrl],
      acceptHeader: args.acceptHeader ?? DEFAULT_ACCEPT_HEADER,
      requestHeaders: args.requestHeaders ?? {
        Accept: DEFAULT_ACCEPT_HEADER,
        "Accept-Encoding": DEFAULT_ACCEPT_ENCODING,
      },
      blockedRequestHeaders: args.blockedRequestHeaders ?? [],
      mode: args.mode ?? DEFAULT_FETCH_MODE,
      strategy: args.strategy ?? DEFAULT_FETCH_STRATEGY,
      status: args.status,
      statusText: args.statusText,
      contentType: args.contentType,
      contentLength: args.contentLength,
      durationMs: args.durationMs ?? 0,
      truncated: args.truncated ?? false,
      truncatedByLines: args.truncatedByLines ?? false,
      truncatedByBytes: args.truncatedByBytes ?? false,
      truncatedByMaxChars: args.truncatedByMaxChars ?? false,
      originalCharacters: args.originalCharacters ?? 0,
      returnedCharacters: args.returnedCharacters ?? 0,
      fullOutputPath: args.fullOutputPath,
      truncation: args.truncation,
      detectedJsShell: args.detectedJsShell ?? false,
      jsShellSignals: args.jsShellSignals ?? [],
      alternateCandidates: args.alternateCandidates ?? [],
      alternateUrlUsed: args.alternateUrlUsed,
      smartNotes: args.smartNotes ?? [],
      probeBytesRead: args.probeBytesRead,
      probeByteLimit: args.probeByteLimit,
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
      "Fetch HTTP(S) pages without JS rendering. Defaults to Accept: text/markdown, text/html " +
      "(markdown first), supports optional header overrides, probe mode, and a smart strategy " +
      "that probes first and can follow alternate markdown links. Returns only text-like content " +
      "types. Output is truncated to " +
      `${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first), ` +
      "then by maxChars; full output is saved to a temp file when truncated.",
    parameters: WebFetchParams,

    async execute(_toolCallId, params, signal) {
      const mode: FetchMode = params.mode ?? DEFAULT_FETCH_MODE;
      const strategy: FetchStrategy = params.strategy ?? DEFAULT_FETCH_STRATEGY;
      const maxChars = params.maxChars ?? DEFAULT_MAX_CHARS;
      const preparedHeaders = prepareRequestHeaders({
        accept: params.accept,
        customHeaders: params.headers,
      });

      const buildUnsupportedContentResult = (args: {
        attempt: FetchAttemptUnsupportedContent;
        smartNotes?: string[];
        alternateCandidates?: SmartCandidate[];
      }): WebFetchToolResult => {
        return createToolResult({
          isError: true,
          requestedUrl: params.url,
          resolvedUrl: args.attempt.finalUrl,
          finalUrl: args.attempt.finalUrl,
          redirectChain: args.attempt.redirectChain,
          acceptHeader: preparedHeaders.acceptHeader,
          requestHeaders: preparedHeaders.redactedHeaders,
          blockedRequestHeaders: preparedHeaders.blockedHeaders,
          mode,
          strategy,
          status: args.attempt.status,
          statusText: args.attempt.statusText,
          contentType: args.attempt.contentType,
          contentLength: args.attempt.contentLength,
          durationMs: Date.now() - startTime,
          body: buildUnsupportedContentMessage(args.attempt.contentType),
          alternateCandidates: (args.alternateCandidates ?? []).map((candidate) => candidate.url),
          smartNotes: args.smartNotes ?? [],
        });
      };

      const buildResultFromAttempt = (args: {
        attempt: FetchAttemptSuccess;
        isError: boolean;
        bodyOverride?: string;
        alternateCandidates?: SmartCandidate[];
        alternateUrlUsed?: string;
        smartNotes?: string[];
      }): WebFetchToolResult => {
        const body = args.bodyOverride ?? args.attempt.streamed.text;
        const probeDetails =
          "probeBytesRead" in args.attempt.streamed
            ? {
                probeBytesRead: args.attempt.streamed.probeBytesRead,
                probeByteLimit: args.attempt.streamed.probeByteLimit,
              }
            : {};

        return createToolResult({
          isError: args.isError,
          requestedUrl: params.url,
          resolvedUrl: args.attempt.finalUrl,
          finalUrl: args.attempt.finalUrl,
          redirectChain: args.attempt.redirectChain,
          acceptHeader: preparedHeaders.acceptHeader,
          requestHeaders: preparedHeaders.redactedHeaders,
          blockedRequestHeaders: preparedHeaders.blockedHeaders,
          mode,
          strategy,
          status: args.attempt.status,
          statusText: args.attempt.statusText,
          contentType: args.attempt.contentType,
          contentLength: args.attempt.contentLength,
          durationMs: Date.now() - startTime,
          body,
          truncated: args.attempt.streamed.truncated,
          truncatedByLines: args.attempt.streamed.truncation?.truncatedBy === "lines",
          truncatedByBytes: args.attempt.streamed.truncation?.truncatedBy === "bytes",
          truncatedByMaxChars: args.attempt.streamed.charTruncated,
          originalCharacters: args.attempt.streamed.totalCharacters,
          returnedCharacters: body.length,
          fullOutputPath: args.attempt.streamed.fullOutputPath,
          truncation: args.attempt.streamed.truncation,
          detectedJsShell: args.attempt.jsShellDetection.detected,
          jsShellSignals: args.attempt.jsShellDetection.signals,
          alternateCandidates: (args.alternateCandidates ?? []).map((candidate) => candidate.url),
          alternateUrlUsed: args.alternateUrlUsed,
          smartNotes: args.smartNotes ?? [],
          ...probeDetails,
        });
      };

      if (signal?.aborted) {
        return createToolResult({
          isError: true,
          requestedUrl: params.url,
          resolvedUrl: "",
          finalUrl: "",
          redirectChain: [],
          acceptHeader: preparedHeaders.acceptHeader,
          requestHeaders: preparedHeaders.redactedHeaders,
          blockedRequestHeaders: preparedHeaders.blockedHeaders,
          mode,
          strategy,
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
          finalUrl: "",
          redirectChain: [],
          acceptHeader: preparedHeaders.acceptHeader,
          requestHeaders: preparedHeaders.redactedHeaders,
          blockedRequestHeaders: preparedHeaders.blockedHeaders,
          mode,
          strategy,
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
          finalUrl: targetUrl.toString(),
          redirectChain: [targetUrl.toString()],
          acceptHeader: preparedHeaders.acceptHeader,
          requestHeaders: preparedHeaders.redactedHeaders,
          blockedRequestHeaders: preparedHeaders.blockedHeaders,
          mode,
          strategy,
          status: 403,
          statusText: "Forbidden",
          contentType: "",
          body:
            `${blockReason}. Set ${PRIVATE_HOST_OVERRIDE_ENV}=1 to allow private/internal hosts ` +
            "for trusted workflows.",
        });
      }

      const startTime = Date.now();

      try {
        const targetUrlString = targetUrl.toString();

        if (strategy === "direct") {
          const directAttempt = await fetchAttempt({
            url: targetUrlString,
            mode,
            maxChars,
            requestHeaders: preparedHeaders.requestHeaders,
            signal,
          });

          if (directAttempt.kind === "unsupported-content") {
            return buildUnsupportedContentResult({
              attempt: directAttempt.value,
            });
          }

          return buildResultFromAttempt({
            attempt: directAttempt.value,
            isError: directAttempt.value.status < 200 || directAttempt.value.status >= 300,
          });
        }

        const smartNotes: string[] = [
          "Smart strategy: performed initial probe fetch before full retrieval.",
        ];

        const probeAttemptResult = await fetchAttempt({
          url: targetUrlString,
          mode: "probe",
          maxChars,
          requestHeaders: preparedHeaders.requestHeaders,
          signal,
        });

        if (probeAttemptResult.kind === "unsupported-content") {
          smartNotes.push("Probe detected non-text content; stopping before fallback attempts.");
          return buildUnsupportedContentResult({
            attempt: probeAttemptResult.value,
            smartNotes,
          });
        }

        const probeAttempt = probeAttemptResult.value;
        const alternateCandidates = collectSmartCandidates({
          linkHeader: probeAttempt.linkHeader,
          body: probeAttempt.streamed.text,
          finalUrl: probeAttempt.finalUrl,
          jsShellDetected: probeAttempt.jsShellDetection.detected,
        });

        if (alternateCandidates.length > 0) {
          smartNotes.push(
            `Found ${alternateCandidates.length} alternate markdown/API candidate` +
              `${alternateCandidates.length === 1 ? "" : "s"}.`,
          );
        } else {
          smartNotes.push("No alternate markdown/API candidates discovered from probe response.");
        }

        for (const candidate of alternateCandidates) {
          let candidateUrl: URL;
          try {
            candidateUrl = new URL(candidate.url);
          } catch {
            smartNotes.push(
              `Skipped invalid alternate URL from ${candidate.source}: ${candidate.url}`,
            );
            continue;
          }

          const privateCandidateReason = getPrivateHostBlockReason(candidateUrl.hostname);
          if (privateCandidateReason) {
            smartNotes.push(
              `Skipped alternate ${candidate.url}: ${privateCandidateReason.toLowerCase()}.`,
            );
            continue;
          }

          const alternateAttemptResult = await fetchAttempt({
            url: candidateUrl.toString(),
            mode,
            maxChars,
            requestHeaders: preparedHeaders.requestHeaders,
            signal,
          });

          if (alternateAttemptResult.kind === "unsupported-content") {
            smartNotes.push(
              `Alternate ${candidate.url} returned unsupported content-type ` +
                `${alternateAttemptResult.value.contentType || "(missing)"}.`,
            );
            continue;
          }

          if (!isUsefulSmartAlternate(alternateAttemptResult.value)) {
            smartNotes.push(
              `Alternate ${candidate.url} was not useful ` +
                `(status ${alternateAttemptResult.value.status}, jsShell=${alternateAttemptResult.value.jsShellDetection.detected}).`,
            );
            continue;
          }

          smartNotes.push(`Using alternate source from ${candidate.source}: ${candidate.url}`);
          return buildResultFromAttempt({
            attempt: alternateAttemptResult.value,
            isError: false,
            alternateCandidates,
            alternateUrlUsed: candidate.url,
            smartNotes,
          });
        }

        if (!probeAttempt.jsShellDetection.detected && mode === "probe") {
          smartNotes.push("Probe appears useful; returning probe response without full refetch.");
          return buildResultFromAttempt({
            attempt: probeAttempt,
            isError: probeAttempt.status < 200 || probeAttempt.status >= 300,
            alternateCandidates,
            smartNotes,
          });
        }

        const primaryAttemptResult = await fetchAttempt({
          url: probeAttempt.finalUrl,
          mode,
          maxChars,
          requestHeaders: preparedHeaders.requestHeaders,
          signal,
        });

        if (primaryAttemptResult.kind === "unsupported-content") {
          return buildUnsupportedContentResult({
            attempt: primaryAttemptResult.value,
            alternateCandidates,
            smartNotes,
          });
        }

        const primaryAttempt = primaryAttemptResult.value;

        if (probeAttempt.jsShellDetection.detected && !isUsefulSmartAlternate(primaryAttempt)) {
          smartNotes.push(
            "Primary response still appears JS-heavy and no better alternate source was found.",
          );

          return buildResultFromAttempt({
            attempt: primaryAttempt,
            isError: primaryAttempt.status < 200 || primaryAttempt.status >= 300,
            bodyOverride: `${primaryAttempt.streamed.text}\n\n${buildSmartFallbackNotice(smartNotes)}`,
            alternateCandidates,
            smartNotes,
          });
        }

        return buildResultFromAttempt({
          attempt: primaryAttempt,
          isError: primaryAttempt.status < 200 || primaryAttempt.status >= 300,
          alternateCandidates,
          smartNotes,
        });
      } catch (error) {
        const durationMs = Date.now() - startTime;

        if (isAbortError(error, signal)) {
          return createToolResult({
            isError: true,
            requestedUrl: params.url,
            resolvedUrl: targetUrl.toString(),
            finalUrl: targetUrl.toString(),
            redirectChain: [targetUrl.toString()],
            acceptHeader: preparedHeaders.acceptHeader,
            requestHeaders: preparedHeaders.redactedHeaders,
            blockedRequestHeaders: preparedHeaders.blockedHeaders,
            mode,
            strategy,
            status: 499,
            statusText: "Cancelled",
            contentType: "",
            durationMs,
            body: "Request cancelled.",
          });
        }

        if (error instanceof RedirectBlockedError) {
          return createToolResult({
            isError: true,
            requestedUrl: params.url,
            resolvedUrl: error.blockedUrl,
            finalUrl: error.blockedUrl,
            redirectChain: [targetUrl.toString(), error.blockedUrl],
            acceptHeader: preparedHeaders.acceptHeader,
            requestHeaders: preparedHeaders.redactedHeaders,
            blockedRequestHeaders: preparedHeaders.blockedHeaders,
            mode,
            strategy,
            status: 403,
            statusText: "Forbidden",
            contentType: "",
            durationMs,
            body:
              `${error.reason}. Set ${PRIVATE_HOST_OVERRIDE_ENV}=1 to allow private/internal hosts ` +
              "for trusted workflows.",
          });
        }

        if (error instanceof TooManyRedirectsError) {
          const finalRedirectUrl =
            error.redirectChain[error.redirectChain.length - 1] ?? targetUrl.toString();
          return createToolResult({
            isError: true,
            requestedUrl: params.url,
            resolvedUrl: finalRedirectUrl,
            finalUrl: finalRedirectUrl,
            redirectChain: error.redirectChain,
            acceptHeader: preparedHeaders.acceptHeader,
            requestHeaders: preparedHeaders.redactedHeaders,
            blockedRequestHeaders: preparedHeaders.blockedHeaders,
            mode,
            strategy,
            status: 508,
            statusText: "Loop Detected",
            contentType: "",
            durationMs,
            body: error.message,
          });
        }

        const message = error instanceof Error ? error.message : String(error);
        return createToolResult({
          isError: true,
          requestedUrl: params.url,
          resolvedUrl: targetUrl.toString(),
          finalUrl: targetUrl.toString(),
          redirectChain: [targetUrl.toString()],
          acceptHeader: preparedHeaders.acceptHeader,
          requestHeaders: preparedHeaders.redactedHeaders,
          blockedRequestHeaders: preparedHeaders.blockedHeaders,
          mode,
          strategy,
          status: 500,
          statusText: "Request Failed",
          contentType: "",
          durationMs,
          body: message,
        });
      }
    },
  });
}
