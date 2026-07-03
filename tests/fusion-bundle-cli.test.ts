import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildBundle, buildPanelPrompt, parseArgs } from "../pi-extensions/fusion/bundle-cli.js";
import { collectFiles } from "../pi-extensions/lib/bundle-core.js";

const execFileAsync = promisify(execFile);

describe("parseArgs", () => {
  it("parses --question, --root, --out, and file patterns", () => {
    expect(
      parseArgs(["--question", "Does this cohere?", "--root", "/r", "--out", "/o.md", "src/*.ts"]),
    ).toEqual({ question: "Does this cohere?", root: "/r", out: "/o.md", patterns: ["src/*.ts"] });
  });

  it("supports --flag=value form", () => {
    expect(parseArgs(["--question=hi", "a.ts"])).toEqual({ question: "hi", patterns: ["a.ts"] });
  });

  it("throws when --question is missing", () => {
    expect(() => parseArgs(["a.ts"])).toThrow(/--question/);
  });

  it("throws when no file patterns are given", () => {
    expect(() => parseArgs(["--question", "hi"])).toThrow(/at least one file/);
  });
});

describe("buildPanelPrompt", () => {
  it("places the question first, then the attached files", () => {
    const prompt = buildPanelPrompt("Is this coherent?", "### File 1: a.ts");

    expect(prompt.startsWith("Is this coherent?")).toBe(true);
    expect(prompt.indexOf("Is this coherent?")).toBeLessThan(prompt.indexOf("# Attached files"));
  });
});

describe("buildBundle", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fusion-cli-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("materializes selected files with line numbers into the prompt", async () => {
    await writeFile(join(dir, "a.ts"), "const a = 1;\n");

    const { prompt, fileCount, bytes } = await buildBundle({
      question: "Does this cohere?",
      patterns: ["a.ts"],
      root: dir,
    });

    expect(fileCount).toBe(1);
    expect(bytes).toBe(13);
    expect(prompt).toContain("Does this cohere?");
    expect(prompt).toContain("### File 1: a.ts");
    expect(prompt).toContain("1 | const a = 1;");
  });

  it("rejects absolute paths and parent-directory escapes", async () => {
    await expect(collectFiles([join(dir, "a.ts")], { cwd: dir })).rejects.toThrow(
      /Absolute paths are not allowed/,
    );
    await expect(collectFiles(["../outside.ts"], { cwd: dir })).rejects.toThrow(/stay within root/);
  });

  it("rejects symlinks that resolve outside the bundle root", async () => {
    const outside = await mkdtemp(join(tmpdir(), "fusion-outside-"));
    try {
      await writeFile(join(outside, "secret.txt"), "secret\n");
      await symlink(join(outside, "secret.txt"), join(dir, "secret-link.txt"));

      await expect(collectFiles(["secret-link.txt"], { cwd: dir })).rejects.toThrow(
        /stay within root/,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects oversized files before materializing content", async () => {
    await writeFile(join(dir, "large.txt"), "abcdef");

    await expect(collectFiles(["large.txt"], { cwd: dir, maxFileSizeBytes: 5 })).rejects.toThrow(
      /exceed.*5 B/,
    );
  });

  it("prunes generated dependency directories from broad globs", async () => {
    await mkdir(join(dir, "src"));
    await mkdir(join(dir, "node_modules"));
    await writeFile(join(dir, "src", "kept.ts"), "export const kept = true;\n");
    await writeFile(join(dir, "node_modules", "dropped.ts"), "export const dropped = true;\n");

    const files = await collectFiles(["**/*.ts"], { cwd: dir });

    expect(files.map((file) => file.displayPath)).toEqual(["src/kept.ts"]);
  });

  it("rejects explicit gitignored files and drops ignored glob matches", async () => {
    await execFileAsync("git", ["-C", dir, "init"]);
    await writeFile(join(dir, ".gitignore"), "secret.txt\n");
    await writeFile(join(dir, "secret.txt"), "secret\n");
    await writeFile(join(dir, "visible.txt"), "visible\n");

    await expect(collectFiles(["secret.txt"], { cwd: dir })).rejects.toThrow(/git-ignored/);
    const files = await collectFiles(["*.txt"], { cwd: dir });

    expect(files.map((file) => file.displayPath)).toEqual(["visible.txt"]);
  });
});
