import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";

import orchestratorMinionsExtension from "../pi-extensions/orchestrator-minions/index.js";
import {
  DEFAULT_CHAIN_NAME,
  buildGreenPathChain,
  buildInstallTargets,
  buildLowEffortMinionProfile,
  parseOrchestratorMinionsArgs,
  renderInstallMarkdown,
  writeInstallTargets,
  type InstallDetails,
} from "../pi-extensions/orchestrator-minions/assets.js";

function parseJson(value: string): any {
  return JSON.parse(value);
}

describe("orchestrator-minions assets", () => {
  it("parses install command options", () => {
    const parsed = parseOrchestratorMinionsArgs(
      [
        "install --scope user",
        "--model openai/gpt-5.5",
        "--profile my-profile",
        "--chain my-chain",
        "--overwrite",
      ].join(" "),
    );

    expect(parsed.ok).toBe(true);
    expect(parsed.value).toMatchObject({
      action: "install",
      scope: "user",
      modelRef: "openai/gpt-5.5",
      profileName: "my-profile",
      chainName: "my-chain",
      overwrite: true,
    });
  });

  it("rejects unsafe names and invalid model refs", () => {
    expect(parseOrchestratorMinionsArgs("--chain ../bad")).toMatchObject({
      ok: false,
    });
    expect(parseOrchestratorMinionsArgs("--model gpt-5.5")).toMatchObject({
      ok: false,
    });
  });

  it("builds a low-effort profile for builtin minion roles", () => {
    const profile = parseJson(buildLowEffortMinionProfile("openai/gpt-5.5"));

    expect(profile.subagents.defaultModel).toBe("openai/gpt-5.5");
    expect(profile.subagents.agentOverrides.worker).toEqual({
      model: "openai/gpt-5.5",
      thinking: "low",
    });
    expect(profile.subagents.agentOverrides.reviewer.thinking).toBe("low");
  });

  it("builds the green path chain with review fanout and verified final checks", () => {
    const chain = parseJson(buildGreenPathChain(DEFAULT_CHAIN_NAME));

    expect(chain.name).toBe(DEFAULT_CHAIN_NAME);
    expect(chain.chain).toHaveLength(5);
    expect(chain.chain[0].parallel.map((task: any) => task.agent)).toEqual([
      "scout",
      "context-builder",
    ]);
    expect(chain.chain[3].parallel).toHaveLength(3);
    expect(chain.chain[4].acceptance.level).toBe("verified");
    expect(chain.chain[4].acceptance.verify.map((check: any) => check.command)).toEqual([
      "pnpm typecheck",
      "pnpm test",
    ]);
  });

  it("resolves profile and chain install targets", () => {
    const targets = buildInstallTargets({
      agentDir: "/agent",
      configDirName: ".pi",
      cwd: "/repo",
      scope: "project",
      profileName: "profile",
      chainName: "chain",
      modelRef: "openai/gpt-5.5",
    });

    expect(targets.map((target) => target.path)).toEqual([
      "/agent/profiles/pi-subagents/profile.json",
      "/repo/.pi/chains/chain.chain.json",
    ]);
  });

  it("does not overwrite different existing files without --overwrite", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orchestrator-minions-"));
    const target = {
      kind: "chain" as const,
      label: "chain",
      path: join(dir, "chain.chain.json"),
      content: "new content\n",
    };
    await writeFile(target.path, "custom content\n", "utf-8");

    const [result] = await writeInstallTargets([target], false);

    expect(result?.status).toBe("skipped");
    await expect(readFile(target.path, "utf-8")).resolves.toBe("custom content\n");
  });

  it("registers the command and handles renderer messages without details", () => {
    let renderer: ((message: { details?: InstallDetails }) => unknown) | undefined;
    const pi = {
      registerMessageRenderer: vi.fn((_type: string, fn: typeof renderer) => {
        renderer = fn;
      }),
      registerCommand: vi.fn(),
    };

    orchestratorMinionsExtension(pi as any);

    expect(pi.registerCommand).toHaveBeenCalledWith(
      "orchestrator-minions",
      expect.objectContaining({ description: "Install orchestrator-minion subagent assets" }),
    );
    expect(renderer?.({})).toBeUndefined();
  });

  it("renders next commands for the installed assets", () => {
    const markdown = renderInstallMarkdown({
      scope: "project",
      profileName: "profile",
      chainName: "chain",
      modelRef: "openai/gpt-5.5",
      results: [
        {
          kind: "profile",
          label: "profile profile",
          path: "/agent/profile.json",
          content: "{}\n",
          status: "created",
        },
      ],
    } satisfies InstallDetails);

    expect(markdown).toContain("/subagents-load-profile profile");
    expect(markdown).toContain("/run-chain chain -- <implementation task>");
  });
});
