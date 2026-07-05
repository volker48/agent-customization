import { chmod, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runCancel } from "../plugins/pi/scripts/lib/cancel.mjs";
import {
  createImplementationJob,
  persistJob,
  updateJobRecord,
} from "../plugins/pi/scripts/lib/jobs.mjs";
import { runResult, runStatus } from "../plugins/pi/scripts/lib/inspect.mjs";
import { isProcessAlive, terminateProcessTree } from "../plugins/pi/scripts/lib/process-tree.mjs";

const COMPANION = join(process.cwd(), "plugins/pi/scripts/pi-companion.mjs");
const PLUGIN_MANIFEST = join(process.cwd(), "plugins/pi/.claude-plugin/plugin.json");
const PLUGIN_HOOKS = join(process.cwd(), "plugins/pi/hooks/hooks.json");

async function runCompanion(args: string[], input: string, env: NodeJS.ProcessEnv, cwd: string) {
  const child = spawn(process.execPath, [COMPANION, ...args], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.stdin.end(input);
  const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
  return { status, stderr, stdout };
}

async function writeExecutableScript(
  prefix: string,
  filename: string,
  script: string,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const path = join(dir, filename);
  await writeFile(path, `#!/usr/bin/env node\n${script}`);
  await chmod(path, 0o755);
  return path;
}

async function writeFakePi(script: string): Promise<string> {
  return writeExecutableScript("fake-pi-background-", "fake-pi.mjs", script);
}

function fakePiScript(logPath: string, abortFinishes: boolean): string {
  const abortHandler = abortFinishes
    ? `emit({ id: command.id, type: "response", success: true });
       emit({ type: "agent_end", messages: [] });`
    : `record({ type: "abort-received" });`;
  return `
import { appendFileSync, writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(logPath)}, "");
process.stdin.setEncoding("utf8");
let buffer = "";
function emit(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }
function record(command) {
  appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(command) + "\\n");
}
record({ type: "argv", argv: process.argv.slice(2) });
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\\n")) {
    const index = buffer.indexOf("\\n");
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    record(command);
    if (command.type === "get_state") emit({ id: command.id, type: "response", success: true,
      data: { model: { provider: "openai", id: "gpt-5.5" }, sessionId: "bg-session" } });
    if (command.type === "prompt") emit({ id: command.id, type: "response", success: true });
    if (command.type === "abort") { ${abortHandler} }
  }
});
process.on("SIGTERM", () => record({ type: "sigterm" }));
`;
}

function extractJobId(output: string): string {
  const match = output.match(/^Job: (.+)$/m);
  if (!match) throw new Error(`Missing job id in output: ${output}`);
  return match[1];
}

async function waitForStatus(
  dataDir: string,
  workspaceRoot: string,
  jobId: string,
  status: string,
) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const result = await runResult(jobId, { dataDir, workspaceRoot });
    if (result.job?.status === status) return result.job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${jobId} to become ${status}`);
}

async function waitForLogCommands(path: string) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const log = await readFile(path, "utf8").catch(() => "");
    if (log.trim()) return log.trim().split("\n").map((line) => JSON.parse(line));
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for fake Pi log: ${path}`);
}

async function waitForPid(path: string) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const pid = Number.parseInt(await readFile(path, "utf8").catch(() => ""), 10);
    if (Number.isInteger(pid) && isProcessAlive(pid)) return pid;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for process pid: ${path}`);
}

async function waitForProcessDeath(pid: number) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for process to exit: ${pid}`);
}

