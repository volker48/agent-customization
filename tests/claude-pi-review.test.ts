import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { describe, expect, it } from "vitest";

import { findJob } from "../plugins/pi/scripts/lib/jobs.mjs";
import {
  buildReviewPiArgs,
  collectGitContext,
  runReview,
} from "../plugins/pi/scripts/lib/review.mjs";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]) {
  await execFileAsync("git", args, { cwd });
}

async function createRepo() {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-repo-"));
  await git(dir, ["init"]);
  await git(dir, ["config", "user.email", "review@example.com"]);
  await git(dir, ["config", "user.name", "Review Test"]);
  await writeFile(join(dir, "file.txt"), "before\n", "utf8");
  await git(dir, ["add", "file.txt"]);
  await git(dir, ["commit", "-m", "initial"]);
  return dir;
}

async function writeFakePi(script: string) {
  const dir = await mkdtemp(join(tmpdir(), "fake-pi-review-"));
  const path = join(dir, "fake-pi.mjs");
  await writeFile(path, script, "utf8");
  await chmod(path, 0o755);
  return path;
}

function fakePiScript(logPath: string, finalText = "Review finding: fix it.") {
  return `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(logPath)}, JSON.stringify({ type: "argv", argv: process.argv.slice(1) }) + "\\n");
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
    if (command.type === "get_state") emit({ id: command.id, type: "response", command: "get_state", success: true, data: {
      model: { provider: "openai", id: "gpt-5.5", name: "GPT 5.5" },
      sessionId: "review-session",
      sessionFile: "/tmp/review-session.jsonl"
    }});
    if (command.type === "prompt") {
      emit({ id: command.id, type: "response", command: "prompt", success: true });
      emit({ type: "agent_end", messages: [] });
    }
    if (command.type === "get_last_assistant_text") emit({ id: command.id, type: "response", command: "get_last_assistant_text", success: true, data: { text: ${JSON.stringify(finalText)} } });
  }
});
process.on("SIGTERM", () => process.exit(0));
`;
}

function cancellingFakePiScript(logPath: string, dataDir: string) {
  return `#!/usr/bin/env node
import { appendFileSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
writeFileSync(${JSON.stringify(logPath)}, JSON.stringify({ type: "argv", argv: process.argv.slice(1) }) + "\\n");
process.stdin.setEncoding("utf8");
let buffer = "";
function emit(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }
function record(command) {
  appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ type: "command", command }) + "\\n");
}
function findJobFile(root) {
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) {
      const found = findJobFile(path);
      if (found) return found;
    }
    if (path.endsWith(".json")) return path;
  }
  return null;
}
function markCancelling() {
  const path = findJobFile(${JSON.stringify(dataDir)});
  const job = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...job, status: "cancelling", phase: "cancelling" }, null, 2) + "\\n");
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
    if (command.type === "get_state") emit({ id: command.id, type: "response", command: "get_state", success: true, data: {
      model: { provider: "openai", id: "gpt-5.5", name: "GPT 5.5" },
      sessionId: "review-session",
      sessionFile: "/tmp/review-session.jsonl"
    }});
    if (command.type === "prompt") {
      emit({ id: command.id, type: "response", command: "prompt", success: true });
      emit({ type: "agent_end", messages: [] });
    }
    if (command.type === "get_last_assistant_text") {
      markCancelling();
      emit({ id: command.id, type: "response", command: "get_last_assistant_text", success: true, data: { text: "Review finding: fix it." } });
    }
  }
});
process.on("SIGTERM", () => process.exit(0));
`;
}

