import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function createRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "lav-run-test-"));
  git(directory, "init", "--quiet");
  git(directory, "config", "user.email", "lav@example.test");
  git(directory, "config", "user.name", "LAV Test");
  await writeFile(join(directory, "tracked.txt"), "base\n");
  git(directory, "add", "tracked.txt");
  git(directory, "commit", "--quiet", "-m", "initial");
  return directory;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}
