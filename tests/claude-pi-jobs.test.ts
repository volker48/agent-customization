import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { runImplement } from "../plugins/pi/scripts/lib/implement.mjs";
import { runResult, runStatus } from "../plugins/pi/scripts/lib/inspect.mjs";
import { createImplementationJob, persistJob } from "../plugins/pi/scripts/lib/jobs.mjs";

const COMPANION = join(process.cwd(), "plugins/pi/scripts/pi-companion.mjs");
const execFileAsync = promisify(execFile);

async function runCompanion(args: string[], input: string, env: NodeJS.ProcessEnv, cwd: string) {
  const child = spawn(process.execPath, [COMPANION, ...args], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stdin.end(input);
  const status = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  return { status, stdout };
}

async function writeFakePi(script: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fake-pi-jobs-"));
  const path = join(dir, "fake-pi.mjs");
  await writeFile(path, script);
  return path;
}

function fakePiScript(
  finalText = "Implemented audit support. Tests: pnpm test:unit.",
  promptSideEffect = "",
): string {
  return `
import { writeFileSync } from "node:fs";
process.stdin.setEncoding("utf8");
let buffer = "";
function emit(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\\n")) {
    const index = buffer.indexOf("\\n");
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    if (command.type === "get_state") emit({ id: command.id, type: "response", success: true, data: {
      model: { provider: "openai-codex", id: "gpt-5.5", name: "GPT 5.5" },
      sessionId: "audit-session",
      sessionFile: "/tmp/audit-session.jsonl"
    }});
    if (command.type === "prompt") {
${promptSideEffect}
      emit({ id: command.id, type: "response", success: true });
      emit({ type: "agent_end", messages: [] });
    }
    if (command.type === "get_last_assistant_text") emit({
      id: command.id,
      type: "response",
      success: true,
      data: { text: ${JSON.stringify(finalText)} }
    });
  }
});
process.on("SIGTERM", () => process.exit(0));
`;
}

describe("Pi implementation job audit ledger", () => {
  it("creates and updates workspace-scoped implementation job records", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-jobs-data-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "pi-jobs-workspace-"));
    const fakePi = await writeFakePi(fakePiScript());

    const result = await runImplement({
      brief: "Implement auditable job records.",
      dataDir,
      piCommand: process.execPath,
      piPrefixArgs: [fakePi],
      timeoutMs: 1_000,
      workspaceRoot,
    });

    const job = JSON.parse(await readFile(result.jobFile, "utf8"));

    expect(result.ok).toBe(true);
    expect(result.report).toContain(`Job: ${job.id}`);
    expect(job).toMatchObject({
      kind: "implement",
      status: "completed",
      phase: "completed",
      workspaceRoot,
      sessionId: "audit-session",
      piSessionFile: "/tmp/audit-session.jsonl",
      model: "openai-codex/gpt-5.5",
      summary: "Implemented audit support. Tests: pnpm test:unit.",
      result: "Implemented audit support. Tests: pnpm test:unit.",
      changedFiles: [],
      testsRun: [{ command: "pnpm test:unit", status: "reported" }],
    });
    expect(job.jobFile).toContain(join(dataDir, "workspaces"));
    expect(job.logFile).toContain(join(dataDir, "workspaces"));
    expect(job.logFile).not.toContain("Implement auditable job records");
    expect(await readFile(job.logFile, "utf8")).toContain('"event":"finished"');
  });

  it("reports only files dirtied after the implementation job starts", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-jobs-data-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "pi-jobs-workspace-"));
    const createdPath = join(workspaceRoot, "created-by-job.txt");
    await execFileAsync("git", ["init"], { cwd: workspaceRoot });
    await writeFile(join(workspaceRoot, "preexisting.txt"), "already dirty");
    const fakePi = await writeFakePi(
      fakePiScript(
        "Implemented audit support. Tests: pnpm test:unit.",
        `      writeFileSync(${JSON.stringify(createdPath)}, "created by job");`,
      ),
    );

    const result = await runImplement({
      brief: "Implement auditable job records.",
      dataDir,
      piCommand: process.execPath,
      piPrefixArgs: [fakePi],
      timeoutMs: 1_000,
      workspaceRoot,
    });

    const job = JSON.parse(await readFile(result.jobFile, "utf8"));

    expect(result.ok).toBe(true);
    expect(job.initialChangedFiles).toEqual(["preexisting.txt"]);
    expect(job.changedFiles).toEqual(["created-by-job.txt"]);
  });

  it("extracts test evidence from markdown bullets", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-jobs-data-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "pi-jobs-workspace-"));
    const fakePi = await writeFakePi(
      fakePiScript("Implemented audit support.\n- Tests: pnpm test"),
    );

    const result = await runImplement({
      brief: "Implement auditable job records.",
      dataDir,
      piCommand: process.execPath,
      piPrefixArgs: [fakePi],
      timeoutMs: 1_000,
      workspaceRoot,
    });

    const job = JSON.parse(await readFile(result.jobFile, "utf8"));

    expect(result.ok).toBe(true);
    expect(job.testsRun).toEqual([{ command: "pnpm test", status: "reported" }]);
  });

  it("renders status and result reports with follow-up commands and evidence", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-jobs-data-"));
    const workspaceRoot = "/repo-under-test";
    const job = createImplementationJob({ dataDir, workspaceRoot, id: "impl-audit" });
    Object.assign(job, {
      status: "completed",
      phase: "completed",
      model: "openai-codex/gpt-5.5",
      sessionId: "session-123",
      piSessionFile: "/tmp/session-123.jsonl",
      summary: "Changed the audit workflow.",
      result: "Final implementation report.",
      changedFiles: ["plugins/pi/scripts/lib/jobs.mjs"],
      testsRun: [{ command: "pnpm test:unit", status: "passed" }],
      completedAt: "2026-07-04T00:00:01.000Z",
    });
    await persistJob(job);

    const status = await runStatus({ dataDir, workspaceRoot });
    const result = await runResult("latest", { dataDir, workspaceRoot });

    expect(status.report).toContain("# Pi jobs");
    expect(status.report).toContain("impl-audit");
    expect(status.report).toContain("/pi:result impl-audit");
    expect(result.ok).toBe(true);
    expect(result.report).toContain("Final implementation report.");
    expect(result.report).toContain("- plugins/pi/scripts/lib/jobs.mjs");
    expect(result.report).toContain("- pnpm test:unit: passed");
    expect(result.report).toContain("Session: session-123");
    expect(result.report).toContain(`Log: ${job.logFile}`);
  });

  it("tolerates malformed and partial job records while reading the ledger", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-jobs-data-"));
    const workspaceRoot = "/repo-under-test";
    const job = createImplementationJob({ dataDir, workspaceRoot, id: "impl-partial" });
    const malformedPath = join(dirname(job.jobFile), "broken.json");
    Object.assign(job, { status: "running", phase: "prompting" });

    await mkdir(dirname(job.jobFile), { recursive: true });
    await persistJob(job);
    await writeFile(malformedPath, "{not json");

    const status = await runStatus({ dataDir, workspaceRoot });
    const missing = await runResult("does-not-exist", { dataDir, workspaceRoot });

    expect(status.report).toContain("impl-partial");
    expect(status.report).toContain("Warning: Skipped unreadable job record broken.json");
    expect(missing.ok).toBe(false);
    expect(missing.report).toContain("Job not found: does-not-exist");
  });

  it("exits zero for successful status and result commands", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-jobs-data-"));
    const workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), "pi-jobs-workspace-")));
    const env = { ...process.env, PI_COMPANION_DATA_DIR: dataDir };
    const job = createImplementationJob({ dataDir, workspaceRoot, id: "impl-exit" });
    Object.assign(job, { status: "completed", phase: "completed", result: "done" });
    await persistJob(job);

    const status = await runCompanion(["status"], "", env, workspaceRoot);
    const result = await runCompanion(["result"], "latest", env, workspaceRoot);

    expect(status.status).toBe(0);
    expect(status.stdout).toContain("impl-exit");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Final output");
  });
});
