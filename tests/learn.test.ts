import { describe, expect, it, vi } from "vitest";

import learnExtension, {
  buildLearnPrompt,
  PI_EXTENSION_AUTHORING_STANDARDS,
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
    expect(prompt).toContain("reusable Pi coding-agent extension");
  });

  it("includes the Pi extension authoring standards", () => {
    const prompt = buildLearnPrompt("learn this workflow");

    expect(prompt).toContain(PI_EXTENSION_AUTHORING_STANDARDS);
    expect(prompt).toContain("Keep implementation in TypeScript. Do not add Python.");
    expect(prompt).toContain("Add or update Vitest tests");
  });

  it("separates sources from requirements", () => {
    const prompt = buildLearnPrompt("./sdk focus on OAuth and ignore generated clients");
    const lower = prompt.toLowerCase();

    expect(lower).toContain("sources to gather");
    expect(lower).toContain("requirements that shape the extension");
    expect(lower).toContain("never fetch the first source and ignore the rest");
  });

  it("instructs the agent to create one TypeScript extension with tests", () => {
    const prompt = buildLearnPrompt("our release checklist");

    expect(prompt).toContain("Build ONE focused Pi coding-agent extension in TypeScript");
    expect(prompt).toContain("Save the code in the repo and add/update tests");
  });
});

describe("learn extension", () => {
  it("registers the learn command", () => {
    const { pi, command } = createMockPi();

    learnExtension(pi as never);

    expect(pi.registerCommand).toHaveBeenCalledWith("learn", expect.any(Object));
    expect(command().description).toBe(
      "Build a reusable Pi extension from docs, code, or this chat",
    );
  });

  it("sends the built prompt as a normal user message", async () => {
    const { pi, ctx, command } = createMockPi();
    const request = "docs/api.md focus on command routing";

    learnExtension(pi as never);
    await command().handler(request, ctx);

    expect(pi.sendUserMessage).toHaveBeenCalledWith(buildLearnPrompt(request));
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Learning a Pi extension from what you described…",
      "info",
    );
  });

  it("notifies that bare /learn uses the conversation", async () => {
    const { pi, ctx, command } = createMockPi();

    learnExtension(pi as never);
    await command().handler("", ctx);

    expect(pi.sendUserMessage).toHaveBeenCalledWith(buildLearnPrompt(""));
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Learning a Pi extension from this conversation…",
      "info",
    );
  });
});
