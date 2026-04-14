#!/usr/bin/env node

import { execFile } from "node:child_process";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const argv = process.argv.slice(2);
const passthroughIndex = argv.indexOf("--");
const piPassthroughArgs = passthroughIndex === -1 ? [] : argv.splice(passthroughIndex + 1);
if (passthroughIndex !== -1) {
  argv.splice(passthroughIndex, 1);
}

function consumeFlag(name) {
  const index = argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }

  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }

  argv.splice(index, 2);
  return value;
}

function consumeBooleanFlag(name) {
  const index = argv.indexOf(name);
  if (index === -1) {
    return false;
  }

  argv.splice(index, 1);
  return true;
}

async function resolvePiBinary() {
  const explicit = consumeFlag("--pi-bin") ?? process.env.PI_BIN;
  if (explicit) {
    return explicit;
  }

  const localBin = resolve("node_modules/.bin/pi");
  try {
    await access(localBin, constants.X_OK);
    return localBin;
  } catch {
    return "pi";
  }
}

function parseSessionEntries(raw) {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function extractVerificationSummary(entries) {
  const toolCalls = [];
  const toolResults = [];

  for (const entry of entries) {
    if (entry?.type !== "message" || !entry.message) {
      continue;
    }

    if (entry.message.role === "assistant" && Array.isArray(entry.message.content)) {
      for (const item of entry.message.content) {
        if (item?.type === "toolCall") {
          toolCalls.push({
            id: item.id,
            name: item.name,
            arguments: item.arguments,
          });
        }
      }
    }

    if (entry.message.role === "toolResult") {
      toolResults.push({
        toolCallId: entry.message.toolCallId,
        toolName: entry.message.toolName,
        text: Array.isArray(entry.message.content)
          ? entry.message.content
              .filter((item) => item?.type === "text")
              .map((item) => item.text)
              .join("\n")
          : "",
        details: entry.message.details,
      });
    }
  }

  return { toolCalls, toolResults };
}

function formatPreview(text, maxLength = 240) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "(empty)";
  }
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength)}...`;
}

function printOutput(label, text, useStderr = false) {
  const normalized = text?.trim();
  if (!normalized) {
    return;
  }
  const log = useStderr ? console.error : console.log;
  log(`[rtk-verify] ${label}:`);
  log(normalized);
  log("");
}

async function main() {
  const piBin = await resolvePiBinary();
  const extensionPath = resolve("pi-extensions/rtk.ts");
  const requestedSession = consumeFlag("--session");
  const requestedRtkBin = consumeFlag("--rtk-bin") ?? process.env.PI_RTK_BIN;
  const customPrompt = consumeFlag("--prompt");

  // Accept --keep-session for CLI ergonomics (sessions are retained by default)
  consumeBooleanFlag("--keep-session");

  if (argv.length > 0) {
    throw new Error(`Unknown arguments: ${argv.join(" ")}`);
  }

  const tempDir = requestedSession ? undefined : await mkdtemp(join(tmpdir(), "pi-rtk-verify-"));
  const sessionPath = requestedSession ?? join(tempDir, "rtk-verification-session.jsonl");

  const systemPrompt =
    "For this run, if you call bash, use the exact command `git status` with no `rtk` prefix. " +
    "Use bash exactly once, then answer in one short sentence.";
  const prompt =
    customPrompt ??
    "Run git status using bash, then summarize the repository state in one short sentence.";

  const commandArgs = [
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--extension",
    extensionPath,
    "--session",
    sessionPath,
    "--tools",
    "bash",
    "-p",
    "--append-system-prompt",
    systemPrompt,
  ];

  if (requestedRtkBin) {
    commandArgs.push("--rtk-bin", requestedRtkBin);
  }

  commandArgs.push(...piPassthroughArgs);
  commandArgs.push(prompt);

  console.log("[rtk-verify] Running Pi with:");
  console.log(`  binary: ${piBin}`);
  console.log(`  extension: ${extensionPath}`);
  console.log(`  session: ${sessionPath}`);
  if (requestedRtkBin) {
    console.log(`  rtk binary: ${requestedRtkBin}`);
  }
  console.log(`  cwd: ${process.cwd()}`);
  console.log("");
  console.log(
    `[rtk-verify] Command: ${[piBin, ...commandArgs].map((part) => JSON.stringify(part)).join(" ")}`,
  );
  console.log("");

  let result;
  try {
    result = await execFileAsync(piBin, commandArgs, {
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    printOutput("pi stdout", error?.stdout);
    printOutput("pi stderr", error?.stderr, true);
    throw error;
  }

  printOutput("pi stdout", result.stdout);
  printOutput("pi stderr", result.stderr, true);

  const sessionRaw = await readFile(sessionPath, "utf8");
  const entries = parseSessionEntries(sessionRaw);
  const summary = extractVerificationSummary(entries);

  console.log(`[rtk-verify] Session file: ${sessionPath}`);
  console.log("");

  if (summary.toolCalls.length === 0) {
    throw new Error("No tool calls were recorded in the session.");
  }

  console.log("[rtk-verify] Tool calls:");
  for (const [index, toolCall] of summary.toolCalls.entries()) {
    console.log(`  ${index + 1}. ${toolCall.name}`);
    console.log(`     id: ${toolCall.id}`);
    console.log(`     args: ${JSON.stringify(toolCall.arguments)}`);
  }
  console.log("");

  console.log("[rtk-verify] Tool result previews:");
  for (const [index, toolResult] of summary.toolResults.entries()) {
    console.log(`  ${index + 1}. ${toolResult.toolName} (${toolResult.toolCallId})`);
    console.log(`     ${formatPreview(toolResult.text)}`);
    if (toolResult.details?.rtkRewrite) {
      console.log(`     rewrite: ${JSON.stringify(toolResult.details.rtkRewrite)}`);
    }
  }
  console.log("");

  const bashToolResult = summary.toolResults.find((toolResult) => toolResult.toolName === "bash");
  if (!bashToolResult) {
    throw new Error("No bash tool result was found in the session.");
  }

  const rewrite = bashToolResult.details?.rtkRewrite;
  const expectedRtkBin = requestedRtkBin ?? "rtk";
  const expectedRewrite = `${expectedRtkBin} git status`;
  if (rewrite?.rewrittenCommand === expectedRewrite) {
    console.log(`[rtk-verify] SUCCESS: tool result details recorded rewrite to \`${expectedRewrite}\`.`);
  } else {
    throw new Error(
      `[rtk-verify] Expected tool result details to contain rewritten command \`${expectedRewrite}\`, got: ${JSON.stringify(rewrite)}`,
    );
  }

  if (tempDir) {
    console.log(
      "[rtk-verify] Temporary session directory retained for inspection. Re-run with --session to choose a permanent path.",
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
