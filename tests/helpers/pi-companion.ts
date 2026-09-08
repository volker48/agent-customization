import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const companion = fileURLToPath(
  new URL("../../plugins/pi/scripts/pi-companion.mjs", import.meta.url),
);

export async function runCompanion(
  args: string[],
  input: string,
  env: NodeJS.ProcessEnv,
  cwd = process.cwd(),
) {
  const child = spawn(process.execPath, [companion, ...args], {
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
  const finished = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  child.stdin.end(input);
  const status = await finished;
  return { status, stderr, stdout };
}
