#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const REPOSITORY = "https://github.com/cursor/plugins.git";
const SUBTREE = "pstack";
const DEFAULT_REF = "main";
const PI_ADAPTER_LINK = `## Pi adaptation

Read [the Pi adapter contract](../../PI_ADAPTER.md) before following this skill. It overrides Cursor-specific runtime, tool, model, and path instructions below while preserving the upstream workflow.`;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const pstackRoot = join(repoRoot, "pstack");
const overlaysDir = join(pstackRoot, "overlays");

function parseArgs(argv) {
  const options = {
    check: false,
    ref: DEFAULT_REF,
    source: undefined,
    commit: undefined,
    tree: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") {
      options.check = true;
    } else if (arg === "--ref") {
      options.ref = argv[++index];
    } else if (arg === "--source") {
      options.source = resolve(argv[++index]);
    } else if (arg === "--commit") {
      options.commit = argv[++index];
    } else if (arg === "--tree") {
      options.tree = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function runGit(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function fetchUpstream(ref, tempRoot) {
  const checkout = join(tempRoot, "checkout");
  mkdirSync(checkout, { recursive: true });
  runGit(["init", "--quiet"], checkout);
  runGit(["remote", "add", "origin", REPOSITORY], checkout);
  runGit(["config", "core.sparseCheckout", "true"], checkout);
  writeFileSync(join(checkout, ".git", "info", "sparse-checkout"), `/${SUBTREE}/\n`);
  runGit(["fetch", "--depth=1", "origin", ref], checkout);
  runGit(["checkout", "--quiet", "--detach", "FETCH_HEAD"], checkout);
  return {
    source: join(checkout, SUBTREE),
    commit: runGit(["rev-parse", "HEAD"], checkout),
    tree: runGit(["rev-parse", `HEAD:${SUBTREE}`], checkout),
  };
}

function sourceMetadata(source, explicitCommit, explicitTree) {
  if (explicitCommit && explicitTree) {
    return { commit: explicitCommit, tree: explicitTree };
  }

  const currentUpstream = join(pstackRoot, "upstream");
  const currentMetadata = join(pstackRoot, "upstream.json");
  if (
    existsSync(currentUpstream) &&
    existsSync(currentMetadata) &&
    realpathSync(source) === realpathSync(currentUpstream)
  ) {
    const metadata = JSON.parse(readFileSync(currentMetadata, "utf8"));
    if (typeof metadata.commit === "string" && typeof metadata.tree === "string") {
      return {
        commit: metadata.commit,
        tree: metadata.tree,
        requestedRef:
          typeof metadata.requestedRef === "string" ? metadata.requestedRef : DEFAULT_REF,
      };
    }
  }

  try {
    const normalizedSource = realpathSync(source);
    const root = realpathSync(runGit(["rev-parse", "--show-toplevel"], normalizedSource));
    const commit = runGit(["rev-parse", "HEAD"], root);
    const subtreePath = relative(root, normalizedSource).replaceAll("\\", "/");
    const tree = runGit(["rev-parse", `HEAD:${subtreePath}`], root);
    return { commit, tree };
  } catch {
    return { commit: "unknown-local-source", tree: computeGitTreeHash(source) };
  }
}

function listFiles(root) {
  if (!existsSync(root)) return [];
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(relative(root, absolute).replaceAll("\\", "/"));
      else throw new Error(`Unsupported upstream entry: ${absolute}`);
    }
  };
  visit(root);
  return files;
}

function computeGitTreeHash(root) {
  const gitDir = mkdtempSync(join(tmpdir(), "pstack-tree-"));
  try {
    runGit(["init", "--quiet"], gitDir);
    const args = [`--git-dir=${join(gitDir, ".git")}`, `--work-tree=${realpathSync(root)}`];
    runGit([...args, "add", "--all", "--force", "--", "."], gitDir);
    return runGit([...args, "write-tree"], gitDir);
  } finally {
    rmSync(gitDir, { recursive: true, force: true });
  }
}

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function hashOverlayBase(path) {
  return statSync(path).isDirectory() ? computeGitTreeHash(path) : hashFile(path);
}

function fullOverlayBasePaths() {
  const agentPaths = existsSync(join(overlaysDir, "agents")) ? ["agents"] : [];
  const skillPaths = readdirSync(join(overlaysDir, "skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `skills/${entry.name}`);
  return [...agentPaths, ...skillPaths].sort();
}

function validateOverlayBases(upstreamDir) {
  const manifestPath = join(overlaysDir, "reconciled-upstream.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.version !== 2 || !manifest.paths || typeof manifest.paths !== "object") {
    throw new Error(`${manifestPath} must contain { version: 2, paths: { ... } }`);
  }

  const requiredPaths = fullOverlayBasePaths();
  const recordedPaths = Object.keys(manifest.paths).sort();
  const coverageMismatch = [
    ...requiredPaths.filter((path) => !recordedPaths.includes(path)),
    ...recordedPaths.filter((path) => !requiredPaths.includes(path)),
  ];
  if (coverageMismatch.length > 0) {
    throw new Error(
      `Full-overlay reconciliation manifest coverage mismatch: ${coverageMismatch.join(", ")}`,
    );
  }

  const changed = [];
  for (const [relativePath, expectedHash] of Object.entries(manifest.paths)) {
    const absolutePath = join(upstreamDir, relativePath);
    if (
      !existsSync(absolutePath) ||
      typeof expectedHash !== "string" ||
      hashOverlayBase(absolutePath) !== expectedHash
    ) {
      changed.push(relativePath);
    }
  }
  if (changed.length > 0) {
    throw new Error(
      `Upstream sources replaced by full Pi overlays changed: ${changed.join(", ")}. Reconcile each overlay, then update ${manifestPath}.`,
    );
  }
}

function validateAgentOverlayCoverage(upstreamDir) {
  const upstreamAgents = listFiles(join(upstreamDir, "agents")).filter((path) =>
    path.endsWith(".md"),
  );
  const overlayAgents = new Set(
    listFiles(join(overlaysDir, "agents")).filter((path) => path.endsWith(".md")),
  );
  const uncovered = upstreamAgents.filter((path) => !overlayAgents.has(path));
  if (uncovered.length > 0) {
    throw new Error(
      `Upstream agents require namespaced Pi overlays before publication: ${uncovered.join(", ")}`,
    );
  }
}

function validateVendoredPathsTrackable(upstreamDir, tempRoot) {
  const trackingRoot = join(tempRoot, "trackability");
  const candidateRoot = join(trackingRoot, "pstack", "upstream");
  mkdirSync(trackingRoot, { recursive: true });
  runGit(["init", "--quiet"], trackingRoot);
  copyDirectory(join(repoRoot, ".gitignore"), join(trackingRoot, ".gitignore"));
  copyDirectory(upstreamDir, candidateRoot);

  const paths = listFiles(candidateRoot).map((path) =>
    join("pstack", "upstream", path).split(sep).join("/"),
  );
  const result = spawnSync("git", ["check-ignore", "--no-index", "--stdin"], {
    cwd: trackingRoot,
    encoding: "utf8",
    input: `${paths.join("\n")}\n`,
  });
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`Unable to validate vendored paths against Git ignore rules: ${result.stderr}`);
  }
  const ignored = result.status === 0 ? result.stdout.trim().split("\n").filter(Boolean) : [];
  if (ignored.length > 0) {
    throw new Error(
      `Upstream paths cannot be vendored reproducibly because Git ignores them: ${ignored.join(", ")}`,
    );
  }
}

function copyDirectory(source, target) {
  if (!existsSync(source)) return;
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true, force: true });
}

