import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function terminateProcessTree(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0 || !isProcessAlive(pid)) return true;
  await signalTree(pid, "SIGTERM");
  if (await waitForProcessExit(pid, options.timeoutMs ?? 1_000)) return true;
  await signalTree(pid, "SIGKILL");
  return waitForProcessExit(pid, options.killTimeoutMs ?? 1_000);
}

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function signalTree(pid, signal) {
  for (const childPid of await childPids(pid)) await signalTree(childPid, signal);
  try {
    process.kill(pid, signal);
  } catch {
    return;
  }
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await sleep(25);
  }
  return !isProcessAlive(pid);
}

export async function childPids(pid) {
  if (process.platform === "win32") return [];
  try {
    const { stdout } = await execFileAsync("pgrep", ["-P", String(pid)]);
    return stdout
      .split("\n")
      .map((value) => Number.parseInt(value, 10))
      .filter(Number.isInteger);
  } catch {
    return [];
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
