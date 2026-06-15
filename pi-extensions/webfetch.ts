/**
 * Generic web access extension for pi.
 *
 * Registers a `webfetch` tool used to access website URLs directly. The fetch
 * implementation lives in webfetch-core.ts so it can be shared with Fusion.
 */

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { executeWebfetch, type WebFetchInput, WebFetchParams } from "./lib/webfetch-core.js";

export default function webfetchExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "webfetch",
    label: "Web Fetch",
    description:
      "Fetch HTTP(S) pages without JS rendering. Defaults to an Accept header that prefers " +
      "markdown over HTML, supports optional header overrides, probe mode, and a smart strategy " +
      "that probes first and can follow alternate markdown links. Returns only text-like content " +
      "types. Output is truncated to " +
      `${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first), ` +
      "then by maxChars; full output is saved to a temp file when truncated.",
    parameters: WebFetchParams,

    async execute(_toolCallId, params, signal) {
      return executeWebfetch(params as WebFetchInput, signal);
    },
  });
}
