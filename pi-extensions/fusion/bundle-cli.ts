#!/usr/bin/env -S tsx

/**
 * Fusion bundle CLI.
 *
 * Materializes curated on-disk files into a single self-contained panel prompt
 * and writes it to a temp file. The Fusion panel and judge have no filesystem
 * access, so this deterministically renders the exact bytes the calling model
 * selected — the model picks files, this reads them. Invoked by the `fusion`
 * skill; the printed path is then handed to `/fusion --file <path>`.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectFiles, formatBundle } from "../lib/bundle-core.js";

export interface BundleCliArgs {
  question: string;
  patterns: string[];
  root?: string;
  out?: string;
}

export function buildPanelPrompt(question: string, bundle: string): string {
  return [question, "", "# Attached files", bundle].join("\n");
}

export function parseArgs(argv: string[]): BundleCliArgs {
  let question: string | undefined;
  let root: string | undefined;
  let out: string | undefined;
  const patterns: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const [flag, inlineValue] = splitFlag(arg);
    if (flag === "--question" || flag === "-q") {
      question = inlineValue ?? argv[(i += 1)];
    } else if (flag === "--root") {
      root = inlineValue ?? argv[(i += 1)];
    } else if (flag === "--out") {
      out = inlineValue ?? argv[(i += 1)];
    } else {
      patterns.push(arg);
    }
  }

  if (!question?.trim()) {
    throw new Error("Missing required --question <text>");
  }
  if (patterns.length === 0) {
    throw new Error("Provide at least one file path or glob to bundle");
  }
  return { question: question.trim(), patterns, root, out };
}

export async function buildBundle(
  args: BundleCliArgs,
): Promise<{ prompt: string; fileCount: number; bytes: number }> {
  const files = await collectFiles(args.patterns, { cwd: args.root ?? process.cwd() });
  const bundle = formatBundle(files, { lineNumbers: true });
  const bytes = files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0);
  return { prompt: buildPanelPrompt(args.question, bundle), fileCount: files.length, bytes };
}

async function resolveOutPath(out: string | undefined): Promise<string> {
  if (out) return path.resolve(out);
  const dir = await mkdtemp(path.join(tmpdir(), "fusion-bundle-"));
  return path.join(dir, "prompt.md");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { prompt, fileCount, bytes } = await buildBundle(args);
  const outPath = await resolveOutPath(args.out);
  await writeFile(outPath, prompt, "utf8");
  process.stderr.write(
    `Bundled ${fileCount} file(s), ${(bytes / 1024).toFixed(1)} KB → ${outPath}\n`,
  );
  process.stdout.write(`${outPath}\n`);
}

function splitFlag(arg: string): [string, string | undefined] {
  if (!arg.startsWith("--")) return [arg, undefined];
  const eq = arg.indexOf("=");
  return eq === -1 ? [arg, undefined] : [arg.slice(0, eq), arg.slice(eq + 1)];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
