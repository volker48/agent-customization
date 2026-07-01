import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildManifestPrompt,
  parseFusionArgs,
  readManifest,
  validateManifest,
} from "../pi-extensions/fusion/manifest.js";

describe("parseFusionArgs", () => {
  it("parses --manifest <path> and keeps the trailing question", () => {
    expect(parseFusionArgs("--manifest /tmp/m.json Does this plan cohere?")).toEqual({
      manifestPath: "/tmp/m.json",
      text: "Does this plan cohere?",
    });
  });

  it("parses --manifest=<path> form", () => {
    expect(parseFusionArgs("Review this --manifest=/tmp/m.json")).toEqual({
      manifestPath: "/tmp/m.json",
      text: "Review this",
    });
  });

  it("returns plain text when no manifest flag is present", () => {
    expect(parseFusionArgs("just a question")).toEqual({ text: "just a question" });
  });

  it("leaves manifestPath undefined when --manifest has no path", () => {
    expect(parseFusionArgs("--manifest")).toEqual({ manifestPath: undefined, text: "" });
  });
});

describe("validateManifest", () => {
  it("accepts a valid manifest", () => {
    expect(validateManifest({ files: ["a.ts"], question: "q", root: "/r" })).toEqual({
      files: ["a.ts"],
      question: "q",
      root: "/r",
    });
  });

  it("rejects a manifest without files", () => {
    expect(() => validateManifest({ question: "q" })).toThrow(/non-empty array/);
  });

  it("rejects non-string file entries", () => {
    expect(() => validateManifest({ files: [1] })).toThrow(/must be strings/);
  });

  it("rejects a non-string question", () => {
    expect(() => validateManifest({ files: ["a.ts"], question: 5 })).toThrow(/question/);
  });
});

describe("readManifest", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fusion-manifest-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads and validates a manifest file", async () => {
    const path = join(dir, "m.json");
    await writeFile(path, JSON.stringify({ files: ["a.ts"], question: "q" }));

    await expect(readManifest(path)).resolves.toEqual({
      files: ["a.ts"],
      question: "q",
      root: undefined,
    });
  });

  it("throws a clear error for invalid JSON", async () => {
    const path = join(dir, "bad.json");
    await writeFile(path, "{not json");

    await expect(readManifest(path)).rejects.toThrow(/Invalid Fusion manifest JSON/);
  });
});

describe("buildManifestPrompt", () => {
  it("places the question first, then the attached files", () => {
    const prompt = buildManifestPrompt("Is this coherent?", "### File 1: a.ts\n```ts\nx\n```");

    expect(prompt.startsWith("Is this coherent?")).toBe(true);
    expect(prompt).toContain("# Attached files");
    expect(prompt.indexOf("Is this coherent?")).toBeLessThan(prompt.indexOf("# Attached files"));
  });
});
