import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BundleError, collectFiles, formatBundle } from "../pi-extensions/lib/bundle-core.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bundle-core-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("collectFiles", () => {
  it("collects literal files with their contents, sorted by path", async () => {
    await writeFile(join(dir, "b.ts"), "export const b = 2;\n");
    await writeFile(join(dir, "a.ts"), "export const a = 1;\n");

    const files = await collectFiles(["b.ts", "a.ts"], { cwd: dir });

    expect(files.map((f) => f.displayPath)).toEqual(["a.ts", "b.ts"]);
    expect(files[0].content).toBe("export const a = 1;\n");
  });

  it("expands globs and prunes default-ignored directories", async () => {
    await writeFile(join(dir, "keep.ts"), "keep");
    await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(dir, "node_modules", "pkg", "index.ts"), "ignored");

    const files = await collectFiles(["**/*.ts"], { cwd: dir });

    expect(files.map((f) => f.displayPath)).toEqual(["keep.ts"]);
  });

  it("applies ! exclude patterns", async () => {
    await writeFile(join(dir, "src.ts"), "src");
    await writeFile(join(dir, "src.test.ts"), "test");

    const files = await collectFiles(["*.ts", "!*.test.ts"], { cwd: dir });

    expect(files.map((f) => f.displayPath)).toEqual(["src.ts"]);
  });

  it("throws BundleError for a missing literal file", async () => {
    await expect(collectFiles(["nope.ts"], { cwd: dir })).rejects.toBeInstanceOf(BundleError);
  });

  it("throws when no files match", async () => {
    await expect(collectFiles(["*.rs"], { cwd: dir })).rejects.toBeInstanceOf(BundleError);
  });

  it("throws when a file exceeds the size limit", async () => {
    await writeFile(join(dir, "big.ts"), "x".repeat(2000));

    await expect(collectFiles(["big.ts"], { cwd: dir, maxFileSizeBytes: 1000 })).rejects.toThrow(
      /exceed/,
    );
  });

  it("excludes root-level files with a **/ exclude pattern", async () => {
    await writeFile(join(dir, "src.ts"), "src");
    await writeFile(join(dir, "root.test.ts"), "root test");
    await mkdir(join(dir, "nested"), { recursive: true });
    await writeFile(join(dir, "nested", "deep.test.ts"), "deep test");

    const files = await collectFiles(["**/*.ts", "!**/*.test.ts"], { cwd: dir });

    expect(files.map((f) => f.displayPath)).toEqual(["src.ts"]);
  });

  it("rejects absolute paths", async () => {
    await expect(collectFiles(["/etc/hosts"], { cwd: dir })).rejects.toThrow(/Absolute/);
  });

  it("rejects paths that escape the root", async () => {
    await expect(collectFiles(["../secrets.txt"], { cwd: dir })).rejects.toThrow(/within root/);
  });
});

describe("collectFiles gitignore handling", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "bundle-git-"));
    execFileSync("git", ["-C", repo, "init", "-q"]);
    await writeFile(join(repo, ".gitignore"), "secret.txt\n");
    await writeFile(join(repo, "secret.txt"), "TOKEN=abc123");
    await writeFile(join(repo, "keep.ts"), "keep");
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("drops git-ignored files from glob matches", async () => {
    const files = await collectFiles(["*"], { cwd: repo });

    const paths = files.map((f) => f.displayPath);
    expect(paths).toContain("keep.ts");
    expect(paths).not.toContain("secret.txt");
  });

  it("rejects a git-ignored file requested as a literal", async () => {
    await expect(collectFiles(["secret.txt"], { cwd: repo })).rejects.toThrow(/git-ignored/);
  });
});

describe("formatBundle", () => {
  it("renders language-tagged sections with line numbers", () => {
    const bundle = formatBundle(
      [{ displayPath: "src/a.ts", content: "const a = 1;\nconst b = 2;" }],
      {
        lineNumbers: true,
      },
    );

    expect(bundle).toContain("### File 1: src/a.ts");
    expect(bundle).toContain("Lines: 1-2");
    expect(bundle).toContain("```ts");
    expect(bundle).toContain("1 | const a = 1;");
    expect(bundle).toContain("2 | const b = 2;");
  });

  it("uses a fence longer than any backtick run inside the content", () => {
    const content = "```\nnested fence\n```";
    const bundle = formatBundle([{ displayPath: "readme.md", content }], { lineNumbers: false });

    expect(bundle).toContain("````md");
    expect(bundle.trimEnd().endsWith("````")).toBe(true);
  });

  it("omits line numbers when disabled", () => {
    const bundle = formatBundle([{ displayPath: "a.ts", content: "const a = 1;" }], {
      lineNumbers: false,
    });

    expect(bundle).not.toContain("Lines:");
    expect(bundle).not.toContain("1 | ");
  });
});
