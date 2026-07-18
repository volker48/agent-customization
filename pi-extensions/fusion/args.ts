/**
 * Argument parsing for `/fusion`. Supports a plain prompt, a pre-built bundle
 * file, or a current/saved Context Capsule input. Bundle and capsule inputs are
 * mutually exclusive.
 */

import { readFile } from "node:fs/promises";

export type FusionArgsErrorCode = "missing-capsule-reference" | "conflicting-inputs";

export interface FusionArgs {
  filePath?: string;
  capsuleReference?: string;
  text: string;
  error?: { code: FusionArgsErrorCode; message: string };
}

export function parseFusionArgs(raw: string): FusionArgs {
  const text = raw.trim();
  const fileMatch = text.match(/(?:^|\s)--file(?=\s|=|$)(?:=(\S+)|\s+(\S+))?/);
  const capsuleMatch = text.match(/(?:^|\s)--capsule(?=\s|=|$)(?:=(\S+)|\s+(\S+))?/);
  const filePath = fileMatch?.[1] ?? fileMatch?.[2];
  const capsuleReference = capsuleMatch?.[1] ?? capsuleMatch?.[2];

  if (fileMatch && capsuleMatch) {
    return {
      text: removeMatches(text, [fileMatch, capsuleMatch]),
      error: {
        code: "conflicting-inputs",
        message: "Fusion accepts either --file or --capsule, not both.",
      },
    };
  }
  if (capsuleMatch && !capsuleReference) {
    return {
      text: removeMatches(text, [capsuleMatch]),
      error: {
        code: "missing-capsule-reference",
        message: "--capsule requires current or a saved capsule id/path.",
      },
    };
  }
  if (fileMatch) {
    return { filePath, text: removeMatches(text, [fileMatch]) };
  }
  if (capsuleMatch) {
    return { capsuleReference, text: removeMatches(text, [capsuleMatch]) };
  }
  return { text };
}

export async function readBundleFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read Fusion bundle file at ${path}: ${message}`);
  }
}

function removeMatches(text: string, matches: RegExpMatchArray[]): string {
  return matches
    .slice()
    .sort((left, right) => (right.index ?? 0) - (left.index ?? 0))
    .reduce((remaining, match) => {
      const start = match.index ?? 0;
      return remaining.slice(0, start) + remaining.slice(start + match[0].length);
    }, text)
    .trim();
}
