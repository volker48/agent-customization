import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function terminateProcessTree(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0 || !isProcessAlive(pid)) return true;
  const trackedPids = new Set(await treePids(pid));
  await signalTree(pid, "SIGTERM");
  if (await waitForTreeExit(pid, trackedPids, options.timeoutMs ?? 1_000)) return true;
  await signalPids(trackedPids, "SIGKILL");
  return waitForTreeExit(pid, trackedPids, options.killTimeoutMs ?? 1_000);
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

async function signalPids(pids, signal) {
  for (const pid of [...pids].reverse()) {
    try {
      process.kill(pid, signal);
    } catch {
      // Process already exited.
    }
  }
}

async function waitForTreeExit(pid, trackedPids, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const trackedPid of await treePids(pid)) trackedPids.add(trackedPid);
    if ([...trackedPids].every((trackedPid) => !isProcessAlive(trackedPid))) return true;
    await sleep(25);
  }
  return [...trackedPids].every((trackedPid) => !isProcessAlive(trackedPid));
}

async function treePids(pid) {
  const pids = [pid];
  for (const childPid of await childPids(pid)) pids.push(...(await treePids(childPid)));
  return pids;
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