describe("Pi background implementation cancellation", () => {
  it("declares a Claude SessionEnd hook for scoped session cleanup", async () => {
    const manifest = JSON.parse(await readFile(PLUGIN_MANIFEST, "utf8"));
    const hooks = JSON.parse(await readFile(PLUGIN_HOOKS, "utf8"));
    const sessionEndHook = hooks.hooks.SessionEnd[0].hooks[0];

    expect(manifest.hooks).toBe("./hooks/hooks.json");
    expect(sessionEndHook.type).toBe("command");
    expect(sessionEndHook.command).toBe("node");
    expect(sessionEndHook.args).toEqual([
      "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs",
      "session-cleanup",
    ]);
  });

  it("stores background implementation briefs in the job file", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-bg-data-"));
    const workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), "pi-bg-workspace-")));
    const logPath = join(dataDir, "fake-pi.jsonl");
    const fakePi = await writeFakePi(fakePiScript(logPath, true));
    const env = { ...process.env, PI_CLI: fakePi, PI_COMPANION_DATA_DIR: dataDir };

    const started = await runCompanion(
      ["implement", "--background"],
      "persist this background brief",
      env,
      workspaceRoot,
    );
    const jobId = extractJobId(started.stdout);
    await waitForStatus(dataDir, workspaceRoot, jobId, "running");
    const result = await runResult(jobId, { dataDir, workspaceRoot });
    if (!result.job) throw new Error(`Missing job: ${jobId}`);
    const job = JSON.parse(await readFile(result.job.jobFile, "utf8"));

    expect(started.status).toBe(0);
    expect(job.brief).toBe("persist this background brief");
    expect(result.report).not.toContain("persist this background brief");

    await runCancel(jobId, { dataDir, workspaceRoot, timeoutMs: 500 });
    await waitForStatus(dataDir, workspaceRoot, jobId, "cancelled");
  }, 20_000);

  it("starts a background job and updates status/result ledgers", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-bg-data-"));
    const workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), "pi-bg-workspace-")));
    const logPath = join(dataDir, "fake-pi.jsonl");
    const fakePi = await writeFakePi(fakePiScript(logPath, true));
    const env = { ...process.env, PI_CLI: fakePi, PI_COMPANION_DATA_DIR: dataDir };

    const started = await runCompanion(
      ["implement", "--background"],
      "--model anthropic/claude-sonnet-4 background task",
      env,
      workspaceRoot,
    );
    const jobId = extractJobId(started.stdout);
    await waitForStatus(dataDir, workspaceRoot, jobId, "running");
    const status = await runStatus({ dataDir, workspaceRoot });
    const commands = await waitForLogCommands(logPath);
    const argv = commands.find((command) => command.type === "argv")?.argv ?? [];

    expect(started.status).toBe(0);
    expect(started.stdout).toContain("Status: queued");
    expect(started.stdout).toContain("Model: anthropic/claude-sonnet-4");
    expect(status.report).toContain(jobId);
    expect(argv).toContain("--model");
    expect(argv).toContain("anthropic/claude-sonnet-4");

    await runCancel(jobId, { dataDir, workspaceRoot, timeoutMs: 500 });
    await waitForStatus(dataDir, workspaceRoot, jobId, "cancelled");
  }, 20_000);

  it("cancels through Pi RPC abort before marking the job cancelled", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-bg-data-"));
    const workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), "pi-bg-workspace-")));
    const logPath = join(dataDir, "fake-pi.jsonl");
    const fakePi = await writeFakePi(fakePiScript(logPath, true));
    const env = { ...process.env, PI_CLI: fakePi, PI_COMPANION_DATA_DIR: dataDir };

    const started = await runCompanion(
      ["implement", "--background"],
      "cancel task",
      env,
      workspaceRoot,
    );
    const jobId = extractJobId(started.stdout);
    await waitForStatus(dataDir, workspaceRoot, jobId, "running");
    const cancelled = await runCompanion(["cancel", jobId], "", env, workspaceRoot);
    const job = await waitForStatus(dataDir, workspaceRoot, jobId, "cancelled");
    const commands = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(cancelled.status).toBe(0);
    expect(job.phase).toBe("cancelled");
    expect(commands.map((command) => command.type)).toContain("abort");
  }, 20_000);

  it("keeps a real completion that wins the cancel race", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-bg-data-"));
    const workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), "pi-bg-workspace-")));
    const job = createImplementationJob({
      dataDir,
      workspaceRoot,
      id: "impl-completes-during-cancel",
      status: "running",
      phase: "running",
    });
    await persistJob(job);

    const cancel = runCancel(job.id, { dataDir, workspaceRoot, timeoutMs: 1_000 });
    const cancellingJob = await waitForStatus(dataDir, workspaceRoot, job.id, "cancelling");
    await updateJobRecord(cancellingJob, {
      status: "completed",
      phase: "completed",
      result: "real completion",
      summary: "real completion",
    });
    const cancelled = await cancel;
    const result = await runResult(job.id, { dataDir, workspaceRoot });

    expect(cancelled.job.status).toBe("completed");
    expect(result.job?.status).toBe("completed");
    expect(result.job?.summary).toBe("real completion");
  }, 20_000);

  it("falls back to process-tree termination when abort does not finish", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-bg-data-"));
    const workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), "pi-bg-workspace-")));
    const logPath = join(dataDir, "fake-pi.jsonl");
    const fakePi = await writeFakePi(fakePiScript(logPath, false));
    const env = { ...process.env, PI_CLI: fakePi, PI_COMPANION_DATA_DIR: dataDir };

    const started = await runCompanion(
      ["implement", "--background"],
      "stuck task",
      env,
      workspaceRoot,
    );
    const jobId = extractJobId(started.stdout);
    await waitForStatus(dataDir, workspaceRoot, jobId, "running");
    const cancelled = await runCompanion(["cancel", jobId], "", env, workspaceRoot);
    const log = await readFile(logPath, "utf8");

    expect(cancelled.stdout).toContain("Status: cancelled");
    expect(log).toContain('"type":"abort"');
  }, 20_000);

  it("session cleanup cancels active jobs owned by the ending Claude session", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-bg-data-"));
    const workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), "pi-bg-workspace-")));
    const logPath = join(dataDir, "fake-pi.jsonl");
    const fakePi = await writeFakePi(fakePiScript(logPath, true));
    const env = {
      ...process.env,
      CLAUDE_CODE_SESSION_ID: "claude-session-a",
      PI_CLI: fakePi,
      PI_COMPANION_DATA_DIR: dataDir,
    };
    const unrelated = createImplementationJob({
      dataDir,
      ownerClaudeSessionId: "claude-session-b",
      workspaceRoot,
    });
    await persistJob(unrelated);

    const started = await runCompanion(
      ["implement", "--background"],
      "cleanup task",
      env,
      workspaceRoot,
    );
    const jobId = extractJobId(started.stdout);
    await waitForStatus(dataDir, workspaceRoot, jobId, "running");
    const cleanup = await runCompanion(
      ["session-cleanup"],
      JSON.stringify({ cwd: workspaceRoot, session_id: "claude-session-a" }),
      env,
      workspaceRoot,
    );
    const job = await waitForStatus(dataDir, workspaceRoot, jobId, "cancelled");
    const otherJob = await runResult(unrelated.id, { dataDir, workspaceRoot });

    expect(cleanup.status).toBe(0);
    expect(cleanup.stdout).toContain(`${jobId}: cancelled`);
    expect(job.status).toBe("cancelled");
    expect(otherJob.job?.status).toBe("running");
  }, 20_000);

  it("session cleanup falls back to the environment for malformed hook input", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-bg-data-"));
    const workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), "pi-bg-workspace-")));
    const logPath = join(dataDir, "fake-pi.jsonl");
    const fakePi = await writeFakePi(fakePiScript(logPath, true));
    const env = {
      ...process.env,
      CLAUDE_CODE_SESSION_ID: "claude-session-a",
      PI_CLI: fakePi,
      PI_COMPANION_DATA_DIR: dataDir,
    };

    const started = await runCompanion(
      ["implement", "--background"],
      "cleanup malformed hook task",
      env,
      workspaceRoot,
    );
    const jobId = extractJobId(started.stdout);
    await waitForStatus(dataDir, workspaceRoot, jobId, "running");
    const cleanup = await runCompanion(["session-cleanup"], "{not json", env, workspaceRoot);
    const job = await waitForStatus(dataDir, workspaceRoot, jobId, "cancelled");

    expect(cleanup.status).toBe(0);
    expect(cleanup.stdout).toContain(`${jobId}: cancelled`);
    expect(job.status).toBe("cancelled");
  }, 20_000);

  it("terminates descendants that outlive the root process", async () => {
    const pidFile = join(await mkdtemp(join(tmpdir(), "pi-tree-")), "child.pid");
    const childScript = await writeExecutableScript(
      "pi-tree-child-",
      "child.mjs",
      `
import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`,
    );
    const parentScript = await writeExecutableScript(
      "pi-tree-parent-",
      "parent.mjs",
      `
import { spawn } from "node:child_process";
const child = spawn(process.execPath, [${JSON.stringify(childScript)}, process.argv[2]], {
  stdio: "ignore",
});
child.unref();
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
    );
    const parent = spawn(process.execPath, [parentScript, pidFile], { stdio: "ignore" });
    const childPid = await waitForPid(pidFile);

    try {
      await expect(
        terminateProcessTree(parent.pid ?? 0, { killTimeoutMs: 500, timeoutMs: 200 }),
      ).resolves.toBe(true);
      await waitForProcessDeath(childPid);
    } finally {
      if (parent.pid && isProcessAlive(parent.pid)) process.kill(parent.pid, "SIGKILL");
      if (isProcessAlive(childPid)) process.kill(childPid, "SIGKILL");
    }
  }, 20_000);
});
