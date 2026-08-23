import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

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
    throw new Error(`Relative verifier cache path escapes Pi's cache directory: ${configuredPath}`);
  }
  return cachePath;
}

export function assertCachePathOutsideRepository(
  repoRoot: string,
  cachePath: string | undefined,
): void {
  if (!cachePath) return;
  const canonicalRepoRoot = canonicalizeWithExistingAncestor(repoRoot);
  const canonicalCachePath = canonicalizeWithExistingAncestor(cachePath);
  if (isPathWithin(canonicalRepoRoot, canonicalCachePath)) {
    throw new Error(
      "Verifier cache paths must be outside the guarded repository so cache writes cannot " +
        "trigger primary-worktree drift.",
    );
  }
}

function canonicalizeWithExistingAncestor(path: string): string {
  let current = resolve(path);
  const missingSegments: string[] = [];
  while (true) {
    try {
      return resolve(realpathSync.native(current), ...missingSegments.reverse());
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missingSegments.push(basename(current));
      current = parent;
    }
  }
}

function isPathWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  );
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
