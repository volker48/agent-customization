/**
 * Fusion manifest: a throwaway JSON file the calling model writes after it has
 * explored the codebase, naming the exact files and question to hand to the
 * panel. The panel has no filesystem access, so `/fusion --manifest <path>`
 * reads the manifest, materializes the referenced files into a bundle, and
 * passes the whole string verbatim to the panel and judge.
 */

import { readFile } from "node:fs/promises";

export interface FusionManifest {
  files: string[];
  question?: string;
  root?: string;
}

export interface FusionArgs {
  manifestPath?: string;
  text: string;
}

export async function readManifest(path: string): Promise<FusionManifest> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Could not read Fusion manifest at ${path}: ${messageOf(error)}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid Fusion manifest JSON at ${path}: ${messageOf(error)}`);
  }

  return validateManifest(value);
}

export function validateManifest(value: unknown): FusionManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Fusion manifest must be a JSON object");
  }

  const manifest = value as Partial<FusionManifest>;
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error("Fusion manifest requires non-empty array field: files");
  }
  for (const file of manifest.files) {
    if (typeof file !== "string") {
      throw new Error("Fusion manifest files must be strings");
    }
  }
  if (manifest.question !== undefined && typeof manifest.question !== "string") {
    throw new Error("Fusion manifest question must be a string");
  }
  if (manifest.root !== undefined && typeof manifest.root !== "string") {
    throw new Error("Fusion manifest root must be a string");
  }

  return { files: manifest.files, question: manifest.question, root: manifest.root };
}

export function parseFusionArgs(raw: string): FusionArgs {
  let text = raw.trim();

  const eqMatch = text.match(/(?:^|\s)--manifest=(\S+)/);
  if (eqMatch) {
    return {
      manifestPath: eqMatch[1],
      text: spliceOut(text, eqMatch.index ?? 0, eqMatch[0].length),
    };
  }

  const flagMatch = text.match(/(?:^|\s)--manifest(?:\s+(\S+))?/);
  if (flagMatch) {
    return {
      manifestPath: flagMatch[1],
      text: spliceOut(text, flagMatch.index ?? 0, flagMatch[0].length),
    };
  }

  return { text };
}

export function buildManifestPrompt(question: string, bundle: string): string {
  return [question, "", "# Attached files", bundle].join("\n");
}

function spliceOut(text: string, start: number, length: number): string {
  return (text.slice(0, start) + text.slice(start + length)).trim();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
