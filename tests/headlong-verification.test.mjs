import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("Headlong pinned Pi verifier", () => {
  it("loads the real 0.84.2 extension and exercises durable tool and supervisor transitions", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "scripts/verify-headlong-extension.mjs"],
      { cwd: process.cwd(), timeout: 30_000 },
    );

    expect(stdout).toContain("[headlong-verify] Pi 0.84.2 extension loaded");
    expect(stdout).toContain("[headlong-verify] durable tool transition: completed");
    expect(stdout).toContain("[headlong-verify] real RPC supervisor child: transitioned");
    expect(stdout).toContain("[headlong-verify] PASS");
  }, 45_000);
});
