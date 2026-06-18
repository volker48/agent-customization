import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { startRemoteDaemon } from "../pi-extensions/remote/daemon.js";
import { connectIpcExtension, startIpcDaemonServer } from "../pi-extensions/remote/ipc.js";

const roots: string[] = [];
const cliPath = fileURLToPath(new URL("../pi-extensions/remote/cli.ts", import.meta.url));

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-remote-cli-"));
  roots.push(root);
  return root;
}

describe("pi-remote CLI", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("reports the daemon as down when the socket is missing", async () => {
    const result = await runCli(await tempRoot(), "status");

    expect(result).toMatchObject({ code: 0, stdout: "Remote daemon is not running\n", stderr: "" });
  });

  it("prints the running daemon registry summary", async () => {
    const root = await tempRoot();
    const daemon = await startIpcDaemonServer(join(root, "daemon.sock"));
    const extension = await connectIpcExtension(join(root, "daemon.sock"), {
      sessionId: "session-1",
      name: "Work session",
      cwd: "/repo",
    });
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "allowed-node-ids.json"), JSON.stringify(["node-a", "node-b"]));

    try {
      await daemon.waitForSession("session-1");
      const result = await runCli(root, "status");

      expect(result).toMatchObject({
        code: 0,
        stderr: "",
        stdout: [
          "Remote daemon is running",
          "Sessions: 1",
          "- session-1 Work session (/repo)",
          "Paired devices: 2",
          "",
        ].join("\n"),
      });
    } finally {
      await extension.close();
      await daemon.close();
    }
  });

  it("requests clean daemon shutdown and removes the socket", async () => {
    const root = await tempRoot();
    const daemon = await startRemoteDaemon({ remoteRoot: root, pairingCode: "123-456" });

    const result = await runCli(root, "stop");

    expect(result).toMatchObject({ code: 0, stdout: "Remote daemon stop requested\n", stderr: "" });
    await expect(stat(daemon.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports stop as not running when the socket is missing", async () => {
    const result = await runCli(await tempRoot(), "stop");

    expect(result).toMatchObject({ code: 0, stdout: "Remote daemon is not running\n", stderr: "" });
  });
});

function runCli(remoteRoot: string, command: string): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["exec", "tsx", cliPath, command], {
      env: { ...process.env, PI_REMOTE_ROOT: remoteRoot },
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

type CliResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};
