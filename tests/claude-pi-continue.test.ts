import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runContinue } from "../plugins/pi/scripts/lib/implement.mjs";
import { runResult } from "../plugins/pi/scripts/lib/inspect.mjs";
import { createImplementationJob, persistJob } from "../plugins/pi/scripts/lib/jobs.mjs";

const COMPANION = join(process.cwd(), "plugins/pi/scripts/pi-companion.mjs");

async function runCompanion(args: string[], input: string, env: NodeJS.ProcessEnv, cwd: string) {
  const child = spawn(process.execPath, [COMPANION, ...args], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  let stdout = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stdin.end(input);
  const status = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  return { status, stderr, stdout };
}

async function writeFakePi(logPath: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fake-pi-continue-"));
  const path = join(dir, "fake-pi.mjs");
  await writeFile(path, `#!/usr/bin/env node\n${fakePiScript(logPath)}`);
  await chmod(path, 0o755);
  return path;
}

function fakePiScript(logPath: string): string {
  return `
import { appendFileSync, writeFileSync } from "node:fs";
const argvRecord = { type: "argv", argv: process.argv.slice(1) };
writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(argvRecord) + "\\n");
process.stdin.setEncoding("utf8");
let buffer = "";
function emit(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }
function record(command) {
  appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ type: "command", command }) + "\\n");
}
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\\n")) {
    const index = buffer.indexOf("\\n");
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    record(command);
    if (command.type === "get_state") emit({
      id: command.id,
      type: "response",
      success: true,
      data: {
        model: { provider: "openai", id: "gpt-5.5", name: "GPT 5.5" },
        sessionId: "continued-session",
        sessionFile: "/tmp/continued-session.jsonl"
      }
    });
    if (command.type === "prompt") {
      emit({ id: command.id, type: "response", success: true });
      emit({ type: "agent_end", messages: [] });
    }
    if (command.type === "get_last_assistant_text") emit({
      id: command.id,
      type: "response",
      success: true,
      data: { text: "Continued implementation. Tests: pnpm test:unit -- continue." }
    });
  }
});
process.on("SIGTERM", () => process.exit(0));
`;
}

async function storedJob(options: {
  dataDir: string;
  id: string;
  kind?: "implement" | "implement-continuation";
  sessionFile?: string;
  sessionId?: string;
  status?: string;
  updatedAt: string;
  workspaceRoot: string;
}) {
  const job = createImplementationJob({
    dataDir: options.dataDir,
    id: options.id,
    workspaceRoot: options.workspaceRoot,
  });
  Object.assign(job, {
    status: options.status ?? "completed",
    phase: options.status ?? "completed",
    kind: options.kind ?? job.kind,
    model: "openai/gpt-5.5",
    sessionId: options.sessionId,
    piSessionFile: options.sessionFile,
    result: `result for ${options.id}`,
    summary: `summary for ${options.id}`,
    updatedAt: options.updatedAt,
  });
  await persistJob(job);
  return job;
}

describe("Pi implementation continuation", () => {
  it("ships a /pi:continue command that invokes the companion safely", async () => {
    const command = await readFile("plugins/pi/commands/continue.md", "utf8");

    expect(command).toContain('pi-companion.mjs" continue --wait');
    expect(command).toContain("PI_CONTINUE_INSTRUCTION");
    expect(command).toContain("stored Pi session");
  });

  it("continues the latest resumable implementation job with its stored Pi session", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-continue-data-"));
    const workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), "pi-continue-workspace-")));
    const logPath = join(dataDir, "fake-pi.jsonl");
    const fakePi = await writeFakePi(logPath);
    await storedJob({
      dataDir,
      id: "impl-older",
      sessionFile: "/tmp/older-session.jsonl",
      sessionId: "older-session",
      updatedAt: "2026-07-04T00:00:00.000Z",
      workspaceRoot,
    });
    const latest = await storedJob({
      dataDir,
      id: "impl-latest",
      sessionFile: "/tmp/latest-session.jsonl",
      sessionId: "latest-session",
      updatedAt: "2026-07-04T00:01:00.000Z",
      workspaceRoot,
    });

    const result = await runContinue("latest", {
      dataDir,
      instruction: "finish the edge case",
      piCommand: process.execPath,
      piPrefixArgs: [fakePi],
      timeoutMs: 1_000,
      workspaceRoot,
    });
    const records = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const argv = records.find((record) => record.type === "argv").argv;
    const prompt = records.find((record) => record.command?.type === "prompt").command.message;
    const job = JSON.parse(await readFile(result.jobFile, "utf8"));

    expect(result.ok).toBe(true);
    expect(argv).toContain("--session");
    expect(argv).toContain(latest.piSessionFile);
    expect(prompt).toContain("finish the edge case");
    expect(job).toMatchObject({
      kind: "implement-continuation",
      parentJobId: "impl-latest",
      rootJobId: "impl-latest",
      continuedFromSessionId: "latest-session",
      continuedFromSessionFile: "/tmp/latest-session.jsonl",
      result: "Continued implementation. Tests: pnpm test:unit -- continue.",
    });
    expect(result.report).toContain("Parent job: impl-latest");
  });

  it("lets Pi apply a per-invocation thinking suffix during continuation", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-continue-data-"));
    const workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), "pi-continue-workspace-")));
    const logPath = join(dataDir, "fake-pi.jsonl");
    const fakePi = await writeFakePi(logPath);
    await storedJob({
      dataDir,
      id: "impl-parent",
      sessionFile: "/tmp/parent-session.jsonl",
      sessionId: "parent-session",
      updatedAt: "2026-07-04T00:00:00.000Z",
      workspaceRoot,
    });

    const result = await runContinue("impl-parent", {
      dataDir,
      instruction: "continue with low thinking",
      model: "anthropic/claude:low",
      piCommand: process.execPath,
      piPrefixArgs: [fakePi],
      timeoutMs: 1_000,
      workspaceRoot,
    });
    const argv = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((record) => record.type === "argv").argv;

    expect(result.ok).toBe(true);
    expect(argv).toContain("anthropic/claude:low");
    expect(argv).not.toContain("--thinking");
  });

  it("skips newer in-flight jobs when continuing latest", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-continue-data-"));
    const workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), "pi-continue-workspace-")));
    const logPath = join(dataDir, "fake-pi.jsonl");
    const fakePi = await writeFakePi(logPath);
    const completed = await storedJob({
      dataDir,
      id: "impl-completed",
      sessionFile: "/tmp/completed-session.jsonl",
      sessionId: "completed-session",
      updatedAt: "2026-07-04T00:00:00.000Z",
      workspaceRoot,
    });
    await storedJob({
      dataDir,
      id: "impl-running",
      sessionFile: "/tmp/running-session.jsonl",
      sessionId: "running-session",
      status: "running",
      updatedAt: "2026-07-04T00:01:00.000Z",
      workspaceRoot,
    });

    await runContinue("latest", {
      dataDir,
      instruction: "continue the latest completed job",
      piCommand: process.execPath,
      piPrefixArgs: [fakePi],
      timeoutMs: 1_000,
      workspaceRoot,
    });
    const argv = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((record) => record.type === "argv").argv;

    expect(argv).toContain(completed.piSessionFile);
  });

  it("skips newer non-resumable jobs when continuing latest", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-continue-data-"));
    const workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), "pi-continue-workspace-")));
    const logPath = join(dataDir, "fake-pi.jsonl");
    const fakePi = await writeFakePi(logPath);
    const resumable = await storedJob({
      dataDir,
      id: "impl-resumable",
      sessionFile: "/tmp/resumable-session.jsonl",
      sessionId: "resumable-session",
      updatedAt: "2026-07-04T00:00:00.000Z",
      workspaceRoot,
    });
    await storedJob({
      dataDir,
      id: "cont-newer-no-session",
      kind: "implement-continuation",
      updatedAt: "2026-07-04T00:01:00.000Z",
      workspaceRoot,
    });

    await runContinue("latest", {
      dataDir,
      instruction: "continue the latest resumable job",
      piCommand: process.execPath,
      piPrefixArgs: [fakePi],
      timeoutMs: 1_000,
      workspaceRoot,
    });
    const argv = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((record) => record.type === "argv").argv;

    expect(argv).toContain(resumable.piSessionFile);
  });

  it("continues an explicit implementation job instead of the latest job", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-continue-data-"));
    const workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), "pi-continue-workspace-")));
    const logPath = join(dataDir, "fake-pi.jsonl");
    const fakePi = await writeFakePi(logPath);
    const explicit = await storedJob({
      dataDir,
      id: "impl-explicit",
      sessionFile: "/tmp/explicit-session.jsonl",
      sessionId: "explicit-session",
      updatedAt: "2026-07-04T00:00:00.000Z",
      workspaceRoot,
    });
    await storedJob({
      dataDir,
      id: "impl-newer",
      sessionFile: "/tmp/newer-session.jsonl",
      sessionId: "newer-session",
      updatedAt: "2026-07-04T00:01:00.000Z",
      workspaceRoot,
    });

    await runContinue("impl-explicit", {
      dataDir,
      instruction: "continue the selected job",
      piCommand: process.execPath,
      piPrefixArgs: [fakePi],
      timeoutMs: 1_000,
      workspaceRoot,
    });
    const argv = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((record) => record.type === "argv").argv;

    expect(argv).toContain(explicit.piSessionFile);
  });

  it("shows clear errors when no resumable job or no usable session metadata exists", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-continue-data-"));
    const workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), "pi-continue-workspace-")));

    await expect(
      runContinue("latest", { dataDir, instruction: "continue", workspaceRoot }),
    ).rejects.toThrow("No resumable implementation job found for selector: latest");
    await storedJob({
      dataDir,
      id: "impl-no-session",
      updatedAt: "2026-07-04T00:00:00.000Z",
      workspaceRoot,
    });
    await expect(
      runContinue("impl-no-session", { dataDir, instruction: "continue", workspaceRoot }),
    ).rejects.toThrow("Implementation job impl-no-session has no usable Pi session file metadata");
  });

  it("renders linked continuation result metadata and evidence", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-continue-data-"));
    const workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), "pi-continue-workspace-")));
    const logPath = join(dataDir, "fake-pi.jsonl");
    const fakePi = await writeFakePi(logPath);
    await storedJob({
      dataDir,
      id: "impl-parent",
      sessionFile: "/tmp/parent-session.jsonl",
      sessionId: "parent-session",
      updatedAt: "2026-07-04T00:00:00.000Z",
      workspaceRoot,
    });

    const continued = await runContinue("impl-parent", {
      dataDir,
      instruction: "render this result",
      piCommand: process.execPath,
      piPrefixArgs: [fakePi],
      timeoutMs: 1_000,
      workspaceRoot,
    });
    const result = await runResult(continued.jobId, { dataDir, workspaceRoot });

    expect(result.ok).toBe(true);
    expect(result.report).toContain("Kind: implement-continuation");
    expect(result.report).toContain("Parent job: impl-parent");
    expect(result.report).toContain("Continued implementation.");
    expect(result.report).toContain("- pnpm test:unit -- continue: reported");
  });

  it("reports continue CLI usage without advertising argv instructions", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-continue-data-"));
    const workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), "pi-continue-workspace-")));

    const result = await runCompanion(
      ["continue", "--wait", "latest", "extra-argv-instruction"],
      "",
      { ...process.env, PI_COMPANION_DATA_DIR: dataDir },
      workspaceRoot,
    );

    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe("Usage: pi-companion.mjs continue --wait [job-id|latest]");
  });

  it("keeps an explicit CLI selector when stdin starts with a selector-like token", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-continue-data-"));
    const workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), "pi-continue-workspace-")));
    const logPath = join(dataDir, "fake-pi.jsonl");
    const fakePi = await writeFakePi(logPath);
    await storedJob({
      dataDir,
      id: "impl-cli",
      sessionFile: "/tmp/cli-session.jsonl",
      sessionId: "cli-session",
      updatedAt: "2026-07-04T00:00:00.000Z",
      workspaceRoot,
    });
    await storedJob({
      dataDir,
      id: "impl-newer",
      sessionFile: "/tmp/newer-session.jsonl",
      sessionId: "newer-session",
      updatedAt: "2026-07-04T00:01:00.000Z",
      workspaceRoot,
    });

    const result = await runCompanion(
      ["continue", "--wait", "impl-cli"],
      "latest continue from the explicit CLI selector",
      { ...process.env, PI_CLI: fakePi, PI_COMPANION_DATA_DIR: dataDir },
      workspaceRoot,
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Parent job: impl-cli");
    expect(result.stdout).not.toContain("Parent job: impl-newer");
  });

  it("parses explicit job selectors from the Claude command stdin", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-continue-data-"));
    const workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), "pi-continue-workspace-")));
    const logPath = join(dataDir, "fake-pi.jsonl");
    const fakePi = await writeFakePi(logPath);
    await storedJob({
      dataDir,
      id: "impl-cli",
      sessionFile: "/tmp/cli-session.jsonl",
      sessionId: "cli-session",
      updatedAt: "2026-07-04T00:00:00.000Z",
      workspaceRoot,
    });

    const result = await runCompanion(
      ["continue", "--wait"],
      "impl-cli continue from stdin safely",
      { ...process.env, PI_CLI: fakePi, PI_COMPANION_DATA_DIR: dataDir },
      workspaceRoot,
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Parent job: impl-cli");
  });
});
