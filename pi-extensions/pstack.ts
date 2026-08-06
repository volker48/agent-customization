import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export type PstackRoleValue = string | string[];

export interface PstackConfig {
  version: 1;
  roles: Record<string, PstackRoleValue>;
}

type TaskStatus = "pending" | "in_progress" | "completed" | "skipped";

interface PstackTask {
  id: number;
  text: string;
  status: TaskStatus;
}

interface PstackTaskDetails {
  action: "reset" | "add" | "update" | "list" | "clear";
  tasks: PstackTask[];
  nextId: number;
  error?: string;
}

const MODE_ENTRY = "pstack-mode-state";
const TASK_TOOL = "pstack_tasks";
const DEFAULT_CONFIG_PATH = fileURLToPath(
  new URL("../pstack/pi/model-defaults.json", import.meta.url),
);
const SKILL_NAMES_PATH = fileURLToPath(new URL("../pstack/pi/skill-names.json", import.meta.url));
const ADAPTER_PATH = fileURLToPath(new URL("../pstack/pi/PI_ADAPTER.md", import.meta.url));
const TASK_STATUSES = ["pending", "in_progress", "completed", "skipped"] as const;

const PstackTaskParams = Type.Object({
  action: StringEnum(["reset", "add", "update", "list", "clear"] as const),
  items: Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), {
      description: "Initial task texts for reset",
    }),
  ),
  text: Type.Optional(Type.String({ minLength: 1, description: "Task text for add or update" })),
  id: Type.Optional(Type.Integer({ minimum: 1, description: "Task id for update" })),
  status: Type.Optional(StringEnum(TASK_STATUSES)),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsePstackConfig(value: unknown, source: string): PstackConfig {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.roles)) {
    throw new Error(`${source} must contain { version: 1, roles: { ... } }`);
  }

  const roles: Record<string, PstackRoleValue> = {};
  for (const [role, configured] of Object.entries(value.roles)) {
    if (!role.trim()) throw new Error(`${source} contains an empty role name`);
    if (typeof configured === "string" && configured.trim()) {
      roles[role] = configured.trim();
      continue;
    }
    if (
      Array.isArray(configured) &&
      configured.length > 0 &&
      configured.every((entry) => typeof entry === "string" && entry.trim())
    ) {
      roles[role] = configured.map((entry) => entry.trim());
      continue;
    }
    throw new Error(`${source} has an invalid model value for role "${role}"`);
  }

  return { version: 1, roles };
}

export function mergePstackConfigs(
  defaults: PstackConfig,
  user: PstackConfig | undefined,
): PstackConfig {
  const roles = { ...defaults.roles };
  if (user) Object.assign(roles, user.roles);
  return { version: 1, roles };
}

export function buildSkillInvocation(skillName: string, args: string): string {
  const suffix = args.trim();
  return `/skill:${skillName}${suffix ? ` ${suffix}` : ""}`;
}

export function pstackUserConfigPath(): string {
  const agentDirectory = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  return join(agentDirectory, "pstack.json");
}

export function formatPstackRuntimePrompt(
  config: PstackConfig,
  skillName: string | undefined,
  modeActive: boolean,
): string {
  const roles = Object.entries(config.roles)
    .map(([role, value]) => `- ${role}: ${Array.isArray(value) ? value.join(", ") : value}`)
    .join("\n");
  const state = modeActive
    ? "Poteto mode is active for this session."
    : skillName
      ? "A pstack skill is active for this turn."
      : "pstack skills are available for model invocation this turn.";

  return `# pstack Pi runtime\n\n${state}${skillName ? ` Current entry skill: ${skillName}.` : ""}\nRead and obey the Pi adapter contract at ${ADAPTER_PATH}. It overrides Cursor-specific runtime instructions in upstream skill text.\n\nEffective pstack role models:\n${roles}`;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadEffectiveConfig(): { config: PstackConfig; warning?: string } {
  const defaults = parsePstackConfig(readJson(DEFAULT_CONFIG_PATH), DEFAULT_CONFIG_PATH);
  const userConfigPath = pstackUserConfigPath();
  try {
    const user = parsePstackConfig(readJson(userConfigPath), userConfigPath);
    return { config: mergePstackConfigs(defaults, user) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { config: defaults };
    return {
      config: defaults,
      warning: `Ignoring invalid ${userConfigPath}: ${(error as Error).message}`,
    };
  }
}

function loadSkillNames(): string[] {
  const value = readJson(SKILL_NAMES_PATH);
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`${SKILL_NAMES_PATH} must contain a JSON string array`);
  }
  return [...new Set(value)].sort();
}

