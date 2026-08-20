import { isAbsolute, relative, resolve, sep } from "node:path";

const CACHE_ROOT_DIRECTORY = "llm-verifier-cache";

export function resolveLavCachePath(
  configuredPath: string | undefined,
  agentDir: string,
): string | undefined {
  if (!configuredPath) return undefined;
  if (isAbsolute(configuredPath)) return resolve(configuredPath);

  const cacheRoot = resolve(agentDir, CACHE_ROOT_DIRECTORY);
  const cachePath = resolve(cacheRoot, configuredPath);
  if (!isPathWithin(cacheRoot, cachePath)) {
    throw new Error(
      `Relative verifier cache path escapes Pi's cache directory: ${configuredPath}`,
    );
  }
  return cachePath;
}

export function assertCachePathOutsideRepository(
  repoRoot: string,
  cachePath: string | undefined,
): void {
  if (!cachePath) return;
  if (isPathWithin(resolve(repoRoot), resolve(cachePath))) {
    throw new Error(
      "Verifier cache paths must be outside the guarded repository so cache writes cannot " +
        "trigger primary-worktree drift.",
    );
  }
}

function isPathWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromRoot))
  );
}
