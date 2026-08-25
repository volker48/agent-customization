import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  parseSupervisorArgs,
  resolvePinnedPiCliPath,
} from "../pi-extensions/headlong/cli.js";

describe("Headlong supervisor CLI", () => {
  it("parses an explicit workspace, private state root, timeout, and one-shot mode", () => {
    expect(
      parseSupervisorArgs([
        "--workspace",
        "/tmp/workspace",
        "--state-root",
        "/tmp/headlong-state",
        "--timeout-seconds",
        "45",
        "--once",
      ]),
    ).toMatchObject({
      workspace: "/tmp/workspace",
      stateRoot: "/tmp/headlong-state",
      timeoutMs: 45_000,
      once: true,
    });
    expect(() => parseSupervisorArgs(["--timeout-seconds", "0"])).toThrow(/timeout/i);
  });

  it("resolves the installed pinned Pi executable through its public ESM package entry", () => {
    expect(resolvePinnedPiCliPath()).toMatch(/pi-coding-agent\/dist\/cli\.js$/);
  });

  it("publishes the supervisor binary and pinned-Pi verifier through package scripts", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      bin: Record<string, string>;
      scripts: Record<string, string>;
    };
    expect(packageJson.bin["pi-headlong"]).toBe("./pi-extensions/headlong/cli.ts");
    expect(packageJson.scripts["test:headlong"]).toContain("headlong");
    expect(packageJson.scripts["verify:headlong"]).toContain("verify-headlong");
  });
});
