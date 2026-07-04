#!/usr/bin/env node
import { cleanupActiveJobs, runCancel } from "./lib/cancel.mjs";
import { runImplement, runImplementWorker, startBackgroundImplement } from "./lib/implement.mjs";
import { runResult, runStatus } from "./lib/inspect.mjs";
import { runSetup } from "./lib/setup.mjs";

const IMPLEMENT_COMMAND_USAGE =
  "pi-companion.mjs implement --wait|--background [--model provider/model]";
const IMPLEMENT_USAGE = `Usage: ${IMPLEMENT_COMMAND_USAGE}`;
const RESULT_USAGE = "Usage: pi-companion.mjs result [job-id|latest]";
const CANCEL_USAGE = "Usage: pi-companion.mjs cancel [job-id|latest]";

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
  if (command === "cancel") {
    await runCancelCommand(args);
    return;
  }
  if (command === "session-cleanup") {
    await printResult(await cleanupActiveJobs());
    return;
  }
  if (command === "result") {
    await runResultCommand(args);
    return;
  }
  console.error(
    `Usage: pi-companion.mjs setup | ${IMPLEMENT_COMMAND_USAGE} | status | result | cancel`,
  );
  process.exitCode = 2;
}

async function runImplementCommand(args) {
  const parsedArgs = parseImplementArgs(args);
  const parsedInput = parseBriefInput(await readStdin());
  if (parsedArgs.worker) {
    await printResult(await runImplementWorker({ jobFile: parsedArgs.jobFile }));
    return;
  }
  const background = parsedArgs.background || parsedInput.background;
  const wait = parsedArgs.wait || parsedInput.wait;
  if (background === wait) throw new Error(IMPLEMENT_USAGE);
  const options = { brief: parsedInput.brief, model: parsedArgs.model ?? parsedInput.model };
  await printResult(
    background ? await startBackgroundImplement(options) : await runImplement(options),
  );
}

function parseImplementArgs(args) {
  let background = false;
  let jobFile;
  let model;
  let wait = false;
  let worker = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--background") background = true;
    else if (arg === "--wait") wait = true;
    else if (arg === "--worker") worker = true;
    else if (arg === "--job-file") jobFile = parseModelValue(args[++index]);
    else if (arg === "--model") model = parseModelValue(args[++index]);
    else throw new Error(`Unknown implement option: ${arg}`);
  }
  return { background, jobFile, model, wait, worker };
}

function parseBriefInput(input) {
  let remaining = input.trimStart();
  let background = false;
  let model;
  let wait = false;
  while (true) {
    const backgroundMatch = remaining.match(/^--background(?:\s+|$)/);
    if (backgroundMatch) {
      background = true;
      remaining = remaining.slice(backgroundMatch[0].length).trimStart();
      continue;
    }
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
  return { background, brief: remaining, model, wait };
}

function parseModelValue(value) {
  if (!value || value.startsWith("--")) throw new Error(IMPLEMENT_USAGE);
  return value;
}

async function runCancelCommand(args) {
  if (args.length > 1) throw new Error(CANCEL_USAGE);
  const inputSelector = args[0] ?? (await readStdin()).trim();
  const selector = parseResultSelector(inputSelector);
  await printResult(await runCancel(selector));
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
