import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import pstackExtension, {
  buildSkillInvocation,
  formatPstackRuntimePrompt,
  mergePstackConfigs,
  parsePstackConfig,
  pstackUserConfigPath,
  type PstackConfig,
} from "../pi-extensions/pstack.js";

const root = process.cwd();
const generatedRoot = join(root, "pstack", "pi");

type Command = {
  description: string;
  handler: (args: string, ctx: unknown) => Promise<void>;
};

type RegisteredTool = {
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;
};

function createMockPi() {
  const commands = new Map<string, Command>();
  const tools = new Map<string, RegisteredTool>();
  const listeners = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const pi = {
    appendEntry: vi.fn(),
    on: vi.fn((name: string, handler: (event: any, ctx: any) => unknown) => {
      listeners.set(name, [...(listeners.get(name) ?? []), handler]);
    }),
    registerCommand: vi.fn((name: string, command: Command) => {
      commands.set(name, command);
    }),
    registerTool: vi.fn((tool: RegisteredTool & { name: string }) => {
      tools.set(tool.name, tool);
    }),
    sendUserMessage: vi.fn(),
  };
  return { pi, commands, tools, listeners };
}

describe("pstack config", () => {
  const defaults: PstackConfig = {
    version: 1,
    roles: {
      worker: "openai/model:high",
      panel: ["openai/model:high", "anthropic/model:high"],
    },
  };

  it("parses and normalizes role values", () => {
    expect(
      parsePstackConfig(
        {
          version: 1,
          roles: { worker: " openai/model:high ", panel: ["a/model", "b/model"] },
        },
        "test config",
      ),
    ).toEqual({
      version: 1,
      roles: { worker: "openai/model:high", panel: ["a/model", "b/model"] },
    });
  });

  it("rejects empty panels and malformed versions", () => {
    expect(() => parsePstackConfig({ version: 1, roles: { panel: [] } }, "test config")).toThrow(
      /invalid model value/,
    );
    expect(() => parsePstackConfig({ version: 2, roles: {} }, "test config")).toThrow(/version: 1/);
  });

  it("merges user roles over tracked defaults", () => {
    expect(
      mergePstackConfigs(defaults, {
        version: 1,
        roles: { worker: "inherit-parent" },
      }),
    ).toEqual({
      version: 1,
      roles: {
        worker: "inherit-parent",
        panel: ["openai/model:high", "anthropic/model:high"],
      },
    });
  });

  it("formats skill invocations and runtime model context", () => {
    expect(buildSkillInvocation("poteto-mode", "  fix it ")).toBe("/skill:poteto-mode fix it");
    const prompt = formatPstackRuntimePrompt(defaults, "poteto-mode", true);
    expect(prompt).toContain("Poteto mode is active");
    expect(prompt).toContain("worker: openai/model:high");
    expect(prompt).toContain("panel: openai/model:high, anthropic/model:high");
    expect(prompt).toContain("PI_ADAPTER.md");
  });

  it("resolves user config from PI_CODING_AGENT_DIR", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/tmp/custom-pi-agent");
    try {
      expect(pstackUserConfigPath()).toBe("/tmp/custom-pi-agent/pstack.json");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("pstack extension", () => {
  it("transforms Cursor-style aliases before Pi skill expansion", async () => {
    const { pi, commands, listeners } = createMockPi();
    pstackExtension(pi as never);

    expect(commands.has("poteto-mode")).toBe(false);
    expect(commands.has("setup-pstack")).toBe(false);
    expect(commands.has("pstack-off")).toBe(true);
    expect(commands.has("pstack-status")).toBe(true);

    const input = listeners.get("input")![0];
    const result = await input({ text: "/poteto-mode fix the race", source: "interactive" }, {});

    expect(result).toEqual({
      action: "transform",
      text: "/skill:poteto-mode fix the race",
    });
    expect(pi.appendEntry).toHaveBeenCalledWith("pstack-mode-state", {
      active: true,
    });
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("injects the effective model map into direct pstack.poteto children", async () => {
    vi.stubEnv("PI_SUBAGENT_CHILD_AGENT", "pstack.poteto");
    try {
      const { pi, listeners } = createMockPi();
      pstackExtension(pi as never);
      const beforeAgentStart = listeners.get("before_agent_start")![0];

      const result = (await beforeAgentStart({ systemPrompt: "base" }, {})) as {
        systemPrompt: string;
      };

      expect(result.systemPrompt).toContain("Poteto mode is active");
      expect(result.systemPrompt).toContain("Current entry skill: poteto-mode");
      expect(result.systemPrompt).toContain("Effective pstack role models");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("injects runtime context before model-invoked pstack skills", async () => {
    const { pi, listeners } = createMockPi();
    pstackExtension(pi as never);
    const beforeAgentStart = listeners.get("before_agent_start")![0];

    const result = (await beforeAgentStart({ systemPrompt: "base" }, {})) as {
      systemPrompt: string;
    };

    expect(result.systemPrompt).toContain("pstack skills are available for model invocation");
    expect(result.systemPrompt).toContain("Effective pstack role models");
  });

  it("clears cancelled skill markers before unrelated turns", async () => {
    const { pi, listeners } = createMockPi();
    pstackExtension(pi as never);
    const input = listeners.get("input")![0];
    const beforeAgentStart = listeners.get("before_agent_start")![0];

    await input({ text: "/skill:tdd fix it", source: "interactive" }, {});
    await input({ text: "unrelated question", source: "interactive" }, {});
    const result = (await beforeAgentStart({ systemPrompt: "base" }, {})) as {
      systemPrompt: string;
    };

    expect(result.systemPrompt).not.toContain("Current entry skill: tdd");
    expect(result.systemPrompt).toContain("pstack skills are available for model invocation");
  });

  it("disables sticky mode only for explicit opt-out input", async () => {
    const { pi, listeners } = createMockPi();
    pstackExtension(pi as never);
    const input = listeners.get("input")![0];
    const beforeAgentStart = listeners.get("before_agent_start")![0];

    await input({ text: "/poteto-mode fix it", source: "interactive" }, {});
    await input(
      {
        text: "don't stop until the poteto checklist is green",
        source: "interactive",
      },
      {},
    );
    const active = (await beforeAgentStart({ systemPrompt: "base" }, {})) as {
      systemPrompt: string;
    };
    expect(active.systemPrompt).toContain("Poteto mode is active");

    await input({ text: "Please stop poteto mode.", source: "interactive" }, {});
    const inactive = (await beforeAgentStart({ systemPrompt: "base" }, {})) as {
      systemPrompt: string;
    };
    expect(inactive.systemPrompt).not.toContain("Poteto mode is active");
  });

  it("surfaces invalid user config warnings during normal turns", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "pstack-invalid-config-"));
    const notify = vi.fn();
    writeFileSync(join(tempRoot, "pstack.json"), "not json\n");
    vi.stubEnv("PI_CODING_AGENT_DIR", tempRoot);
    try {
      const { pi, listeners } = createMockPi();
      pstackExtension(pi as never);
      const beforeAgentStart = listeners.get("before_agent_start")![0];

      await beforeAgentStart({ systemPrompt: "base" }, { ui: { notify } });

      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining(`Ignoring invalid ${join(tempRoot, "pstack.json")}`),
        "warning",
      );
    } finally {
      vi.unstubAllEnvs();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("tracks playbook phases in session-backed tool details", async () => {
    const { pi, tools } = createMockPi();
    pstackExtension(pi as never);
    const tool = tools.get("pstack_tasks")!;

    const reset = await tool.execute("1", {
      action: "reset",
      items: ["Read principles", "Verify"],
    });
    expect(reset.content[0].text).toContain("#1 Read principles");
    expect(reset.details).toMatchObject({
      tasks: [
        { id: 1, text: "Read principles", status: "pending" },
        { id: 2, text: "Verify", status: "pending" },
      ],
      nextId: 3,
    });

    const update = await tool.execute("2", {
      action: "update",
      id: 1,
      status: "completed",
    });
    expect(update.content[0].text).toContain("[x] #1 Read principles");
  });
});

describe("generated pstack package", () => {
  it("keeps an exact upstream snapshot and publishes adapted skills", () => {
    const metadata = JSON.parse(readFileSync(join(root, "pstack", "upstream.json"), "utf8")) as {
      commit: string;
    };
    expect(metadata.commit).toMatch(/^[0-9a-f]{40}$/);

    const upstreamPoteto = readFileSync(
      join(root, "pstack", "upstream", "skills", "poteto-mode", "SKILL.md"),
      "utf8",
    );
    const generatedPoteto = readFileSync(
      join(generatedRoot, "skills", "poteto-mode", "SKILL.md"),
      "utf8",
    );
    expect(upstreamPoteto).toContain("name: Poteto Mode");
    expect(generatedPoteto).toContain("name: poteto-mode");
    expect(generatedPoteto).toContain("the Pi adapter contract");
  });

  it("links every upstream-derived skill to the adapter and indexes unique names", () => {
    const skillRoot = join(generatedRoot, "skills");
    const directories = readdirSync(skillRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const names = JSON.parse(
      readFileSync(join(generatedRoot, "skill-names.json"), "utf8"),
    ) as string[];

    const finalNames = directories
      .map((directory) => {
        const skill = readFileSync(join(skillRoot, directory, "SKILL.md"), "utf8");
        const name = skill.match(/^name:\s*(.+)$/m)?.[1].trim();
        expect(name, directory).toBeTruthy();
        if (directory !== "setup-pstack") {
          expect(skill, directory).toContain("the Pi adapter contract");
        }
        return name!;
      })
      .sort();

    expect(names).toHaveLength(new Set(names).size);
    expect(names).toContain("poteto-mode");
    expect(names).toContain("setup-pstack");
    expect(names).toEqual(finalNames);
  });

  it("publishes only namespaced Pi agent overlays", () => {
    const agentFiles = readdirSync(join(generatedRoot, "agents")).sort();
    expect(agentFiles).toEqual(["poteto-agent.md"]);
    const agent = readFileSync(join(generatedRoot, "agents", "poteto-agent.md"), "utf8");
    expect(agent).toContain("package: pstack");
    expect(agent).toContain("name: poteto");
    expect(agent).toContain(
      "tools: read, grep, find, ls, bash, edit, write, pstack_tasks, subagent, subagent_wait",
    );
    expect(agent).toContain("maxSubagentDepth: 2");
  });

  it("regenerates cleanly from the pinned local snapshot", () => {
    expect(() =>
      execFileSync(
        process.execPath,
        ["scripts/sync-pstack.mjs", "--check", "--source", "pstack/upstream"],
        { cwd: root, stdio: "pipe" },
      ),
    ).not.toThrow();
  }, 30_000);

  it("rejects content and executable-mode drift from the pinned git tree", () => {
    const metadata = JSON.parse(readFileSync(join(root, "pstack", "upstream.json"), "utf8")) as {
      commit: string;
      tree: string;
    };
    const runDriftCheck = (mutate: (source: string) => void) => {
      const tempRoot = mkdtempSync(join(tmpdir(), "pstack-tree-drift-"));
      const source = join(tempRoot, "pstack");
      try {
        cpSync(join(root, "pstack", "upstream"), source, { recursive: true });
        mutate(source);
        expect(() =>
          execFileSync(
            process.execPath,
            [
              "scripts/sync-pstack.mjs",
              "--check",
              "--source",
              source,
              "--commit",
              metadata.commit,
              "--tree",
              metadata.tree,
            ],
            { cwd: root, stdio: "pipe" },
          ),
        ).toThrow(/does not match expected tree/);
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    };

    runDriftCheck((source) => appendFileSync(join(source, "README.md"), "\ndrift\n"));
    runDriftCheck((source) =>
      chmodSync(join(source, "skills", "show-me-your-work", "scripts", "log.sh"), 0o644),
    );
  }, 30_000);

  it("requires --commit and --tree together", () => {
    expect(() =>
      execFileSync(
        process.execPath,
        [
          "scripts/sync-pstack.mjs",
          "--check",
          "--source",
          "pstack/upstream",
          "--commit",
          "14d9dfa06283faa94bf9931d3e98c189bc375680",
        ],
        { cwd: root, stdio: "pipe" },
      ),
    ).toThrow(/--commit and --tree must be supplied together/);
  });

  it("stops when any upstream path hidden by a full Pi overlay changes", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "pstack-overlay-review-"));
    const source = join(tempRoot, "pstack");
    try {
      cpSync(join(root, "pstack", "upstream"), source, { recursive: true });
      const references = join(source, "skills", "setup-pstack", "references");
      mkdirSync(references, { recursive: true });
      writeFileSync(join(references, "new-upstream-behavior.md"), "new behavior\n");

      expect(() =>
        execFileSync(process.execPath, ["scripts/sync-pstack.mjs", "--check", "--source", source], {
          cwd: root,
          stdio: "pipe",
        }),
      ).toThrow(/full Pi overlays changed/);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects upstream agents without namespaced Pi overlays", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "pstack-agent-review-"));
    const source = join(tempRoot, "pstack");
    try {
      cpSync(join(root, "pstack", "upstream"), source, { recursive: true });
      writeFileSync(
        join(source, "agents", "reviewer.md"),
        "---\nname: reviewer\ndescription: Cursor reviewer\n---\n",
      );

      expect(() =>
        execFileSync(process.execPath, ["scripts/sync-pstack.mjs", "--check", "--source", source], {
          cwd: root,
          stdio: "pipe",
        }),
      ).toThrow(/require namespaced Pi overlays.*reviewer\.md/);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects upstream paths ignored by repository Git rules", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "pstack-ignore-review-"));
    const source = join(tempRoot, "pstack");
    try {
      cpSync(join(root, "pstack", "upstream"), source, { recursive: true });
      writeFileSync(join(source, "future-upstream.log"), "must not disappear from clones\n");

      expect(() =>
        execFileSync(process.execPath, ["scripts/sync-pstack.mjs", "--check", "--source", source], {
          cwd: root,
          stdio: "pipe",
        }),
      ).toThrow(/cannot be vendored reproducibly because Git ignores/);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