async function runCompanion(
  args: string[],
  input: string,
  env: NodeJS.ProcessEnv,
  cwd = process.cwd(),
) {
  const script = join(process.cwd(), "plugins/pi/scripts/pi-companion.mjs");
  const child = spawn(process.execPath, [script, ...args], {
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

describe("Claude Code Pi read-only review delegation", () => {
  it("ships review commands that invoke the companion in wait mode", async () => {
    const review = await readFile("plugins/pi/commands/review.md", "utf8");
    const adversarial = await readFile("plugins/pi/commands/adversarial-review.md", "utf8");

    expect(review).toContain('pi-companion.mjs" review --wait');
    expect(adversarial).toContain('pi-companion.mjs" adversarial-review --wait');
    expect(review).toContain("read-only Pi RPC");
  });

  it("launches Pi RPC with strict read-only review flags", () => {
    const job = { sessionRoot: "/tmp/sessions" };

    expect(buildReviewPiArgs(job, { model: "anthropic/claude", piPrefixArgs: ["shim"] })).toEqual([
      "shim",
      "--mode",
      "rpc",
      "--model",
      "anthropic/claude",
      "--thinking",
      "xhigh",
      "--session-dir",
      "/tmp/sessions",
      "--no-session",
      "--no-extensions",
      "--no-prompt-templates",
      "--no-skills",
      "--no-context-files",
      "--no-approve",
      "--tools",
      "read,grep,find,ls",
    ]);
  });

  it("runs a normal review through Pi RPC with collected git context", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "file.txt"), "before\nafter\n", "utf8");
    const dataDir = await mkdtemp(join(tmpdir(), "pi-review-data-"));
    const logPath = join(dataDir, "fake-pi.jsonl");
    const fakePi = await writeFakePi(fakePiScript(logPath));

    const result = await runReview({
      context: "check issue #42",
      dataDir,
      piCommand: process.execPath,
      piPrefixArgs: [fakePi],
      timeoutMs: 1_000,
      workspaceRoot: repo,
    });
    const records = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const prompt = records.find((record) => record.command?.type === "prompt").command.message;

    expect(result.ok).toBe(true);
    expect(result.finalText).toContain("Review finding");
    expect(prompt).toContain("Git context collected outside Pi");
    expect(prompt).toContain("+after");
    expect(prompt).toContain("check issue #42");
  });

  it("does not complete a review job that was marked cancelling", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "file.txt"), "before\nafter\n", "utf8");
    const dataDir = await mkdtemp(join(tmpdir(), "pi-review-data-"));
    const logPath = join(dataDir, "fake-pi.jsonl");
    const fakePi = await writeFakePi(cancellingFakePiScript(logPath, dataDir));

    const result = await runReview({
      dataDir,
      piCommand: process.execPath,
      piPrefixArgs: [fakePi],
      timeoutMs: 1_000,
      workspaceRoot: repo,
    });
    const { job } = await findJob("latest", { dataDir, workspaceRoot: repo });

    expect(result.ok).not.toBe(true);
    expect(result.report).toContain("Status: cancelling");
    expect(result.report).not.toContain("Status: completed");
    expect(result.report).toContain("Review cancelled before completion.");
    expect(result.report).not.toContain("Review finding: fix it.");
    expect(job?.status).toBe("cancelling");
    expect(job?.result).toBeUndefined();
  });

  it("frames adversarial review prompts with required risk areas", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "file.txt"), "changed\n", "utf8");
    const dataDir = await mkdtemp(join(tmpdir(), "pi-review-data-"));
    const logPath = join(dataDir, "fake-pi.jsonl");
    const fakePi = await writeFakePi(fakePiScript(logPath, "Adversarial finding."));

    await runReview({
      dataDir,
      mode: "adversarial",
      piCommand: process.execPath,
      piPrefixArgs: [fakePi],
      timeoutMs: 1_000,
      workspaceRoot: repo,
    });
    const records = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const prompt = records.find((record) => record.command?.type === "prompt").command.message;

    expect(prompt).toContain("assumptions");
    expect(prompt).toContain("design tradeoffs");
    expect(prompt).toContain("race conditions");
    expect(prompt).toContain("data-loss risk");
  });

  it("fails and finalizes the review job when context collection fails", async () => {
    const repo = await createRepo();
    const dataDir = await mkdtemp(join(tmpdir(), "pi-review-data-"));

    await expect(
      runReview({
        dataDir,
        piCommand: process.execPath,
        target: "missing-target-ref",
        timeoutMs: 1_000,
        workspaceRoot: repo,
      }),
    ).rejects.toThrow();

    const { job } = await findJob("latest", { dataDir, workspaceRoot: repo });

    expect(job?.status).toBe("failed");
    expect(job?.phase).toBe("failed");
    expect(job?.completedAt).toEqual(expect.any(String));
  });

  it("collects branch-target diffs without applying the per-file cap", async () => {
    const repo = await createRepo();
    await git(repo, ["checkout", "-b", "feature"]);
    await writeFile(join(repo, "file.txt"), `${"feature\n".repeat(80)}`, "utf8");
    await git(repo, ["commit", "-am", "feature change"]);

    const context = await collectGitContext(repo, {
      limits: { maxFileBytes: 100, maxStatusBytes: 1_000, maxTotalBytes: 10_000 },
      target: "HEAD~1",
    });

    expect(context.text).toContain("git diff HEAD~1...HEAD");
    expect(context.text).toContain("+feature");
    expect(context.notes).not.toEqual(
      expect.arrayContaining([expect.stringContaining("HEAD~1...HEAD truncated to 100 bytes")]),
    );
  });

  it("adds visible truncation notes for large diffs", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "file.txt"), `${"x".repeat(2_000)}\n`, "utf8");

    const context = await collectGitContext(repo, {
      limits: { maxFileBytes: 200, maxStatusBytes: 1_000, maxTotalBytes: 1_000 },
    });

    expect(context.text).toContain("[... truncated ...]");
    expect(context.notes).toEqual(
      expect.arrayContaining([expect.stringContaining("file.txt truncated")]),
    );
  });

  it("skips likely-secret untracked files and notes ignored files", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, ".env"), "API_TOKEN=secret\n", "utf8");
    await mkdir(join(repo, "ignored"));
    await writeFile(join(repo, ".gitignore"), "ignored/\n", "utf8");
    await writeFile(join(repo, "ignored", "cache.txt"), "cache\n", "utf8");

    const context = await collectGitContext(repo);

    expect(context.text).not.toContain("API_TOKEN=secret");
    expect(context.notes).toEqual(
      expect.arrayContaining([
        expect.stringContaining("skipped likely-secret untracked file: .env"),
        expect.stringContaining("ignored files were detected"),
      ]),
    );
  });

  it("parses review stdin flags without shell interpolation", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "file.txt"), "changed\n", "utf8");
    const dataDir = await mkdtemp(join(tmpdir(), "pi-review-data-"));
    const logPath = join(dataDir, "fake-pi.jsonl");
    const fakePi = await writeFakePi(fakePiScript(logPath));

    const result = await runCompanion(
      ["review", "--wait"],
      "--model openai/gpt-5.5 check it",
      { ...process.env, PI_CLI: fakePi, PI_COMPANION_DATA_DIR: dataDir },
      repo,
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });
});
