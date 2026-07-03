/**
 * Reusable file-bundling core.
 *
 * Collects on-disk files by glob/literal pattern and materializes them into a
 * single self-contained markdown string. Used to hand real file contents to
 * models that have no filesystem access (e.g. the Fusion panel), so the caller
 * curates which files matter and this module renders their exact bytes.
 */

import { spawn } from "node:child_process";
import { glob, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

export interface BundleFile {
  displayPath: string;
  content: string;
}

export interface CollectOptions {
  cwd?: string;
  maxFileSizeBytes?: number;
}

export interface BundleOptions {
  lineNumbers?: boolean;
}

export const DEFAULT_MAX_FILE_SIZE_BYTES = 1024 * 1024;

const DEFAULT_IGNORED_DIRS = new Set([
  "node_modules",
  "dist",
  "coverage",
  ".git",
  ".turbo",
  ".next",
  "build",
]);

const EXT_TO_LANG: Record<string, string> = {
  ".ts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".jsx": "jsx",
  ".mjs": "js",
  ".cjs": "js",
  ".json": "json",
  ".md": "md",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".py": "python",
  ".rb": "ruby",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".css": "css",
  ".scss": "scss",
  ".sql": "sql",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".swift": "swift",
};

export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleError";
  }
}

export async function collectFiles(
  patterns: string[],
  options: CollectOptions = {},
): Promise<BundleFile[]> {
  const cwd = options.cwd ?? process.cwd();
  const maxBytes = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
  const { includes, excludes } = partition(patterns);
  if (includes.length === 0) {
    throw new BundleError("No file patterns provided.");
  }

  const { globMatches, literals } = await expandIncludes(includes, cwd);
  const excludeMatchers = excludes.map(compileGlob);
  const keep = (rel: string) => !excludeMatchers.some((match) => match(rel));

  const ignored = await gitIgnoredPaths([...globMatches, ...literals], cwd);
  assertLiteralsNotIgnored(literals, ignored);

  const candidates = new Set<string>();
  for (const rel of literals) {
    if (keep(rel)) candidates.add(rel);
  }
  for (const rel of globMatches) {
    if (keep(rel) && !ignored.has(rel)) candidates.add(rel);
  }
  if (candidates.size === 0) {
    throw new BundleError("No files matched the provided patterns.");
  }

  const rootRealPath = await realpath(cwd);
  const accepted = await enforceSizeLimit([...candidates], cwd, rootRealPath, maxBytes);
  const files: BundleFile[] = [];
  for (const rel of accepted) {
    await assertRealPathWithinRoot(rel, cwd, rootRealPath);
    const content = await readFile(path.resolve(cwd, rel), "utf8");
    files.push({ displayPath: rel, content });
  }
  return files.sort((a, b) => a.displayPath.localeCompare(b.displayPath));
}

export function formatBundle(files: BundleFile[], options: BundleOptions = {}): string {
  const lineNumbers = options.lineNumbers ?? false;
  return files
    .map((file, index) => renderSection(index + 1, file, lineNumbers))
    .join("\n\n")
    .trimEnd();
}

function partition(patterns: string[]): { includes: string[]; excludes: string[] } {
  const includes: string[] = [];
  const excludes: string[] = [];
  for (const entry of patterns) {
    const raw = entry?.trim();
    if (!raw) continue;
    if (raw.startsWith("!")) {
      const normalized = toPosix(raw.slice(1));
      if (normalized) excludes.push(normalized);
    } else {
      includes.push(raw);
    }
  }
  return { includes, excludes };
}

async function expandIncludes(
  includes: string[],
  cwd: string,
): Promise<{ globMatches: Set<string>; literals: Set<string> }> {
  const globMatches = new Set<string>();
  const literals = new Set<string>();
  for (const pattern of includes) {
    assertSafePattern(pattern);
    if (isDynamicPattern(pattern)) {
      for await (const match of glob(pattern, {
        cwd,
        exclude: (name) => DEFAULT_IGNORED_DIRS.has(name),
      })) {
        globMatches.add(toPosix(match));
      }
    } else {
      literals.add(await resolveLiteral(pattern, cwd));
    }
  }
  return { globMatches, literals };
}

function assertSafePattern(pattern: string): void {
  if (path.isAbsolute(pattern)) {
    throw new BundleError(`Absolute paths are not allowed: ${pattern}`);
  }
  if (toPosix(pattern).split("/").includes("..")) {
    throw new BundleError(`Paths must stay within root: ${pattern}`);
  }
}

