import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const ORCHESTRATOR_MINIONS_MESSAGE_TYPE = "orchestrator-minions";
export const DEFAULT_CHAIN_NAME = "green-path-implementation";
export const DEFAULT_PROFILE_NAME = "gpt55-low-minions";
export const COMMAND_USAGE = [
  "Usage: /orchestrator-minions [install] [options]",
  "",
  "Options:",
  "  --scope user|project     Where to save the chain. Default: project.",
  "  --model provider/model   Minion model. Default: current Pi model.",
  "  --profile name           Profile filename. Default: gpt55-low-minions.",
  "  --chain name             Chain filename/name. Default: green-path-implementation.",
  "  --overwrite              Replace existing different files.",
].join("\n");

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LOW_EFFORT_AGENTS = [
  "scout",
  "delegate",
  "planner",
  "context-builder",
  "researcher",
  "worker",
  "reviewer",
  "oracle",
] as const;

export type InstallScope = "user" | "project";
export type InstallAction = "install" | "help";

export interface ParsedOrchestratorMinionsArgs {
  action: InstallAction;
  scope: InstallScope;
  overwrite: boolean;
  profileName: string;
  chainName: string;
  modelRef?: string;
}

export interface ParseResult {
  ok: boolean;
  value?: ParsedOrchestratorMinionsArgs;
  error?: string;
}

export interface InstallTarget {
  kind: "profile" | "chain";
  path: string;
  label: string;
  content: string;
}

export interface WriteResult extends InstallTarget {
  status: "created" | "updated" | "unchanged" | "skipped";
}

export interface InstallDetails {
  scope: InstallScope;
  profileName: string;
  chainName: string;
  modelRef: string;
  results: WriteResult[];
}

function normalizeName(value: string, label: string): string {
  const trimmed = value.trim();
  if (!SAFE_NAME.test(trimmed) || trimmed === "." || trimmed === "..") {
    throw new Error(
      `${label} must be a safe file name using letters, numbers, dots, underscores, or hyphens.`,
    );
  }
  return trimmed;
}

function readFlagValue(tokens: string[], index: number): { value?: string; nextIndex: number } {
  const token = tokens[index] ?? "";
  const equalsIndex = token.indexOf("=");
  if (equalsIndex !== -1) {
    return { value: token.slice(equalsIndex + 1), nextIndex: index + 1 };
  }
  return { value: tokens[index + 1], nextIndex: index + 2 };
}

export function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;

  for (const char of input.trim()) {
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  if (quote) throw new Error("Unclosed quote in arguments.");
  return tokens;
}

function parseScope(value: string | undefined): InstallScope {
  if (value === "user" || value === "project") return value;
  throw new Error("--scope must be 'user' or 'project'.");
}

function validateModelRef(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed.includes("/")) {
    throw new Error("--model must use provider/model form, for example openai/gpt-5.5.");
  }
  return trimmed;
}

