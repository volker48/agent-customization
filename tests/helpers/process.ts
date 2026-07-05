import { spawn } from "node:child_process";

export async function exitedProcessPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
    stdio: "ignore",
  });
  const pid = child.pid;
  if (!pid) throw new Error("Failed to start short-lived process");
  await new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", () => resolve());
  });
  return pid;
}