async function resolveLiteral(pattern: string, cwd: string): Promise<string> {
  const absolute = path.resolve(cwd, pattern);
  const relative = path.relative(cwd, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new BundleError(`Paths must stay within root: ${pattern}`);
  }
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(absolute);
  } catch {
    throw new BundleError(`Missing file: ${pattern}`);
  }
  if (!stats.isFile()) {
    throw new BundleError(`Not a file: ${pattern}`);
  }
  return toPosix(relative);
}

async function enforceSizeLimit(
  rels: string[],
  cwd: string,
  rootRealPath: string,
  maxBytes: number,
): Promise<string[]> {
  const accepted: string[] = [];
  const oversized: string[] = [];
  for (const rel of rels) {
    await assertRealPathWithinRoot(rel, cwd, rootRealPath);
    const stats = await stat(path.resolve(cwd, rel));
    if (!stats.isFile()) continue;
    if (maxBytes && stats.size > maxBytes) {
      oversized.push(`${rel} (${formatBytes(stats.size)})`);
      continue;
    }
    accepted.push(rel);
  }
  if (oversized.length > 0) {
    throw new BundleError(
      `The following files exceed the ${formatBytes(maxBytes)} limit:\n- ${oversized.join("\n- ")}`,
    );
  }
  return accepted;
}

async function assertRealPathWithinRoot(
  rel: string,
  cwd: string,
  rootRealPath: string,
): Promise<void> {
  const targetRealPath = await realpath(path.resolve(cwd, rel));
  const relative = path.relative(rootRealPath, targetRealPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new BundleError(`Paths must stay within root: ${rel}`);
  }
}

function renderSection(index: number, file: BundleFile, lineNumbers: boolean): string {
  const fence = pickFence(file.content);
  const lang = EXT_TO_LANG[path.extname(file.displayPath).toLowerCase()] ?? "";
  const normalized = file.content.replace(/\s+$/u, "");
  const header = `### File ${index}: ${file.displayPath}`;
  const fenceOpen = lang ? `${fence}${lang}` : fence;
  if (!lineNumbers) {
    return [header, fenceOpen, normalized, fence].join("\n");
  }
  const { text, lineCount } = addLineNumbers(normalized);
  const range = lineCount === 0 ? "Lines: 0" : `Lines: 1-${lineCount}`;
  return [header, range, fenceOpen, text, fence].join("\n");
}

function pickFence(content: string): string {
  const runs = [...content.matchAll(/`+/g)];
  const maxTicks = runs.reduce((max, match) => Math.max(max, match[0].length), 0);
  return "`".repeat(Math.max(3, maxTicks + 1));
}

function addLineNumbers(content: string): { text: string; lineCount: number } {
  if (content.length === 0) {
    return { text: "", lineCount: 0 };
  }
  const lines = content.split("\n");
  const width = String(lines.length).length;
  const text = lines
    .map((line, index) => `${String(index + 1).padStart(width, " ")} | ${line}`)
    .join("\n");
  return { text, lineCount: lines.length };
}

function isDynamicPattern(pattern: string): boolean {
  return /[*?[\]{}]/.test(pattern);
}

/**
 * Filter out paths ignored by git (e.g. .env, build artifacts, secrets) so a
 * broad glob can't leak them to the panel. Uses `git check-ignore`,
 * which honors nested and negated .gitignore rules. Outside a git repo or
 * without git installed, it degrades to no filtering.
 */
async function gitIgnoredPaths(rels: string[], cwd: string): Promise<Set<string>> {
  if (rels.length === 0) return new Set();
  return new Promise((resolve) => {
    const child = spawn("git", ["-C", cwd, "check-ignore", "--stdin"], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.on("error", () => resolve(new Set()));
    child.on("close", () => {
      const ignored = out
        .split("\n")
        .map((line) => toPosix(line.trim()))
        .filter(Boolean);
      resolve(new Set(ignored));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(rels.join("\n"));
  });
}

function assertLiteralsNotIgnored(literals: Set<string>, ignored: Set<string>): void {
  const blocked = [...literals].filter((rel) => ignored.has(rel));
  if (blocked.length > 0) {
    throw new BundleError(
      `The following files are git-ignored and will not be bundled:\n- ${blocked.join("\n- ")}`,
    );
  }
}

function compileGlob(pattern: string): (rel: string) => boolean {
  const regex = globToRegExp(toPosix(pattern));
  return (rel) => regex.test(rel);
}

function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          source += "(?:.*/)?";
          i += 2;
        } else {
          source += ".*";
          i += 1;
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}

function formatBytes(size: number): string {
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
  if (size >= 1024) return `${(size / 1024).toFixed(1).replace(/\.0$/, "")} KB`;
  return `${size} B`;
}
