import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  parseSupervisorArgs,
  resolvePinnedPiCliPath,
  supervisorLoopExitCode,
  supervisorWakeExitCode,
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
        "--allow-unsandboxed-host-tools",
      ]),
    ).toMatchObject({
      workspace: "/tmp/workspace",
      stateRoot: "/tmp/headlong-state",
      timeoutMs: 45_000,
      once: true,
      allowUnsandboxedHostTools: true,
    });
    expect(() => parseSupervisorArgs(["--timeout-seconds", "0"])).toThrow(/timeout/i);
  });

  it("uses nonzero exit codes for unsuccessful supervisor outcomes", () => {
    expect(supervisorWakeExitCode({ kind: "failed-closed", reason: "failure" })).toBe(1);
    expect(supervisorWakeExitCode({ kind: "owned" })).toBe(1);
    expect(supervisorWakeExitCode({ kind: "not-due", status: "paused" })).toBe(0);
    expect(
      supervisorWakeExitCode({ kind: "transitioned", status: "completed", wakeId: "wake-1" }),
    ).toBe(0);

    expect(supervisorLoopExitCode({ kind: "missing" })).toBe(1);
    expect(supervisorLoopExitCode({ kind: "exhausted" })).toBe(1);
    expect(supervisorLoopExitCode({ kind: "terminal", status: "paused" })).toBe(1);
    expect(supervisorLoopExitCode({ kind: "terminal", status: "completed-unverified" })).toBe(1);
    expect(supervisorLoopExitCode({ kind: "terminal", status: "completed" })).toBe(0);
    expect(supervisorLoopExitCode({ kind: "terminal", status: "stopped" })).toBe(0);
    expect(supervisorLoopExitCode({ kind: "aborted" })).toBe(0);
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
