import { beforeEach, describe, expect, it, vi } from "vitest";

import { runFusion } from "../pi-extensions/fusion/orchestrator.js";
import type { FusionConfig, FusionResult } from "../pi-extensions/fusion/types.js";

const debug = vi.hoisted(() => {
  const logger = {
    path: "/tmp/fusion-debug.jsonl",
    log: vi.fn(),
    flush: vi.fn(async () => undefined),
  };
  return {
    logger,
    create: vi.fn(() => logger),
    resolvePath: vi.fn(() => undefined as string | undefined),
  };
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
  BorderedLoader: class {
    onAbort?: () => void;
  },
  getMarkdownTheme: vi.fn(() => ({})),
}));

vi.mock("../pi-extensions/fusion/debug-log.js", () => ({
  createFusionDebugLogger: debug.create,
  progressLogDetails: vi.fn((event) => event),
  resolveFusionDebugLogPath: debug.resolvePath,
  resultLogDetails: vi.fn((result) => ({ status: result.status })),
}));

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

beforeEach(() => {
  debug.resolvePath.mockReset().mockReturnValue(undefined);
  debug.create.mockClear();
  debug.logger.log.mockReset();
  debug.logger.flush.mockReset().mockResolvedValue(undefined);
});

describe("fusion command", () => {
  function commandContext(onWidget: (factory: (tui: unknown, theme: unknown) => any) => void) {
    return {
      model: { id: "active/model" },
      modelRegistry: {},
      ui: {
        notify: vi.fn(),
        setStatus: vi.fn(),
        setWidget: vi.fn((_key: string, factory?: (tui: unknown, theme: unknown) => any) => {
          if (factory) onWidget(factory);
        }),
      },
    };
  }

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

  it.each([
    ["after runFusion resolves", "run"],
    ["during the first debug-log flush", "flush"],
    ["during the synthesis debug-log flush", "synthesis-flush"],
  ])("does not enqueue synthesis when cancelled %s", async (_window, cancellationPoint) => {
    debug.resolvePath.mockReturnValue("/tmp/fusion-debug.jsonl");
    let loader: { onAbort?: () => void } | undefined;
    const pi = {
      registerMessageRenderer: vi.fn(),
      registerCommand: vi.fn((_name: string, command: { handler: any }) => {
        handler = command.handler;
      }),
      sendMessage: vi.fn(),
    };
    let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
    fusionExtension(pi as any);
    const ctx = commandContext((factory) => {
      loader = factory({}, {});
    });

    if (cancellationPoint === "run") {
      vi.mocked(runFusion).mockImplementationOnce(async () => {
        loader?.onAbort?.();
        return recoverableJudgeFailure;
      });
    } else if (cancellationPoint === "flush") {
      debug.logger.flush.mockImplementationOnce(async () => {
        loader?.onAbort?.();
      });
    } else {
      debug.logger.flush.mockImplementationOnce(async () => undefined);
      debug.logger.flush.mockImplementationOnce(async () => {
        loader?.onAbort?.();
      });
    }

    await handler?.("task", ctx);

    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Fusion cancelled", "info");
  });
});
