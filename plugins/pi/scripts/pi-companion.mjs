#!/usr/bin/env node
import { runImplement } from "./lib/implement.mjs";
import { runSetup } from "./lib/setup.mjs";

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "setup") {
    await printResult(await runSetup());
    return;
  }
  if (command === "implement") {
    await runImplementCommand(args);
    return;
  }
  console.error("Usage: pi-companion.mjs setup | implement --wait [--model provider/model]");
  process.exitCode = 2;
}

async function runImplementCommand(args) {
  const parsedArgs = parseImplementArgs(args);
  const parsedInput = parseBriefInput(await readStdin());
  if (!parsedArgs.wait && !parsedInput.wait) {
    throw new Error("Usage: pi-companion.mjs implement --wait [--model provider/model]");
  }
  await printResult(
    await runImplement({ brief: parsedInput.brief, model: parsedArgs.model ?? parsedInput.model }),
  );
}

function parseImplementArgs(args) {
  let wait = false;
  let model;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--wait") {
      wait = true;
    } else if (arg === "--model") {
      model = args[++index];
    } else {
      throw new Error(`Unknown implement option: ${arg}`);
    }
  }
  return { model, wait };
}

function parseBriefInput(input) {
  let remaining = input.trimStart();
  let model;
  let wait = false;
  while (true) {
    const waitMatch = remaining.match(/^--wait(?:\s+|$)/);
    if (waitMatch) {
      wait = true;
      remaining = remaining.slice(waitMatch[0].length).trimStart();
      continue;
    }
    const modelMatch = remaining.match(/^--model\s+(\S+)(?:\s+|$)/);
    if (!modelMatch) break;
    model = modelMatch[1];
    remaining = remaining.slice(modelMatch[0].length).trimStart();
  }
  return { brief: remaining, model, wait };
}

async function readStdin() {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

async function printResult(result) {
  console.log(result.report);
  if (!result.ok || !result.piTerminated) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
