#!/usr/bin/env node
import { runSetup } from "./lib/setup.mjs";

async function main() {
  const command = process.argv[2];
  if (command !== "setup") {
    console.error("Usage: pi-companion.mjs setup");
    process.exitCode = 2;
    return;
  }

  const result = await runSetup();
  console.log(result.report);
  if (!result.ok || !result.piTerminated) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
