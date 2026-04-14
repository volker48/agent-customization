import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import rtkExtension from "../pi-extensions/rtk.js";

type ToolCallHandler = (event: any, ctx: { signal?: AbortSignal }) => Promise<unknown>;
type ToolResultHandler = (event: any, ctx: unknown) => Promise<any>;
type SessionStartHandler = (event: any, ctx: unknown) => Promise<unknown>;

function createMockPi() {
  const handlers = new Map<string, Function[]>();
  const flags = new Map<string, string | boolean | undefined>();
  const registeredFlags = new Map<string, { description: string; type: string }>();

  const pi = {
    on(eventName: string, handler: Function) {
      handlers.set(eventName, [...(handlers.get(eventName) ?? []), handler]);
    },
    registerFlag(name: string, definition: { description: string; type: string }) {
      registeredFlags.set(name, definition);
    },
    getFlag(name: string) {
      return flags.get(name);
    },
    exec: vi.fn(),
  };

  return {
    pi,
    setFlag(name: string, value: string | boolean | undefined) {
      flags.set(name, value);
    },
    getToolCallHandler(): ToolCallHandler {
      const handler = handlers.get("tool_call")?.[0];
      if (!handler) {
        throw new Error("tool_call handler was not registered");
      }
      return handler as ToolCallHandler;
    },
    getSessionStartHandler(): SessionStartHandler {
      const handler = handlers.get("session_start")?.[0];
      if (!handler) {
        throw new Error("session_start handler was not registered");
      }
      return handler as SessionStartHandler;
    },
    getToolResultHandler(): ToolResultHandler {
      const handler = handlers.get("tool_result")?.[0];
      if (!handler) {
        throw new Error("tool_result handler was not registered");
      }
      return handler as ToolResultHandler;
    },
    registeredFlags,
  };
}

