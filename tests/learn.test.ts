import { describe, expect, it, vi } from "vitest";

import learnExtension, {
  buildLearnPrompt,
  SKILL_AUTHORING_STANDARDS,
} from "../pi-extensions/learn.js";

type RegisteredCommand = {
  description: string;
  handler: (
    args: string,
    ctx: { ui: { notify: (message: string, level?: string) => void } },
  ) => Promise<void>;
};

function createMockPi() {
  let command: RegisteredCommand | undefined;
  const pi = {
    registerCommand: vi.fn((_name: string, registered: RegisteredCommand) => {
      command = registered;
    }),
    sendUserMessage: vi.fn(),
  };
  const ctx = {
    ui: {
      notify: vi.fn(),
    },
  };

  return {
    pi,
    ctx,
    command() {
      if (!command) {
        throw new Error("missing learn command");
      }
      return command;
    },
  };
}

describe("buildLearnPrompt", () => {
  it("embeds the user request verbatim", () => {
    const request = "https://example.com/docs focus on auth, skip deprecated endpoints";

    const prompt = buildLearnPrompt(request);

    expect(prompt).toContain(request);
  });

  it("falls back to the current conversation for bare /learn", () => {
    const prompt = buildLearnPrompt("   \n  ");

    expect(prompt).toContain("workflow we just went through in this conversation");
    expect(prompt).toContain("reusable agent skill");
  });

  it("includes the skill authoring standards", () => {
    const prompt = buildLearnPrompt("learn this workflow");

    expect(prompt).toContain(SKILL_AUTHORING_STANDARDS);
    expect(prompt).toContain("Create ONE reusable agent skill, not a Pi extension");
    expect(prompt).toContain("Save the skill as a SKILL.md file under skills/<skill-name>/");
  });

  it("separates sources from requirements", () => {
    const prompt = buildLearnPrompt("./sdk focus on OAuth and ignore generated clients");
    const lower = prompt.toLowerCase();

    expect(lower).toContain("sources to gather");
    expect(lower).toContain("requirements that shape the skill");
    expect(lower).toContain("never fetch the first source and ignore the rest");
  });

  it("instructs the agent to create one skill under skills", () => {
    const prompt = buildLearnPrompt("our release checklist");

    expect(prompt).toContain("Author ONE focused SKILL.md under skills/<skill-name>/");
    expect(prompt).toContain("supporting scripts, templates, or references");
  });
});

describe("learn extension", () => {
  it("registers the learn command", () => {
    const { pi, command } = createMockPi();

    learnExtension(pi as never);

    expect(pi.registerCommand).toHaveBeenCalledWith("learn", expect.any(Object));
    expect(command().description).toBe(
      "Learn a reusable skill from docs, code, or this chat",
    );
  });

  it("sends the built prompt as a normal user message", async () => {
    const { pi, ctx, command } = createMockPi();
    const request = "docs/api.md focus on command routing";

    learnExtension(pi as never);
    await command().handler(request, ctx);

    expect(pi.sendUserMessage).toHaveBeenCalledWith(buildLearnPrompt(request));
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Learning a skill from what you described…",
      "info",
    );
  });

  it("notifies that bare /learn uses the conversation", async () => {
    const { pi, ctx, command } = createMockPi();

    learnExtension(pi as never);
    await command().handler("", ctx);

    expect(pi.sendUserMessage).toHaveBeenCalledWith(buildLearnPrompt(""));
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Learning a skill from this conversation…",
      "info",
    );
  });
});