function formatTasks(tasks: PstackTask[]): string {
  if (tasks.length === 0) return "No pstack tasks";
  return tasks
    .map((task) => {
      const marker =
        task.status === "completed"
          ? "x"
          : task.status === "skipped"
            ? "-"
            : task.status === "in_progress"
              ? ">"
              : " ";
      return `[${marker}] #${task.id} ${task.text}`;
    })
    .join("\n");
}

export default function pstackExtension(pi: ExtensionAPI) {
  const skillNames = loadSkillNames();
  const isPotetoChild = process.env.PI_SUBAGENT_CHILD_AGENT === "pstack.poteto";
  let modeActive = false;
  let pendingSkill: string | undefined;
  let lastConfigWarning: string | undefined;
  let tasks: PstackTask[] = [];
  let nextTaskId = 1;

  const setMode = (active: boolean) => {
    modeActive = active;
    pi.appendEntry(MODE_ENTRY, { active });
  };

  const reconstructState = (ctx: ExtensionContext) => {
    modeActive = false;
    pendingSkill = undefined;
    tasks = [];
    nextTaskId = 1;

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === MODE_ENTRY) {
        const data = entry.data as { active?: unknown } | undefined;
        if (typeof data?.active === "boolean") modeActive = data.active;
        continue;
      }
      if (entry.type !== "message") continue;
      const message = entry.message;
      if (message.role !== "toolResult" || message.toolName !== TASK_TOOL) continue;
      const details = message.details as PstackTaskDetails | undefined;
      if (!details) continue;
      tasks = details.tasks.map((task) => ({ ...task }));
      nextTaskId = details.nextId;
    }
  };

  pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
  pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

  pi.on("input", async (event) => {
    // An input can be cancelled before before_agent_start. Never let its skill marker
    // survive into a later, unrelated turn.
    pendingSkill = undefined;

    if (
      event.source !== "extension" &&
      /^\s*(?:please\s+)?(?:disable|exit|leave|stop|turn\s+off|opt\s+out\s+of)\s+(?:the\s+)?poteto(?:\s+mode)?[.!]?\s*$/i.test(
        event.text,
      )
    ) {
      setMode(false);
    }

    const skillMatch = event.text.match(/^\/skill:([a-z0-9-]+)(?:\s|$)/);
    if (skillMatch && skillNames.includes(skillMatch[1])) {
      pendingSkill = skillMatch[1];
      if (pendingSkill === "poteto-mode") setMode(true);
    }

    const aliasMatch = event.text.match(/^\/([a-z0-9-]+)(?:\s+(.*))?$/s);
    if (aliasMatch && skillNames.includes(aliasMatch[1])) {
      pendingSkill = aliasMatch[1];
      if (pendingSkill === "poteto-mode") setMode(true);
      return {
        action: "transform",
        text: buildSkillInvocation(pendingSkill, aliasMatch[2] ?? ""),
      };
    }

    return { action: "continue" };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const currentSkill = pendingSkill ?? (isPotetoChild ? "poteto-mode" : undefined);
    pendingSkill = undefined;
    const loaded = loadEffectiveConfig();
    if (loaded.warning && loaded.warning !== lastConfigWarning) {
      ctx.ui.notify(loaded.warning, "warning");
    }
    lastConfigWarning = loaded.warning;
    const runtimePrompt = formatPstackRuntimePrompt(
      loaded.config,
      currentSkill,
      modeActive || isPotetoChild,
    );
    return { systemPrompt: `${event.systemPrompt}\n\n${runtimePrompt}` };
  });

  pi.registerTool({
    name: TASK_TOOL,
    label: "pstack tasks",
    description:
      "Manage the current pstack workflow checklist. Reset at workflow start, then add, update, or list phase tasks.",
    promptSnippet: "Track pstack playbook phases and completion state",
    promptGuidelines: [
      "When following a pstack skill, read its linked Pi adapter contract before acting.",
      "Use pstack_tasks instead of Cursor TaskCreate, TaskUpdate, TaskList, or TaskGet instructions.",
      "When following pstack delegation instructions, use the Pi subagent tool and the role mappings in the adapter contract.",
    ],
    parameters: PstackTaskParams,
    async execute(_toolCallId, params) {
      let error: string | undefined;
      switch (params.action) {
        case "reset":
          nextTaskId = 1;
          tasks = (params.items ?? []).map((text) => ({
            id: nextTaskId++,
            text,
            status: "pending" as const,
          }));
          if (tasks.length === 0) nextTaskId = 1;
          break;
        case "add":
          if (!params.text) error = "text is required for add";
          else tasks.push({ id: nextTaskId++, text: params.text, status: "pending" });
          break;
        case "update": {
          if (params.id === undefined) {
            error = "id is required for update";
            break;
          }
          const task = tasks.find((candidate) => candidate.id === params.id);
          if (!task) {
            error = `task #${params.id} not found`;
            break;
          }
          if (!params.text && !params.status) {
            error = "text or status is required for update";
            break;
          }
          if (params.text) task.text = params.text;
          if (params.status) task.status = params.status;
          break;
        }
        case "clear":
          tasks = [];
          nextTaskId = 1;
          break;
        case "list":
          break;
      }

      const details: PstackTaskDetails = {
        action: params.action,
        tasks: tasks.map((task) => ({ ...task })),
        nextId: nextTaskId,
        ...(error ? { error } : {}),
      };
      return {
        content: [
          {
            type: "text" as const,
            text: error ? `Error: ${error}\n${formatTasks(tasks)}` : formatTasks(tasks),
          },
        ],
        details,
      };
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("pstack tasks "));
      text += theme.fg("muted", args.action);
      if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
      return new Text(text, 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details as PstackTaskDetails | undefined;
      if (!details) return new Text("", 0, 0);
      if (details.error) return new Text(theme.fg("error", details.error), 0, 0);
      const completed = details.tasks.filter(
        (task) => task.status === "completed" || task.status === "skipped",
      ).length;
      return new Text(
        theme.fg("muted", `${completed}/${details.tasks.length} phases settled`),
        0,
        0,
      );
    },
  });

  pi.registerCommand("pstack-off", {
    description: "Disable sticky poteto mode for this session",
    handler: async (_args, ctx) => {
      setMode(false);
      ctx.ui.notify("Poteto mode disabled for this session", "info");
    },
  });

  pi.registerCommand("pstack-status", {
    description: "Show pstack mode, upstream, and effective model configuration",
    handler: async (_args, ctx) => {
      const loaded = loadEffectiveConfig();
      const upstream = readJson(
        fileURLToPath(new URL("../pstack/upstream.json", import.meta.url)),
      ) as { commit?: unknown };
      const roleCount = Object.keys(loaded.config.roles).length;
      const message = [
        `poteto mode: ${modeActive ? "on" : "off"}`,
        `upstream: ${typeof upstream.commit === "string" ? upstream.commit : "unknown"}`,
        `model roles: ${roleCount}`,
        `user config: ${pstackUserConfigPath()}`,
        ...(loaded.warning ? [loaded.warning] : []),
      ].join("\n");
      ctx.ui.notify(message, loaded.warning ? "warning" : "info");
    },
  });
}
