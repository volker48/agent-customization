import { spawn } from "node:child_process";
import { access, chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runImplement } from "../plugins/pi/scripts/lib/implement.mjs";

async function runCompanion(args: string[], input: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ["plugins/pi/scripts/pi-companion.mjs", ...args], {
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
  const dir = await mkdtemp(join(tmpdir(), "fake-pi-impl-"));
  const path = join(dir, "fake-pi.mjs");
  await writeFile(path, script);
  return path;
}

function fakePiScript(logPath: string, handlers: string, signalHandler?: string): string {
  const onSignal =
    signalHandler ??
    `  appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ type: "terminated" }) + "\\n");
  process.exit(0);`;
  return `
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
    if (command.type === "get_state") emitState(command.id);
${handlers}
  }
});
function emitState(id) {
  emit({ id, type: "response", command: "get_state", success: true, data: {
    model: { provider: "openai-codex", id: "gpt-5.5", name: "GPT 5.5" },
    thinkingLevel: "high",
    isStreaming: false,
    sessionId: "impl-session",
    sessionFile: "/tmp/impl-session.jsonl"
  }});
}
process.on("SIGTERM", () => {
${onSignal}
});
`;
}

function slowAgentEndFakePi(logPath: string): string {
  return fakePiScript(
    logPath,
    `    const text = "Slow implementation complete.";
    if (command.type === "prompt") {
      emit({ id: command.id, type: "response", command: "prompt", success: true });
      setTimeout(() => emit({ type: "agent_end", messages: [] }), 650);
    }
    if (command.type === "get_last_assistant_text") {
      emit({ id: command.id, type: "response", command: "get_last_assistant_text",
        success: true, data: { text } });
    }`,
  );
}

function retryingAgentEndFakePi(logPath: string): string {
  return fakePiScript(
    logPath,
    `    globalThis.retryCompleted ??= false;
    if (command.type === "prompt") {
      emit({ id: command.id, type: "response", command: "prompt", success: true });
      emit({ type: "agent_end", willRetry: true, messages: [
        { role: "assistant", content: "Transient provider error." }
      ] });
      setTimeout(() => {
        globalThis.retryCompleted = true;
        emit({ type: "agent_end", messages: [] });
      }, 20);
    }
    if (command.type === "get_last_assistant_text") {
      const text = globalThis.retryCompleted
        ? "Retried implementation complete."
        : "Transient provider error.";
      emit({ id: command.id, type: "response", command: "get_last_assistant_text",
        success: true, data: { text } });
    }`,
  );
}

function delayedTerminationFakePi(logPath: string): string {
  return fakePiScript(
    logPath,
    `    const text = "Implementation complete after graceful shutdown.";
    if (command.type === "prompt") {
      emit({ id: command.id, type: "response", command: "prompt", success: true });
      emit({ type: "agent_end", messages: [] });
    }
    if (command.type === "get_last_assistant_text") {
      emit({ id: command.id, type: "response", command: "get_last_assistant_text",
        success: true, data: { text } });
    }`,
    `  setTimeout(() => {
    appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ type: "terminated" }) + "\\n");
    process.exit(0);
  }, 1_100);`,
  );
}

function stderrFloodFakePi(logPath: string): string {
  return fakePiScript(
    logPath,
    `    if (command.type === "get_state") process.stderr.write("x".repeat(256));
    const text = "Implementation complete with stderr.";
    if (command.type === "prompt") {
      emit({ id: command.id, type: "response", command: "prompt", success: true });
      emit({ type: "agent_end", messages: [] });
    }
    if (command.type === "get_last_assistant_text") {
      emit({ id: command.id, type: "response", command: "get_last_assistant_text",
        success: true, data: { text } });
    }`,
  );
}

function promptFailureFakePi(logPath: string): string {
  return fakePiScript(
    logPath,
    `    if (command.type === "prompt") {
      emit({ id: command.id, type: "response", command: "prompt", success: false,
        error: "model quota exceeded" });
    }`,
  );
}

function emptyFinalTextFakePi(logPath: string): string {
  return fakePiScript(
    logPath,
    `    if (command.type === "prompt") {
      emit({ id: command.id, type: "response", command: "prompt", success: true });
      emit({ type: "agent_end", messages: [] });
    }
    if (command.type === "get_last_assistant_text") {
      emit({ id: command.id, type: "response", command: "get_last_assistant_text",
        success: true, data: { text: null } });
    }`,
  );
}

function finalTextFallbackFakePi(logPath: string): string {
  return fakePiScript(
    logPath,
    `    if (command.type === "prompt") {
      emit({ id: command.id, type: "response", command: "prompt", success: true });
      emit({ type: "agent_end", messages: [
        { role: "assistant", content: [{ type: "text", text: "Fallback implementation report." }] }
      ] });
    }
    if (command.type === "get_last_assistant_text") {
      emit({ id: command.id, type: "response", command: "get_last_assistant_text",
        success: true, data: { text: null } });
    }`,
  );
}

function successfulFakePi(logPath: string): string {
  return fakePiScript(
    logPath,
    `    const text = "Implemented the requested change. Tests: pnpm test -- --runInBand.";
    if (command.type === "prompt") {
      emit({ id: command.id, type: "response", command: "prompt", success: true });
      emit({ type: "agent_end", messages: [] });
    }
    if (command.type === "get_last_assistant_text") {
      emit({ id: command.id, type: "response", command: "get_last_assistant_text",
        success: true, data: { text } });
    }`,
  );
}

describe("Claude Code Pi implementation delegation", () => {
  it("ships a pi implement command that invokes the companion in wait mode", async () => {
    const command = await readFile("plugins/pi/commands/implement.md", "utf8");

    await access("plugins/pi/scripts/pi-companion.mjs");
    expect(command).toContain('pi-companion.mjs" implement --wait');
    expect(command).toContain("PI_IMPLEMENT_BRIEF");
    expect(command).toContain("write-capable");
  });

  it("parses stdin flags from the Claude command without shell interpolation", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-impl-data-"));
    const logPath = join(dataDir, "fake-pi.jsonl");
    const fakePi = await writeFakePi(`#!/usr/bin/env node\n${successfulFakePi(logPath)}`);
    await chmod(fakePi, 0o755);

    const result = await runCompanion(
      ["implement", "--wait"],
      "--model anthropic/claude-opus-4-20250514 add the feature",
      { ...process.env, PI_CLI: fakePi, PI_COMPANION_DATA_DIR: dataDir },
    );
    const records = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const argv = records.find((record) => record.type === "argv").argv;
    const prompt = records.find((record) => record.command?.type === "prompt").command.message;

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(argv).toContain("--model");
    expect(argv).toContain("anthropic/claude-opus-4-20250514");
    expect(prompt).toContain("add the feature");
    expect(prompt).not.toContain("--model anthropic/claude-opus-4-20250514");
  });

  it("rejects missing model values from argv and stdin flags", async () => {
    const env = { ...process.env, PI_CLI: "/definitely/missing/pi" };

    await expect(
      runCompanion(["implement", "--wait", "--model"], "fix bug", env),
    ).resolves.toMatchObject({
      status: 1,
      stderr: expect.stringContaining("Usage: pi-companion.mjs implement --wait"),
    });
    await expect(
      runCompanion(["implement", "--model", "--wait"], "fix bug", env),
    ).resolves.toMatchObject({
      status: 1,
      stderr: expect.stringContaining("Usage: pi-companion.mjs implement --wait"),
    });
    await expect(
      runCompanion(["implement", "--wait"], "--model --wait fix bug", env),
    ).resolves.toMatchObject({
      status: 1,
      stderr: expect.stringContaining("Usage: pi-companion.mjs implement --wait"),
    });
  });

  it("fails fast when the implementation brief is empty", async () => {
    await expect(
      runImplement({
        brief: "   \n",
        piCommand: "/definitely/missing/pi",
      }),
    ).rejects.toThrow("Implementation brief is required");
  });

  it("waits beyond the short RPC request timeout for implementation completion", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-impl-data-"));
    const logPath = join(dataDir, "fake-pi.jsonl");
    const fakePi = await writeFakePi(slowAgentEndFakePi(logPath));

    const result = await runImplement({
      agentEndTimeoutMs: 1_500,
      brief: "Implement a slow request.",
      dataDir,
      piCommand: process.execPath,
      piPrefixArgs: [fakePi],
      timeoutMs: 500,
      workspaceRoot: "/repo-under-test",
    });

    expect(result.ok).toBe(true);
    expect(result.finalText).toBe("Slow implementation complete.");
  });

  it("waits for the final agent_end when Pi retries automatically", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-impl-data-"));
    const logPath = join(dataDir, "fake-pi.jsonl");
    const fakePi = await writeFakePi(retryingAgentEndFakePi(logPath));

    const result = await runImplement({
      agentEndTimeoutMs: 200,
      brief: "Implement after a retryable provider error.",
      dataDir,
      piCommand: process.execPath,
      piPrefixArgs: [fakePi],
      timeoutMs: 500,
      workspaceRoot: "/repo-under-test",
    });

    expect(result.ok).toBe(true);
    expect(result.finalText).toBe("Retried implementation complete.");
  });

  it("waits long enough for Pi to flush session state during graceful termination", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-impl-data-"));
    const logPath = join(dataDir, "fake-pi.jsonl");
    const fakePi = await writeFakePi(delayedTerminationFakePi(logPath));

    const result = await runImplement({
      brief: "Implement and shut down gracefully.",
      dataDir,
      piCommand: process.execPath,
      piPrefixArgs: [fakePi],
      timeoutMs: 1_000,
      workspaceRoot: "/repo-under-test",
    });

    expect(result.ok).toBe(true);
    expect(result.piTerminated).toBe(true);
  });

  it("caps captured Pi stderr", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-impl-data-"));
    const logPath = join(dataDir, "fake-pi.jsonl");
    const fakePi = await writeFakePi(stderrFloodFakePi(logPath));

    const result = await runImplement({
      brief: "Implement with noisy stderr.",
      dataDir,
      piCommand: process.execPath,
      piPrefixArgs: [fakePi],
      stderrMaxBytes: 32,
      timeoutMs: 1_000,
      workspaceRoot: "/repo-under-test",
    });

    expect(result.ok).toBe(true);
    expect(result.stderr.length).toBeLessThanOrEqual(32);
  });

  it("runs a foreground implementation through Pi RPC and stores session metadata", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-impl-data-"));
    const logPath = join(dataDir, "fake-pi.jsonl");
    const fakePi = await writeFakePi(successfulFakePi(logPath));

    const result = await runImplement({
      brief: "Implement issue #38 using tests first.",
      dataDir,
      piCommand: process.execPath,
      piPrefixArgs: [fakePi],
      timeoutMs: 1_000,
      workspaceRoot: "/repo-under-test",
    });

    const records = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const argv = records.find((record) => record.type === "argv").argv;
    const commands = records
      .filter((record) => record.type === "command")
      .map((record) => record.command);
    const job = JSON.parse(await readFile(result.jobFile, "utf8"));

    expect(result.ok).toBe(true);
    expect(result.finalText).toContain("Implemented the requested change");
    expect(result.piTerminated).toBe(true);
    expect(result.report).toContain("Status: completed");
    expect(result.report).toContain("Model: openai-codex/gpt-5.5");
    expect(argv).toEqual([
      fakePi,
      "--mode",
      "rpc",
      "--model",
      "openai-codex/gpt-5.5",
      "--session-dir",
      join(dataDir, "pi-sessions"),
      "--no-extensions",
      "--no-prompt-templates",
      "--no-skills",
      "--tools",
      "read,grep,find,ls,bash,edit,write",
    ]);
    expect(commands.map((command) => command.type)).toEqual([
      "get_state",
      "prompt",
      "get_last_assistant_text",
    ]);
    expect(commands[1].message).toContain("Implement issue #38 using tests first.");
    expect(records.some((record) => record.type === "terminated")).toBe(true);
    expect(job).toMatchObject({
      kind: "implement",
      status: "completed",
      workspaceRoot: "/repo-under-test",
      sessionId: "impl-session",
      piSessionFile: "/tmp/impl-session.jsonl",
      model: "openai-codex/gpt-5.5",
      result: result.finalText,
    });
  });

  it("falls back to the agent_end assistant message when last-assistant text is empty", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-impl-data-"));
    const logPath = join(dataDir, "fake-pi.jsonl");
    const fakePi = await writeFakePi(finalTextFallbackFakePi(logPath));

    const result = await runImplement({
      brief: "Implement with fallback output.",
      dataDir,
      piCommand: process.execPath,
      piPrefixArgs: [fakePi],
      timeoutMs: 1_000,
      workspaceRoot: "/repo-under-test",
    });

    expect(result.ok).toBe(true);
    expect(result.finalText).toBe("Fallback implementation report.");
    expect(result.report).toContain("Fallback implementation report.");
  });

  it("fails the job when Pi has no final assistant text", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-impl-data-"));
    const logPath = join(dataDir, "fake-pi.jsonl");
    const fakePi = await writeFakePi(emptyFinalTextFakePi(logPath));

    const result = await runImplement({
      brief: "Implement without final text.",
      dataDir,
      piCommand: process.execPath,
      piPrefixArgs: [fakePi],
      timeoutMs: 1_000,
      workspaceRoot: "/repo-under-test",
    });

    const job = JSON.parse(await readFile(result.jobFile, "utf8"));

    expect(result.ok).toBe(false);
    expect(result.errorMessage).toBe("Pi completed without a final assistant response");
    expect(result.piTerminated).toBe(true);
    expect(job).toMatchObject({
      kind: "implement",
      status: "failed",
      errorMessage: "Pi completed without a final assistant response",
    });
  });

  it("reports Pi RPC prompt failures and still terminates the process", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-impl-data-"));
    const logPath = join(dataDir, "fake-pi.jsonl");
    const fakePi = await writeFakePi(promptFailureFakePi(logPath));

    const result = await runImplement({
      agentEndTimeoutMs: 50,
      brief: "Implement a failing request.",
      dataDir,
      piCommand: process.execPath,
      piPrefixArgs: [fakePi],
      timeoutMs: 1_000,
      workspaceRoot: "/repo-under-test",
    });
    await new Promise((resolve) => setTimeout(resolve, 75));

    const records = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const job = JSON.parse(await readFile(result.jobFile, "utf8"));

    expect(result.ok).toBe(false);
    expect(result.errorMessage).toContain("model quota exceeded");
    expect(result.piTerminated).toBe(true);
    expect(result.report).toContain("Status: failed");
    expect(records.some((record) => record.type === "terminated")).toBe(true);
    expect(job).toMatchObject({
      kind: "implement",
      status: "failed",
      errorMessage: "Pi RPC prompt failed: model quota exceeded",
    });
  });
});