export function parseOrchestratorMinionsArgs(input: string): ParseResult {
  try {
    const tokens = tokenizeArgs(input);
    const first = tokens[0];
    if (first === "help" || first === "--help" || first === "-h") {
      return { ok: true, value: defaultParsedArgs("help") };
    }
    let index = first === "install" ? 1 : 0;
    const parsed = defaultParsedArgs("install");

    while (index < tokens.length) {
      const token = tokens[index] ?? "";
      const [flag] = token.split("=", 1);
      if (flag === "--overwrite") {
        parsed.overwrite = true;
        index += 1;
      } else if (flag === "--scope") {
        const result = readFlagValue(tokens, index);
        parsed.scope = parseScope(result.value);
        index = result.nextIndex;
      } else if (flag === "--model") {
        const result = readFlagValue(tokens, index);
        parsed.modelRef = validateModelRef(result.value);
        index = result.nextIndex;
      } else if (flag === "--profile") {
        const result = readFlagValue(tokens, index);
        parsed.profileName = normalizeName(result.value ?? "", "Profile name");
        index = result.nextIndex;
      } else if (flag === "--chain") {
        const result = readFlagValue(tokens, index);
        parsed.chainName = normalizeName(result.value ?? "", "Chain name");
        index = result.nextIndex;
      } else {
        return { ok: false, error: `Unknown argument: ${token}` };
      }
    }

    return { ok: true, value: parsed };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function defaultParsedArgs(action: InstallAction): ParsedOrchestratorMinionsArgs {
  return {
    action,
    scope: "project",
    overwrite: false,
    profileName: DEFAULT_PROFILE_NAME,
    chainName: DEFAULT_CHAIN_NAME,
  };
}

export function buildLowEffortMinionProfile(modelRef: string): string {
  const agentOverrides = Object.fromEntries(
    LOW_EFFORT_AGENTS.map((agent) => [agent, { model: modelRef, thinking: "low" }]),
  );
  return `${JSON.stringify({ subagents: { defaultModel: modelRef, agentOverrides } }, null, 2)}\n`;
}

export function buildGreenPathChain(chainName = DEFAULT_CHAIN_NAME): string {
  const chain = {
    name: chainName,
    description: "Scout, plan, implement, review, fix, and verify with low-effort minions.",
    chain: [contextStep(), planStep(), implementStep(), reviewStep(), fixAndVerifyStep()],
  };
  return `${JSON.stringify(chain, null, 2)}\n`;
}

function contextStep() {
  return {
    parallel: [
      {
        agent: "scout",
        phase: "Context",
        label: "Codebase context",
        as: "codeContext",
        task: "Gather implementation context for: {task}",
        output: "context/codebase.md",
        outputMode: "file-only",
      },
      {
        agent: "context-builder",
        phase: "Context",
        label: "Validation risks",
        as: "validationContext",
        task: "Identify validation strategy, likely tests, and risks for: {task}",
        output: "context/validation.md",
        outputMode: "file-only",
      },
    ],
    concurrency: 2,
  };
}

function planStep() {
  return {
    agent: "planner",
    phase: "Plan",
    label: "Implementation plan",
    as: "plan",
    task: [
      "Create a concrete implementation plan for {task}.",
      "",
      "Code context: {outputs.codeContext}",
      "Validation context: {outputs.validationContext}",
    ].join("\n"),
    output: "plan.md",
    outputMode: "file-only",
  };
}

function implementStep() {
  return {
    agent: "worker",
    phase: "Implementation",
    label: "Implement",
    as: "implementation",
    task: [
      "Implement this approved plan: {outputs.plan}.",
      "Return changed files, commands run, validation evidence, and residual risks.",
    ].join("\n"),
    output: "implementation.md",
    outputMode: "file-only",
    progress: true,
    acceptance: {
      level: "checked",
      evidence: ["changed-files", "commands-run", "residual-risks", "no-staged-files"],
    },
  };
}

function reviewStep() {
  return {
    parallel: [
      {
        agent: "reviewer",
        phase: "Review",
        label: "Correctness",
        task: [
          "Review the current diff for correctness/regressions.",
          "Do not modify project/source files.",
        ].join(" "),
        output: false,
      },
      {
        agent: "reviewer",
        phase: "Review",
        label: "Tests",
        task: [
          "Review the current diff for test and validation gaps.",
          "Do not modify project/source files.",
        ].join(" "),
        output: false,
      },
      {
        agent: "reviewer",
        phase: "Review",
        label: "Simplicity",
        task: [
          "Review the current diff for unnecessary complexity.",
          "Do not modify project/source files.",
        ].join(" "),
        output: false,
      },
    ],
    concurrency: 3,
  };
}

function fixAndVerifyStep() {
  return {
    agent: "worker",
    phase: "Fix",
    label: "Apply review fixes and verify",
    task: [
      "Apply only fixes worth doing now from the reviewer feedback in {previous}.",
      "Preserve scope. Run focused validation and summarize final state.",
    ].join("\n"),
    output: "fixes.md",
    outputMode: "file-only",
    acceptance: {
      level: "verified",
      evidence: ["changed-files", "commands-run", "residual-risks", "no-staged-files"],
      verify: [
        { id: "typecheck", command: "pnpm typecheck", timeoutMs: 120000 },
        { id: "test", command: "pnpm test", timeoutMs: 180000 },
      ],
    },
  };
}

export function buildInstallTargets(input: {
  agentDir: string;
  configDirName: string;
  cwd: string;
  scope: InstallScope;
  profileName: string;
  chainName: string;
  modelRef: string;
}): InstallTarget[] {
  const chainRoot =
    input.scope === "project"
      ? join(input.cwd, input.configDirName, "chains")
      : join(input.agentDir, "chains");
  return [
    {
      kind: "profile",
      path: join(input.agentDir, "profiles", "pi-subagents", `${input.profileName}.json`),
      label: `profile ${input.profileName}`,
      content: buildLowEffortMinionProfile(input.modelRef),
    },
    {
      kind: "chain",
      path: join(chainRoot, `${input.chainName}.chain.json`),
      label: `${input.scope} chain ${input.chainName}`,
      content: buildGreenPathChain(input.chainName),
    },
  ];
}

async function writeOneTarget(target: InstallTarget, overwrite: boolean): Promise<WriteResult> {
  let existing: string | undefined;
  try {
    existing = await readFile(target.path, "utf-8");
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? error.code : undefined;
    if (code !== "ENOENT") throw error;
  }

  if (existing === target.content) return { ...target, status: "unchanged" };
  if (existing !== undefined && !overwrite) return { ...target, status: "skipped" };
  await mkdir(dirname(target.path), { recursive: true });
  await writeFile(target.path, target.content, "utf-8");
  return { ...target, status: existing === undefined ? "created" : "updated" };
}

export async function writeInstallTargets(
  targets: InstallTarget[],
  overwrite: boolean,
): Promise<WriteResult[]> {
  const results: WriteResult[] = [];
  for (const target of targets) results.push(await writeOneTarget(target, overwrite));
  return results;
}

export function renderInstallMarkdown(details: InstallDetails): string {
  const lines = [
    "# Orchestrator-minions assets",
    "",
    `- Profile: \`${details.profileName}\``,
    `- Chain: \`${details.chainName}\``,
    `- Chain scope: \`${details.scope}\``,
    `- Minion model: \`${details.modelRef}\` with \`thinking: low\``,
    "",
    "## Files",
    "",
  ];

  for (const result of details.results) {
    lines.push(
      `- ${statusIcon(result.status)} \`${result.status}\` ${result.label}: ${result.path}`,
    );
  }
  lines.push("", "## Next commands", "", "```text");
  lines.push(`/subagents-load-profile ${details.profileName}`);
  lines.push(`/run-chain ${details.chainName} -- <implementation task>`);
  lines.push("```");
  return lines.join("\n");
}

function statusIcon(status: WriteResult["status"]): string {
  if (status === "created" || status === "updated") return "✓";
  if (status === "unchanged") return "=";
  return "!";
}

export function toInstallMessage(details: InstallDetails) {
  return {
    customType: ORCHESTRATOR_MINIONS_MESSAGE_TYPE,
    content: renderInstallMarkdown(details),
    display: true,
    details,
  };
}