describe("rtk extension", () => {
  const originalRtkBin = process.env.PI_RTK_BIN;
  const originalRtkDebug = process.env.PI_RTK_DEBUG;

  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PI_RTK_BIN;
    delete process.env.PI_RTK_DEBUG;
  });

  afterEach(() => {
    vi.restoreAllMocks();

    if (originalRtkBin === undefined) {
      delete process.env.PI_RTK_BIN;
    } else {
      process.env.PI_RTK_BIN = originalRtkBin;
    }

    if (originalRtkDebug === undefined) {
      delete process.env.PI_RTK_DEBUG;
    } else {
      process.env.PI_RTK_DEBUG = originalRtkDebug;
    }
  });

  it("registers the rtk-bin flag and tool_call handler", () => {
    const {
      pi,
      registeredFlags,
      getToolCallHandler,
      getSessionStartHandler,
      getToolResultHandler,
    } = createMockPi();

    rtkExtension(pi as never);

    expect(registeredFlags.get("rtk-bin")).toEqual({
      description: "Path to the rtk binary used to rewrite bash commands",
      type: "string",
    });
    expect(getToolCallHandler()).toBeTypeOf("function");
    expect(getSessionStartHandler()).toBeTypeOf("function");
    expect(getToolResultHandler()).toBeTypeOf("function");
  });

  it("rewrites bash commands when rtk rewrite succeeds", async () => {
    const { pi, getToolCallHandler } = createMockPi();
    pi.exec.mockResolvedValue({
      stdout: "rtk git status\n",
      stderr: "No hook installed\n",
      code: 0,
      killed: false,
    });

    rtkExtension(pi as never);

    const event = {
      toolName: "bash",
      input: {
        command: "git status",
        timeout: 15,
      },
    };
    const controller = new AbortController();

    await getToolCallHandler()(event, { signal: controller.signal });

    expect(event.input.command).toBe("rtk git status");
    expect(event.input.timeout).toBe(15);
    expect(pi.exec).toHaveBeenCalledWith(
      "rtk",
      ["rewrite", "git status"],
      expect.objectContaining({
        signal: controller.signal,
        timeout: 2_000,
      }),
    );
  });

  it("does nothing for non-bash tool calls", async () => {
    const { pi, getToolCallHandler } = createMockPi();
    pi.exec.mockResolvedValue({ stdout: "ignored", stderr: "", code: 0, killed: false });

    rtkExtension(pi as never);

    const event = {
      toolName: "read",
      input: {
        path: "package.json",
      },
    };

    await getToolCallHandler()(event, {});

    expect(pi.exec).not.toHaveBeenCalled();
  });

  it("does nothing when rtk rewrite exits non-zero", async () => {
    const { pi, getToolCallHandler } = createMockPi();
    pi.exec.mockResolvedValue({ stdout: "", stderr: "unsupported", code: 1, killed: false });

    rtkExtension(pi as never);

    const event = {
      toolName: "bash",
      input: {
        command: "printf hello",
      },
    };

    await getToolCallHandler()(event, {});

    expect(event.input.command).toBe("printf hello");
  });

  it("does nothing when rtk returns the same command", async () => {
    const { pi, getToolCallHandler } = createMockPi();
    pi.exec.mockResolvedValue({ stdout: "git status\n", stderr: "", code: 0, killed: false });

    rtkExtension(pi as never);

    const event = {
      toolName: "bash",
      input: {
        command: "git status",
      },
    };

    await getToolCallHandler()(event, {});

    expect(event.input.command).toBe("git status");
  });

  it("does nothing when rtk returns empty stdout", async () => {
    const { pi, getToolCallHandler } = createMockPi();
    pi.exec.mockResolvedValue({ stdout: "   \n", stderr: "", code: 0, killed: false });

    rtkExtension(pi as never);

    const event = {
      toolName: "bash",
      input: {
        command: "git status",
      },
    };

    await getToolCallHandler()(event, {});

    expect(event.input.command).toBe("git status");
  });

  it("passes the full bash command as a single rewrite argument", async () => {
    const { pi, getToolCallHandler } = createMockPi();
    pi.exec.mockResolvedValue({ stdout: "", stderr: "", code: 1, killed: false });

    rtkExtension(pi as never);

    const originalCommand = [
      "printf '%s\\n' \"hello && goodbye\"",
      "echo done | sed 's/done/fixed/' && cat package.json",
    ].join("\n");

    const event = {
      toolName: "bash",
      input: {
        command: originalCommand,
      },
    };

    await getToolCallHandler()(event, {});

    expect(pi.exec).toHaveBeenCalledWith(
      "rtk",
      ["rewrite", originalCommand],
      expect.objectContaining({ timeout: 2_000 }),
    );
  });

  it("does nothing when the rtk binary is missing", async () => {
    const { pi, getToolCallHandler } = createMockPi();
    pi.exec.mockRejectedValue(new Error("spawn rtk ENOENT"));

    rtkExtension(pi as never);

    const event = {
      toolName: "bash",
      input: {
        command: "git status",
      },
    };

    await getToolCallHandler()(event, {});

    expect(event.input.command).toBe("git status");
  });

  it("uses PI_RTK_BIN when provided", async () => {
    process.env.PI_RTK_BIN = "/opt/homebrew/bin/rtk";

    const { pi, getToolCallHandler } = createMockPi();
    pi.exec.mockResolvedValue({ stdout: "", stderr: "", code: 1, killed: false });

    rtkExtension(pi as never);

    const event = {
      toolName: "bash",
      input: {
        command: "git status",
      },
    };

    await getToolCallHandler()(event, {});

    expect(pi.exec).toHaveBeenCalledWith(
      "/opt/homebrew/bin/rtk",
      ["rewrite", "git status"],
      expect.any(Object),
    );
  });

  it("annotates bash tool results with rewrite metadata", async () => {
    const { pi, getToolCallHandler, getToolResultHandler } = createMockPi();
    pi.exec.mockResolvedValue({
      stdout: "rtk git status\n",
      stderr: "",
      code: 0,
      killed: false,
    });

    rtkExtension(pi as never);

    await getToolCallHandler()(
      {
        toolCallId: "call_1",
        toolName: "bash",
        input: {
          command: "git status",
        },
      },
      {},
    );

    const resultPatch = await getToolResultHandler()(
      {
        toolCallId: "call_1",
        toolName: "bash",
        details: {
          existing: true,
        },
      },
      {},
    );

    expect(resultPatch).toEqual({
      details: {
        existing: true,
        rtkRewrite: {
          originalCommand: "git status",
          rewrittenCommand: "rtk git status",
          rtkBin: "rtk",
        },
      },
    });
  });

  it("prefers the --rtk-bin flag over PI_RTK_BIN", async () => {
    process.env.PI_RTK_BIN = "/env/rtk";

    const { pi, setFlag, getToolCallHandler, getSessionStartHandler } = createMockPi();
    setFlag("rtk-bin", "/flag/rtk");
    pi.exec.mockResolvedValue({ stdout: "", stderr: "", code: 1, killed: false });

    rtkExtension(pi as never);

    await getSessionStartHandler()({}, {});

    const event = {
      toolName: "bash",
      input: {
        command: "git status",
      },
    };

    await getToolCallHandler()(event, {});

    expect(pi.exec).toHaveBeenCalledWith(
      "/flag/rtk",
      ["rewrite", "git status"],
      expect.any(Object),
    );
  });
});