function insertAdapterLink(markdown, path) {
  const closing = markdown.indexOf("\n---", 4);
  if (!markdown.startsWith("---\n") || closing < 0) {
    throw new Error(`Skill is missing YAML frontmatter: ${path}`);
  }
  const afterFrontmatter = closing + 4;
  return `${markdown.slice(0, afterFrontmatter)}\n\n${PI_ADAPTER_LINK}\n${markdown.slice(afterFrontmatter).replace(/^\n+/, "\n")}`;
}

function parseSkillName(markdown, path) {
  const match = markdown.match(/^name:\s*(.+)$/m);
  if (!match) throw new Error(`Skill is missing name frontmatter: ${path}`);
  return match[1].trim().replace(/^['"]|['"]$/g, "");
}

function generatePiTree(upstreamDir, generatedDir, metadata) {
  const upstreamSkills = join(upstreamDir, "skills");
  const generatedSkills = join(generatedDir, "skills");
  const generatedAgents = join(generatedDir, "agents");
  const overlaySkills = join(overlaysDir, "skills");
  const fullSkillOverlays = readdirSync(overlaySkills, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  copyDirectory(upstreamSkills, generatedSkills);

  for (const relativePath of listFiles(generatedSkills).filter(
    (path) => basename(path) === "SKILL.md" && !fullSkillOverlays.includes(path.split("/")[0]),
  )) {
    const absolutePath = join(generatedSkills, relativePath);
    let markdown = readFileSync(absolutePath, "utf8");
    if (relativePath === "poteto-mode/SKILL.md") {
      const oldName = "name: Poteto Mode";
      if (!markdown.includes(oldName)) {
        throw new Error("Upstream poteto-mode name changed; reconcile the Pi name normalization");
      }
      markdown = markdown.replace(oldName, "name: poteto-mode");
    }
    writeFileSync(absolutePath, insertAdapterLink(markdown, relativePath));
  }

  for (const skillName of fullSkillOverlays) {
    const target = join(generatedSkills, skillName);
    rmSync(target, { recursive: true, force: true });
    copyDirectory(join(overlaySkills, skillName), target);
  }

  copyDirectory(join(overlaysDir, "PI_ADAPTER.md"), join(generatedDir, "PI_ADAPTER.md"));
  copyDirectory(
    join(overlaysDir, "model-defaults.json"),
    join(generatedDir, "model-defaults.json"),
  );
  copyDirectory(join(overlaysDir, "agents"), generatedAgents);

  const skillNames = listFiles(generatedSkills)
    .filter((path) => basename(path) === "SKILL.md")
    .map((relativePath) =>
      parseSkillName(readFileSync(join(generatedSkills, relativePath), "utf8"), relativePath),
    );
  const uniqueNames = [...new Set(skillNames)].sort();
  if (uniqueNames.length !== skillNames.length) {
    throw new Error("Generated pstack skills contain duplicate names");
  }

  for (const relativePath of listFiles(generatedAgents).filter((path) => path.endsWith(".md"))) {
    const markdown = readFileSync(join(generatedAgents, relativePath), "utf8");
    if (!/^package:\s*pstack\s*$/m.test(markdown) || !/^name:\s*[a-z0-9-]+\s*$/m.test(markdown)) {
      throw new Error(
        `Pi agent overlay must declare package: pstack and a safe name: ${relativePath}`,
      );
    }
  }

  writeFileSync(
    join(generatedDir, "skill-names.json"),
    `${JSON.stringify(uniqueNames, null, 2)}\n`,
  );
  writeFileSync(
    join(generatedDir, "UPSTREAM.md"),
    `# Generated pstack Pi resources\n\nDo not edit this directory directly. It was generated from [cursor/plugins](https://github.com/cursor/plugins/tree/main/pstack) commit \`${metadata.commit}\` with \`scripts/sync-pstack.mjs\`. Pi-specific source overlays live in \`pstack/overlays/\`.\n`,
  );
}

function compareTrees(expected, actual) {
  const expectedFiles = new Set(listFiles(expected));
  const actualFiles = new Set(listFiles(actual));
  const all = [...new Set([...expectedFiles, ...actualFiles])].sort();
  return all.filter((path) => {
    if (!expectedFiles.has(path) || !actualFiles.has(path)) return true;
    const expectedStat = statSync(join(expected, path));
    const actualStat = statSync(join(actual, path));
    if (expectedStat.size !== actualStat.size) return true;
    if ((expectedStat.mode & 0o111) !== (actualStat.mode & 0o111)) return true;
    return !readFileSync(join(expected, path)).equals(readFileSync(join(actual, path)));
  });
}

function replacePath(source, target) {
  const staged = `${target}.next`;
  const backup = `${target}.previous`;
  if (!existsSync(target) && existsSync(backup)) renameSync(backup, target);
  rmSync(staged, { recursive: true, force: true });
  rmSync(backup, { recursive: true, force: true });
  copyDirectory(source, staged);
  if (existsSync(target)) renameSync(target, backup);
  try {
    renameSync(staged, target);
  } catch (error) {
    if (!existsSync(target) && existsSync(backup)) renameSync(backup, target);
    throw error;
  }
  rmSync(backup, { recursive: true, force: true });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (Boolean(options.commit) !== Boolean(options.tree)) {
    throw new Error(
      "--commit and --tree must be supplied together so source integrity is verifiable",
    );
  }
  if (!existsSync(overlaysDir)) throw new Error(`Missing overlays: ${overlaysDir}`);

  const tempRoot = mkdtempSync(join(tmpdir(), "pstack-sync-"));
  try {
    const fetched = options.source
      ? {
          source: options.source,
          ...sourceMetadata(options.source, options.commit, options.tree),
        }
      : fetchUpstream(options.ref, tempRoot);
    if (!existsSync(join(fetched.source, "skills"))) {
      throw new Error(`Not a pstack source tree: ${fetched.source}`);
    }

    const actualSourceTree = computeGitTreeHash(fetched.source);
    if (actualSourceTree !== fetched.tree) {
      throw new Error(
        `Upstream source tree ${actualSourceTree} does not match expected tree ${fetched.tree}.`,
      );
    }

    const candidateUpstream = join(tempRoot, "upstream");
    const candidatePi = join(tempRoot, "pi");
    copyDirectory(fetched.source, candidateUpstream);

    const metadata = {
      version: 1,
      repository: REPOSITORY,
      subtree: SUBTREE,
      requestedRef: fetched.requestedRef ?? options.ref,
      commit: fetched.commit,
      tree: fetched.tree,
    };
    validateVendoredPathsTrackable(candidateUpstream, tempRoot);
    validateAgentOverlayCoverage(candidateUpstream);
    validateOverlayBases(candidateUpstream);
    generatePiTree(candidateUpstream, candidatePi, metadata);
    const candidateMetadata = join(tempRoot, "upstream.json");
    writeFileSync(candidateMetadata, `${JSON.stringify(metadata, null, 2)}\n`);

    const differences = [
      ...compareTrees(candidateUpstream, join(pstackRoot, "upstream")).map(
        (path) => `upstream/${path}`,
      ),
      ...compareTrees(candidatePi, join(pstackRoot, "pi")).map((path) => `pi/${path}`),
    ];
    const currentMetadata = join(pstackRoot, "upstream.json");
    if (
      !existsSync(currentMetadata) ||
      !readFileSync(candidateMetadata).equals(readFileSync(currentMetadata))
    ) {
      differences.push("upstream.json");
    }

    if (options.check) {
      if (differences.length > 0) {
        console.error(`pstack is out of sync (${differences.length} path(s)):`);
        for (const path of differences.slice(0, 80)) console.error(`  ${path}`);
        if (differences.length > 80) console.error(`  ... ${differences.length - 80} more`);
        process.exitCode = 1;
      } else {
        console.log(`pstack is in sync at ${metadata.commit}`);
      }
      return;
    }

    mkdirSync(pstackRoot, { recursive: true });
    replacePath(candidateUpstream, join(pstackRoot, "upstream"));
    replacePath(candidatePi, join(pstackRoot, "pi"));
    replacePath(candidateMetadata, currentMetadata);
    console.log(`Synced pstack ${metadata.commit} (${metadata.tree})`);
    if (differences.length > 0) console.log(`Updated ${differences.length} path(s).`);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main();
