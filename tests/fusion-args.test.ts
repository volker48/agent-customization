import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseFusionArgs, readBundleFile } from "../pi-extensions/fusion/args.js";

describe("parseFusionArgs", () => {
  it("parses --file <path> and keeps the trailing prompt", () => {
    expect(parseFusionArgs("--file /tmp/prompt.md Does this plan cohere?")).toEqual({
      filePath: "/tmp/prompt.md",
      text: "Does this plan cohere?",
    });
  });

  it("parses --file=<path> form", () => {
    expect(parseFusionArgs("Review this --file=/tmp/prompt.md")).toEqual({
      filePath: "/tmp/prompt.md",
      text: "Review this",
    });
  });

  it("returns plain text when no file flag is present", () => {
    expect(parseFusionArgs("just a question")).toEqual({ text: "just a question" });
  });

  it.each(["--filename /tmp/prompt.md", "--filename=/tmp/prompt.md"])(
    "does not treat %s as the --file flag",
    (args) => {
      expect(parseFusionArgs(args)).toEqual({ text: args });
    },
  );

  it("leaves filePath undefined when --file has no path", () => {
    expect(parseFusionArgs("--file")).toEqual({ filePath: undefined, text: "" });
  });

  it("parses current-session capsule input with optional task text", () => {
    expect(parseFusionArgs("--capsule current compare the two approaches")).toEqual({
      capsuleReference: "current",
      text: "compare the two approaches",
    });
  });

  it("parses a saved capsule id or path without requiring task text", () => {
    expect(parseFusionArgs("--capsule /tmp/capsule.json")).toEqual({
      capsuleReference: "/tmp/capsule.json",
      text: "",
    });
  });

  it.each(["--capsules current", "--capsules=current"])(
    "does not treat %s as the --capsule flag",
    (args) => {
      expect(parseFusionArgs(args)).toEqual({ text: args });
    },
  );

  it("rejects --file and --capsule together", () => {
    expect(parseFusionArgs("--file bundle.md --capsule current task")).toMatchObject({
      error: { code: "conflicting-inputs" },
    });
  });

  it("reports a missing capsule reference", () => {
    expect(parseFusionArgs("--capsule")).toMatchObject({
      error: { code: "missing-capsule-reference" },
    });
  });
});

describe("readBundleFile", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fusion-bundle-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads the bundle contents verbatim", async () => {
    const path = join(dir, "prompt.md");
    await writeFile(path, "the whole prompt\n");

    await expect(readBundleFile(path)).resolves.toBe("the whole prompt\n");
  });

  it("throws a clear error when the file is missing", async () => {
    await expect(readBundleFile(join(dir, "nope.md"))).rejects.toThrow(
      /Could not read Fusion bundle file/,
    );
  });
});
