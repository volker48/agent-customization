import { spawn } from "node:child_process";

import { describe, expect, it } from "vitest";

import rtkExtension from "../pi-extensions/rtk.js";

type ExecResult = {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
};

type ToolCallHandler = (event: any, ctx: { signal?: AbortSignal }) => Promise<unknown>;

function execLikePi(command: string, args: string[], options?: { signal?: AbortSignal; timeout?: number }) {
  return new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const timeoutId =
      options?.timeout !== undefined
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
          }, options.timeout)
        : undefined;

    const abortListener = () => {
      child.kill("SIGTERM");
    };

    options?.signal?.addEventListener("abort", abortListener, { once: true });

    child.on("error", (error) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      options?.signal?.removeEventListener("abort", abortListener);
      reject(error);
    });

    child.on("close", (code, signal) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      options?.signal?.removeEventListener("abort", abortListener);

      resolve({
        stdout,
        stderr,
        code: timedOut ? 124 : (code ?? 1),
        killed: signal !== null,
      });
    });
  });
}

function createMockPi() {
  const handlers = new Map<string, Function[]>();

  const pi = {
    on(eventName: string, handler: Function) {
      handlers.set(eventName, [...(handlers.get(eventName) ?? []), handler]);
    },
    registerFlag() {
      // not needed for e2e coverage
    },
    getFlag() {
      return undefined;
    },
    exec: execLikePi,
  };

  return {
    pi,
    getToolCallHandler(): ToolCallHandler {
      const handler = handlers.get("tool_call")?.[0];
      if (!handler) {
        throw new Error("tool_call handler was not registered");
      }
      return handler as ToolCallHandler;
    },
  };
}

const runE2E = process.env.RTK_E2E === "1";
const describeIf = runE2E ? describe : describe.skip;

describeIf("rtk extension e2e", () => {
  it("rewrites git status with the real rtk binary", async () => {
    const { pi, getToolCallHandler } = createMockPi();
    rtkExtension(pi as never);

    const event = {
      toolName: "bash",
      input: {
        command: "git status",
      },
    };

    await getToolCallHandler()(event, { signal: new AbortController().signal });

    expect(event.input.command).not.toBe("git status");
    expect(event.input.command.startsWith("rtk ")).toBe(true);
  });

  it("leaves unsupported commands unchanged with the real rtk binary", async () => {
    const { pi, getToolCallHandler } = createMockPi();
    rtkExtension(pi as never);

    const event = {
      toolName: "bash",
      input: {
        command: "printf hello",
      },
    };

    await getToolCallHandler()(event, { signal: new AbortController().signal });

    expect(event.input.command).toBe("printf hello");
  });
});
