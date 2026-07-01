import { describe, expect, it, vi } from "vitest";

import type { FusionConfig, FusionResult } from "../pi-extensions/fusion/types.js";

const config: FusionConfig = {
  judge: "anthropic/claude-opus-4-8",
  models: ["openai/gpt-5"],
  maxToolCalls: 0,
};

const recoverableJudgeFailure: FusionResult = {
  status: "error",
  prompt: "task",
  judge: config.judge,
  responses: [
    {
      model: "openai/gpt-5",
      runId: "run-1",
      status: "ok",
      content: "expensive panel result",
      elapsedMs: 100,
      toolCalls: [],
    },
  ],
  error: "Fusion judge failed after 1/1 panel responses succeeded: judge down",
  elapsedMs: 200,
};

vi.mock("../pi-extensions/fusion/config.js", () => ({
  loadFusionConfig: vi.fn(async () => config),
}));

vi.mock("../pi-extensions/fusion/orchestrator.js", () => ({
  runFusion: vi.fn(async () => recoverableJudgeFailure),
}));

const { default: fusionExtension } = await import("../pi-extensions/fusion/index.js");

describe("fusion command", () => {
  it("sends a recovery synthesis message when the judge fails after panels succeed", async () => {
    let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
    const pi = {
      registerMessageRenderer: vi.fn(),
      registerCommand: vi.fn((_name: string, command: { handler: typeof handler }) => {
        handler = command.handler;
      }),
      sendMessage: vi.fn(),
    };
    const ctx = {
      model: { id: "active/model" },
      modelRegistry: {},
      ui: {
        notify: vi.fn(),
        setStatus: vi.fn(),
        setWidget: vi.fn(),
      },
    };

    fusionExtension(pi as any);
    await handler?.("task", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("judge down"), "error");
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "fusion-panel",
        content: expect.stringContaining("expensive panel result"),
      }),
      { triggerTurn: true },
    );
  });
});
