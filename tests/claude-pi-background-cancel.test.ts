import { chmod, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { cleanupActiveJobs, runCancel } from "../plugins/pi/scripts/lib/cancel.mjs";
import {
  createImplementationJob,
  persistJob,
  updateJobRecord,
} from "../plugins/pi/scripts/lib/jobs.mjs";
import { runResult, runStatus } from "../plugins/pi/scripts/lib/inspect.mjs";

const COMPANION = join(process.cwd(), "plugins/pi/scripts/pi-companion.mjs");

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
  const status = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  return { status, stderr, stdout };
}

async function writeFakePi(script: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fake-pi-background-"));
  const path = join(dir, "fake-pi.mjs");
  await writeFile(path, `#!/usr/bin/env node\n${script}`);
  await chmod(path, 0o755);
  return path;
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

describe("Pi background implementation cancellation", () => {
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
  });

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
  });

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
  });

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
  });

  it("session cleanup cancels active jobs owned by the ending Claude session", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-bg-data-"));
    const workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), "pi-bg-workspace-")));
    const logPath = join(dataDir, "fake-pi.jsonl");
    const fakePi = await writeFakePi(fakePiScript(logPath, true));
    const env = {
      ...process.env,
      CLAUDE_SESSION_ID: "claude-session-a",
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
    const cleanup = await cleanupActiveJobs({
      dataDir,
      ownerClaudeSessionId: "claude-session-a",
      workspaceRoot,
      timeoutMs: 500,
    });
    const job = await waitForStatus(dataDir, workspaceRoot, jobId, "cancelled");
    const otherJob = await runResult(unrelated.id, { dataDir, workspaceRoot });

    expect(cleanup.cancelled).toEqual([`${jobId}: cancelled`]);
    expect(job.status).toBe("cancelled");
    expect(otherJob.job?.status).toBe("running");
  });
});
