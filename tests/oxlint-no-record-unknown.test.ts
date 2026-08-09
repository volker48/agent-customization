import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const instruction = [
  "convert each instance to strongly typed domain types that have been parsed at the",
  "earliest time possible and as close to the io boundary the data originated from",
].join(" ");
const fixtureRoot = mkdtempSync(resolve(tmpdir(), "agent-customization-oxlint-"));
const fixtureName = `.oxlint-record-unknown-${process.pid}-${randomUUID()}.ts`;
const maintainedSourceFixtures = [
  resolve(repoRoot, "pi-extensions", fixtureName),
  resolve(repoRoot, "opencode-plugins", fixtureName),
  resolve(repoRoot, "tests", fixtureName),
  resolve(repoRoot, "scripts", fixtureName),
  resolve(repoRoot, ".opencode", "plugins", fixtureName),
] as const;

function runOxlint(source: string): { status: number; output: string } {
  const fixture = resolve(fixtureRoot, "fixture.ts");
  writeFileSync(fixture, source);

  try {
    execFileSync("pnpm", ["exec", "oxlint", "-c", ".oxlintrc.json", fixture], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe",
    });
    return { status: 0, output: "" };
  } catch (error) {
    const result = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: result.status ?? 1,
      output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    };
  }
}

function runRepositoryLint(fixture: string): { status: number; output: string } {
  writeFileSync(fixture, "type Unparsed = Record<string, unknown>;\n");
  try {
    execFileSync("pnpm", ["lint"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe",
    });
    return { status: 0, output: "" };
  } catch (error) {
    const result = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: result.status ?? 1,
      output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    };
  } finally {
    rmSync(fixture, { force: true });
  }
}

afterAll(() => {
  rmSync(fixtureRoot, { force: true, recursive: true });
  maintainedSourceFixtures.forEach((fixture) => rmSync(fixture, { force: true }));
});

describe("custom Record<string, unknown> oxlint rule", () => {
  it("fails with the domain-model instruction", () => {
    const result = runOxlint("type Unparsed = Record<string, unknown>;\n");

    expect(result.status).toBe(1);
    expect(result.output).toContain(`agent-customization(no-record-unknown): ${instruction}`);
  });

  it.each(maintainedSourceFixtures)("covers maintained TypeScript source root: %s", (fixture) => {
    const result = runRepositoryLint(fixture);

    expect(result.status).toBe(1);
    expect(result.output).toContain(relative(repoRoot, fixture));
    expect(result.output).toContain(instruction);
  });

  it("allows other Record instantiations", () => {
    const result = runOxlint(
      'type Strings = Record<string, string>;\ntype Named = Record<"name", unknown>;\n',
    );

    expect(result.status).toBe(0);
  });
});
