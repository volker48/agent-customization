import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildBundle, buildPanelPrompt, parseArgs } from "../pi-extensions/fusion/bundle-cli.js";

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
});
