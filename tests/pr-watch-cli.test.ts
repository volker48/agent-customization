import { describe, expect, it } from "vitest";

import { DEFAULT_BOTS } from "../pi-extensions/pr-watch/bots.js";
import { detectForgeFromRemoteUrl } from "../pi-extensions/pr-watch/forge.js";
import { parseArgs } from "../pi-extensions/pr-watch/cli.js";

describe("parseArgs", () => {
  it("parses status defaults", () => {
    expect(parseArgs(["status"])).toEqual({
      command: "status",
      bots: DEFAULT_BOTS,
      all: false,
      nitpicks: false,
      noReviews: false,
      timeoutSecs: 1800,
      intervalSecs: 30,
    });
  });

  it("parses a PR number, repo, bot list, and findings flags", () => {
    expect(
      parseArgs([
        "findings",
        "63",
        "-R",
        "volker48/agent-customization",
        "--bots",
        "coderabbitai,chatgpt-codex-connector",
        "--all",
        "--nitpicks",
        "--no-reviews",
      ]),
    ).toEqual({
      command: "findings",
      pr: "63",
      repo: "volker48/agent-customization",
      bots: ["coderabbitai", "chatgpt-codex-connector"],
      all: true,
      nitpicks: true,
      noReviews: true,
      timeoutSecs: 1800,
      intervalSecs: 30,
    });
  });

  it("supports inline value flags", () => {
    expect(
      parseArgs([
        "wait",
        "--repo=volker48/agent-customization",
        "--bots=coderabbitai",
        "--forge=gitlab",
        "--timeout=60",
        "--interval=5",
        "63",
      ]),
    ).toMatchObject({
      command: "wait",
      pr: "63",
      repo: "volker48/agent-customization",
      bots: ["coderabbitai"],
      forge: "gitlab",
      timeoutSecs: 60,
      intervalSecs: 5,
    });
  });

  it("rejects unknown or missing subcommands", () => {
    expect(() => parseArgs([])).toThrow(/missing subcommand/);
    expect(() => parseArgs(["checks"])).toThrow(/unknown subcommand/);
  });

  it("parses and rejects forge flags", () => {
    expect(parseArgs(["status", "--forge", "github"])).toMatchObject({ forge: "github" });
    expect(parseArgs(["status", "--forge=gitlab"])).toMatchObject({ forge: "gitlab" });
    expect(() => parseArgs(["status", "--forge", "bitbucket"])).toThrow(/github or gitlab/);
  });

  it("rejects unknown flags and missing flag values", () => {
    expect(() => parseArgs(["status", "--bad"])).toThrow(/unknown flag/);
    expect(() => parseArgs(["status", "--repo"])).toThrow(/requires a value/);
  });

  it("rejects invalid or duplicate PR numbers", () => {
    expect(() => parseArgs(["status", "feature-branch"])).toThrow(/invalid PR number/);
    expect(() => parseArgs(["status", "63", "64"])).toThrow(/unexpected positional argument/);
  });

  it("rejects wait-only flags outside wait", () => {
    expect(() => parseArgs(["status", "--timeout", "60"])).toThrow(/only valid with wait/);
    expect(() => parseArgs(["findings", "--interval=5"])).toThrow(/only valid with wait/);
  });

  it("rejects empty bot lists and non-positive intervals", () => {
    expect(() => parseArgs(["status", "--bots="])).toThrow(/at least one bot/);
    expect(() => parseArgs(["wait", "--interval", "0"])).toThrow(/positive integer/);
  });
});

describe("detectForgeFromRemoteUrl", () => {
  it("selects gitlab when the origin host contains gitlab", () => {
    expect(detectForgeFromRemoteUrl("https://gitlab.com/group/project.git")).toBe("gitlab");
    expect(detectForgeFromRemoteUrl("git@gitlab.example.com:group/project.git")).toBe("gitlab");
  });

  it("defaults to github for non-gitlab or missing origins", () => {
    expect(detectForgeFromRemoteUrl("https://github.com/org/repo.git")).toBe("github");
    expect(detectForgeFromRemoteUrl(null)).toBe("github");
  });
});
