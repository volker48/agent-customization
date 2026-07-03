import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { runSetup } from "../plugins/pi/scripts/lib/setup.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

async function writeFakePi(script: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fake-pi-"));
  const path = join(dir, "fake-pi.mjs");
  await writeFile(path, script);
  return path;
}

function fakePiScript(provider: string, id: string, name: string): string {
  return `
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\\n")) {
    const index = buffer.indexOf("\\n");
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    if (command.type === "get_state") {
      process.stdout.write(JSON.stringify({
        id: command.id,
        type: "response",
        command: "get_state",
        success: true,
        data: {
          model: { provider: "${provider}", id: "${id}", name: "${name}" },
          thinkingLevel: "high",
          sessionId: "setup-session",
          sessionFile: "/tmp/setup-session.jsonl"
        }
      }) + "\\n");
    }
    if (command.type === "get_available_models") {
      process.stdout.write(JSON.stringify({
        id: command.id,
        type: "response",
        command: "get_available_models",
        success: true,
        data: { models: [{ provider: "${provider}", id: "${id}", name: "${name}" }] }
      }) + "\\n");
    }
  }
});
process.on("SIGTERM", () => {
  process.stderr.write("terminated\\n");
  process.exit(0);
});
`;
}

const successFakePi = fakePiScript("openai", "gpt-5.5", "GPT 5.5");

const malformedRpcFakePi = `
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => {
  process.stdout.write("this is not json\\n");
});
process.on("SIGTERM", () => process.exit(0));
`;

describe("Claude Code Pi setup", () => {
  it("ships a loadable pi plugin with a setup command", async () => {
    const manifestPath = join(repoRoot, "plugins/pi/.claude-plugin/plugin.json");
    const commandPath = join(repoRoot, "plugins/pi/commands/setup.md");
    const scriptPath = join(repoRoot, "plugins/pi/scripts/pi-companion.mjs");

    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const command = await readFile(commandPath, "utf8");

    await access(scriptPath);
    expect(manifest.name).toBe("pi");
    expect(command).toContain('pi-companion.mjs" setup');
  });

  it("reports a missing Pi CLI without starting RPC", async () => {
    const result = await runSetup({
      nodeCommand: process.execPath,
      piCommand: "/definitely/missing/pi",
      timeoutMs: 100,
    });

    expect(result.ok).toBe(false);
    expect(result.piTerminated).toBe(true);
    expect(result.report).toContain("Pi CLI: failed");
    expect(result.report).toContain("Pi RPC startup: failed");
  });

  it("reports malformed Pi RPC stdout as a setup failure", async () => {
    const fakePi = await writeFakePi(malformedRpcFakePi);

    const result = await runSetup({
      nodeCommand: process.execPath,
      piCommand: process.execPath,
      piArgs: [fakePi],
      timeoutMs: 1_000,
    });

    expect(result.ok).toBe(false);
    expect(result.piTerminated).toBe(true);
    expect(result.report).toContain("Pi RPC startup: failed");
    expect(result.report).toContain("Malformed Pi RPC JSON");
  });

  it("checks Pi RPC state, reports the active model, and terminates Pi", async () => {
    const fakePi = await writeFakePi(successFakePi);

    const result = await runSetup({
      nodeCommand: process.execPath,
      piCommand: process.execPath,
      piArgs: [fakePi],
      intendedModel: "openai/gpt-5.5",
      timeoutMs: 1_000,
    });

    expect(result.ok).toBe(true);
    expect(result.activeModel).toEqual("openai/gpt-5.5");
    expect(result.intendedModelAvailable).toBe(true);
    expect(result.piTerminated).toBe(true);
    expect(result.stderr).toContain("terminated");
    expect(result.report).toContain("Pi RPC startup: ok");
    expect(result.report).toContain("Active model: openai/gpt-5.5 (GPT 5.5)");
  });

  it("accepts an intended model when the model id matches under another provider", async () => {
    const fakePi = await writeFakePi(fakePiScript("openai-codex", "gpt-5.5", "GPT-5.5"));

    const result = await runSetup({
      nodeCommand: process.execPath,
      piCommand: process.execPath,
      piArgs: [fakePi],
      intendedModel: "openai/gpt-5.5",
      timeoutMs: 1_000,
    });

    expect(result.activeModel).toEqual("openai-codex/gpt-5.5");
    expect(result.intendedModelAvailable).toBe(true);
    expect(result.report).toContain("Intended implementation model available: openai/gpt-5.5");
  });

  it("gives actionable guidance when the intended implementation model is unavailable", async () => {
    const fakePi = await writeFakePi(successFakePi);

    const result = await runSetup({
      nodeCommand: process.execPath,
      piCommand: process.execPath,
      piArgs: [fakePi],
      intendedModel: "openai/gpt-6",
      timeoutMs: 1_000,
    });

    expect(result.ok).toBe(true);
    expect(result.intendedModelAvailable).toBe(false);
    expect(result.report).toContain("Intended implementation model unavailable: openai/gpt-6");
    expect(result.report).toContain(
      "Configure Pi with a provider/model that resolves to openai/gpt-6",
    );
  });
});
