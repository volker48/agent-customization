/**
 * Argument parsing for `/fusion`. Supports a plain prompt (`/fusion <text>`) or
 * a pre-built bundle file (`/fusion --file <path>`) produced by the `fusion`
 * skill's bundle script, whose contents are passed to the panel verbatim.
 */

import { readFile } from "node:fs/promises";

export interface FusionArgs {
  filePath?: string;
  text: string;
}

export function parseFusionArgs(raw: string): FusionArgs {
  const text = raw.trim();

  const eqMatch = text.match(/(?:^|\s)--file=(\S+)/);
  if (eqMatch) {
    return { filePath: eqMatch[1], text: spliceOut(text, eqMatch.index ?? 0, eqMatch[0].length) };
  }

  const flagMatch = text.match(/(?:^|\s)--file(?:\s+(\S+))?/);
  if (flagMatch) {
    return {
      filePath: flagMatch[1],
      text: spliceOut(text, flagMatch.index ?? 0, flagMatch[0].length),
    };
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

function spliceOut(text: string, start: number, length: number): string {
  return (text.slice(0, start) + text.slice(start + length)).trim();
}
