#!/usr/bin/env node
import { runImplement } from "./lib/implement.mjs";
import { runResult, runStatus } from "./lib/inspect.mjs";
import { runSetup } from "./lib/setup.mjs";

const IMPLEMENT_COMMAND_USAGE = "pi-companion.mjs implement --wait [--model provider/model]";
const IMPLEMENT_USAGE = `Usage: ${IMPLEMENT_COMMAND_USAGE}`;
const RESULT_USAGE = "Usage: pi-companion.mjs result [job-id|latest]";

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
  if (command === "status") {
    await printResult(await runStatus());
    return;
  }
  if (command === "result") {
    await runResultCommand(args);
    return;
  }
  console.error(`Usage: pi-companion.mjs setup | ${IMPLEMENT_COMMAND_USAGE} | status | result`);
  process.exitCode = 2;
}

async function runImplementCommand(args) {
  const parsedArgs = parseImplementArgs(args);
  const parsedInput = parseBriefInput(await readStdin());
  if (!parsedArgs.wait && !parsedInput.wait) {
    throw new Error(IMPLEMENT_USAGE);
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
      model = parseModelValue(args[++index]);
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
    const modelFlagMatch = remaining.match(/^--model(?:\s+|$)/);
    if (!modelFlagMatch) break;
    remaining = remaining.slice(modelFlagMatch[0].length).trimStart();
    const valueMatch = remaining.match(/^(\S+)(?:\s+|$)/);
    model = parseModelValue(valueMatch?.[1]);
    remaining = remaining.slice(valueMatch[0].length).trimStart();
  }
  return { brief: remaining, model, wait };
}

function parseModelValue(value) {
  if (!value || value.startsWith("--")) throw new Error(IMPLEMENT_USAGE);
  return value;
}

async function runResultCommand(args) {
  if (args.length > 1) throw new Error(RESULT_USAGE);
  const inputSelector = args[0] ?? (await readStdin()).trim();
  const selector = parseResultSelector(inputSelector);
  await printResult(await runResult(selector));
}

function parseResultSelector(value) {
  if (!value) return "latest";
  if (/\s/.test(value)) throw new Error(RESULT_USAGE);
  return value;
}

async function readStdin() {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

async function printResult(result) {
  console.log(result.report);
  if (!result.ok || result.piTerminated === false) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
