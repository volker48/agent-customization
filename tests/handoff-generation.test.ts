import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { completeMock } = vi.hoisted(() => ({
  completeMock: vi.fn(),
}));

type LoaderLike = {
  onAbort?: () => void;
};

vi.mock("@mariozechner/pi-ai", () => ({
  complete: completeMock,
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  BorderedLoader: class MockBorderedLoader {
    signal = new AbortController().signal;
    onAbort?: () => void;

    constructor(_tui: unknown, _theme: unknown, _label: string) {}
  },
}));

import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { generateDraftWithLoader, type HandoffContext } from "../pi-extensions/handoff.js";

function buildContext(): HandoffContext {
  return {
    goal: "goal",
    conversationText: "conversation",
    relevantFiles: ["pi-extensions/handoff.ts"],
    toolCalls: [{ name: "Bash", summary: "`pnpm run typecheck`" }],
  };
}

function buildCtx(customImpl?: (loader: LoaderLike) => void): ExtensionCommandContext {
  return {
    model: "test-model",
    modelRegistry: {
      getApiKey: vi.fn().mockResolvedValue(undefined),
    },
    ui: {
      custom: vi.fn().mockImplementation(
        async (
          render: (
            tui: unknown,
            theme: unknown,
            kb: unknown,
            done: (value: unknown) => void,
          ) => LoaderLike,
        ) =>
          await new Promise((resolve) => {
            const loader = render({}, {}, {}, resolve);
            customImpl?.(loader);
          }),
      ),
    },
  } as unknown as ExtensionCommandContext;
}

describe("generateDraftWithLoader", () => {
  beforeEach(() => {
    completeMock.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("works without an API key and sends only signal in options", async () => {
    completeMock.mockResolvedValue({
      stopReason: "completed",
      content: [{ type: "text", text: "draft" }],
    });

    const result = await generateDraftWithLoader(buildContext(), buildCtx());

    expect(result).toEqual({ status: "ok", draft: "draft" });
    const options = completeMock.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect("apiKey" in options).toBe(false);
  });

  it("returns error status when model generation throws", async () => {
    completeMock.mockRejectedValue(new Error("boom"));

    const result = await generateDraftWithLoader(buildContext(), buildCtx());

    expect(result).toEqual({ status: "error", message: "boom" });
  });

  it("returns cancelled when abort fires before generation completes", async () => {
    completeMock.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return {
        stopReason: "completed",
        content: [{ type: "text", text: "late draft" }],
      };
    });

    const result = await generateDraftWithLoader(
      buildContext(),
      buildCtx((loader) => loader.onAbort?.()),
    );

    expect(result).toEqual({ status: "cancelled" });
  });
});
