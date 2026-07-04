#!/usr/bin/env node
import { cleanupActiveJobs, runCancel } from "./lib/cancel.mjs";
import {
  runContinue,
  runImplement,
  runImplementWorker,
  startBackgroundImplement,
} from "./lib/implement.mjs";
import { runResult, runStatus } from "./lib/inspect.mjs";
import { runReview } from "./lib/review.mjs";
import { runSetup } from "./lib/setup.mjs";

const IMPLEMENT_COMMAND_USAGE =
  "pi-companion.mjs implement --wait|--background [--model provider/model]";
const REVIEW_COMMAND_USAGE =
  "pi-companion.mjs review --wait [--model provider/model] [--target ref]";
const CONTINUE_COMMAND_USAGE = "pi-companion.mjs continue --wait [job-id|latest]";
const IMPLEMENT_USAGE = `Usage: ${IMPLEMENT_COMMAND_USAGE}`;
const REVIEW_USAGE = `Usage: ${REVIEW_COMMAND_USAGE}`;
const CONTINUE_USAGE = `Usage: ${CONTINUE_COMMAND_USAGE}`;
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
  if (command === "review" || command === "adversarial-review") {
    await runReviewCommand(command, args);
    return;
  }
  if (command === "continue") {
    await runContinueCommand(args);
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
    [
      "Usage: pi-companion.mjs setup",
      IMPLEMENT_COMMAND_USAGE,
      REVIEW_COMMAND_USAGE,
      CONTINUE_COMMAND_USAGE,
      "status | result | cancel",
    ].join(" | "),
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

async function runReviewCommand(command, args) {
  const parsedArgs = parseReviewArgs(args);
  const parsedInput = parseReviewInput(await readStdin());
  if (!parsedArgs.wait && !parsedInput.wait) throw new Error(REVIEW_USAGE);
  await printResult(
    await runReview({
      context: parsedInput.context,
      mode: command === "adversarial-review" ? "adversarial" : "review",
      model: parsedArgs.model ?? parsedInput.model,
      target: parsedArgs.target ?? parsedInput.target,
    }),
  );
}

function parseReviewArgs(args) {
  let wait = false;
  let model;
  let target;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--wait") wait = true;
    else if (arg === "--model") model = parseReviewValue(args[++index]);
    else if (arg === "--target") target = parseReviewValue(args[++index]);
    else throw new Error(`Unknown review option: ${arg}`);
  }
  return { model, target, wait };
}

function parseReviewInput(input) {
  let remaining = input.trimStart();
  let model;
  let target;
  let wait = false;
  while (true) {
    const flag = remaining.match(/^--(wait|model|target)(?:\s+|$)/);
    if (!flag) break;
    remaining = remaining.slice(flag[0].length).trimStart();
    if (flag[1] === "wait") wait = true;
    if (flag[1] === "model") ({ remaining, value: model } = takeReviewValue(remaining));
    if (flag[1] === "target") ({ remaining, value: target } = takeReviewValue(remaining));
  }
  return { context: remaining, model, target, wait };
}

function takeReviewValue(input) {
  const match = input.match(/^(\S+)(?:\s+|$)/);
  const value = parseReviewValue(match?.[1]);
  return { remaining: input.slice(match[0].length).trimStart(), value };
}

function parseReviewValue(value) {
  if (!value || value.startsWith("--")) throw new Error(REVIEW_USAGE);
  return value;
}

async function runContinueCommand(args) {
  const parsedArgs = parseContinueArgs(args);
  const parsedInput = parseContinueInput(await readStdin(), {
    parseSelector: !parsedArgs.hasSelector,
  });
  if (!parsedArgs.wait && !parsedInput.wait) {
    throw new Error(CONTINUE_USAGE);
  }
  const selector = parsedArgs.hasSelector
    ? parsedArgs.selector
    : parsedInput.selector ?? parsedArgs.selector;
  await printResult(
    await runContinue(selector, {
      instruction: parsedInput.instruction,
    }),
  );
}

function parseContinueArgs(args) {
  let wait = false;
  let selector = "latest";
  let hasSelector = false;
  for (const arg of args) {
    if (arg === "--wait") {
      wait = true;
    } else if (!hasSelector && !arg.startsWith("--") && !/\s/.test(arg)) {
      selector = arg;
      hasSelector = true;
    } else {
      throw new Error(CONTINUE_USAGE);
    }
  }
  return { hasSelector, selector, wait };
}

function parseContinueInput(input, options = {}) {
  let remaining = input.trimStart();
  let wait = false;
  const waitMatch = remaining.match(/^--wait(?:\s+|$)/);
  if (waitMatch) {
    wait = true;
    remaining = remaining.slice(waitMatch[0].length).trimStart();
  }
  if (options.parseSelector === false) return { instruction: remaining, wait };
  const selectorMatch = remaining.match(/^(\S+)(?:\s+|$)/);
  if (!selectorMatch) return { instruction: "", wait };
  const firstToken = selectorMatch[1];
  if (isContinuationSelector(firstToken)) {
    return {
      instruction: remaining.slice(selectorMatch[0].length).trimStart(),
      selector: firstToken,
      wait,
    };
  }
  return { instruction: remaining, wait };
}

function isContinuationSelector(value) {
  return value === "latest" || value.startsWith("impl-") || value.startsWith("cont-");
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
