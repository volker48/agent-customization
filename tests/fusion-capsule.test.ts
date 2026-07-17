import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  generateCapsule,
  saveCapsule,
  type Capsule,
} from "../pi-extensions/lib/context-capsule.js";
import { parseFusionArgs } from "../pi-extensions/fusion/args.js";

vi.mock("../pi-extensions/fusion/config.js", () => ({
  loadFusionConfig: vi.fn(async () => ({
    judge: "judge/model",
    models: ["panel/model"],
    maxToolCalls: 0,
  })),
}));
vi.mock("../pi-extensions/fusion/orchestrator.js", () => ({
  runFusion: vi.fn(async (args) => ({
    status: "degraded",
    prompt: args.prompt,
    displayPrompt: args.displayPrompt,
    capsule: args.capsule,
    judge: "judge/model",
    responses: [
      {
        model: "panel/model",
        runId: "run-1",
        status: "ok",
        content: "panel answer",
        elapsedMs: 1,
        toolCalls: [],
      },
    ],
    elapsedMs: 2,
  })),
}));

const {
  default: fusionExtension,
  FusionInputError,
  resolvePrompt,
} = await import("../pi-extensions/fusion/index.js");

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
  vi.clearAllMocks();
});

async function capsule(cwd: string): Promise<Capsule> {
  const result = await generateCapsule(
    {
      objective: "Review the bounded implementation",
      constraints: ["Keep the inner tool boundary"],
      decisions: [],
      resources: [],
      observedChanges: [],
      validation: [],
      blockers: [],
      risks: [],
      nextAction: "Compare the alternatives",
      exclusions: [],
    },
    { sessionId: "session-1", cwd, capsuleId: "capsule-93", now: () => new Date("2026-01-01") },
  );
  if ("error" in result) throw new Error(result.error.message);
  return result.value;
}

describe("Fusion Context Capsule input", () => {
  it("generates the current capsule and previews the complete capsule plus task before confirmation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "fusion-capsule-current-"));
    temporaryDirectories.push(cwd);
    const notify = vi.fn();
    const confirm = vi.fn(async () => true);
    const resolved = await resolvePrompt(
      parseFusionArgs("--capsule current focus on risks"),
      {
        cwd,
        waitForIdle: vi.fn(async () => undefined),
        sessionManager: {
          getBranch: () => [
            {
              type: "message",
              message: { role: "user", content: "Review the bounded implementation" },
            },
          ],
          getSessionId: () => "session-current",
          getSessionFile: () => undefined,
        },
        ui: { notify, confirm },
      },
      new AbortController().signal,
    );

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toContain("# Context Capsule");
    expect(notify.mock.calls[0]?.[0]).toContain("focus on risks");
    expect(resolved.prompt).toContain("BEGIN UNTRUSTED CONTEXT CAPSULE");
    expect(resolved.prompt).toContain("Additional task text:\nfocus on risks");
    expect(resolved.capsule?.source.sessionId).toBe("session-current");
  });

  it("loads a saved capsule and supports an omitted task", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "fusion-capsule-saved-"));
    temporaryDirectories.push(cwd);
    const saved = await saveCapsule(await capsule(cwd), { rootDir: cwd });
    if ("error" in saved) throw new Error(saved.error.message);
    const resolved = await resolvePrompt(
      parseFusionArgs(`--capsule ${saved.value}`),
      { cwd, ui: { notify: vi.fn(), confirm: vi.fn(async () => true) } },
      new AbortController().signal,
    );

    expect(resolved.displayPrompt).toContain("Context Capsule");
    expect(resolved.prompt).toContain('"capsuleId":"capsule-93"');
    expect(resolved.prompt).not.toContain("Additional task text:");
  });

  it("returns typed invalid and cancellation paths before model work", async () => {
    await expect(
      resolvePrompt(
        parseFusionArgs("--capsule /missing/capsule.json"),
        { ui: { notify: vi.fn(), confirm: vi.fn(async () => true) } },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "invalid-capsule", capsuleErrorCode: "not-found" });

    const cancelled = resolvePrompt(
      parseFusionArgs("--capsule current task"),
      {
        cwd: "/tmp",
        waitForIdle: vi.fn(async () => undefined),
        sessionManager: {
          getBranch: () => [],
          getSessionId: () => "session-current",
          getSessionFile: () => undefined,
        },
        ui: { notify: vi.fn(), confirm: vi.fn(async () => false) },
      },
      new AbortController().signal,
    );
    await expect(cancelled).rejects.toMatchObject({ code: "cancelled" });
  });

  it("keeps degraded panel analysis and calling-model synthesis after capsule confirmation", async () => {
    let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
    const sendMessage = vi.fn();
    const pi = {
      registerMessageRenderer: vi.fn(),
      registerCommand: vi.fn((_name: string, command: { handler: typeof handler }) => {
        handler = command.handler;
      }),
      sendMessage,
    };
    const cwd = await mkdtemp(join(tmpdir(), "fusion-capsule-command-"));
    temporaryDirectories.push(cwd);
    const saved = await saveCapsule(await capsule(cwd), { rootDir: cwd });
    if ("error" in saved) throw new Error(saved.error.message);

    fusionExtension(pi as any);
    await handler?.(`--capsule ${saved.value} focused task`, {
      cwd,
      model: { id: "calling/model" },
      modelRegistry: {},
      ui: {
        notify: vi.fn(),
        confirm: vi.fn(async () => true),
        setStatus: vi.fn(),
        setWidget: vi.fn(),
      },
    });

    const message = sendMessage.mock.calls[0]?.[0];
    expect(message.details.capsuleRevision).toBe("capsule-93@1");
    expect(message.details.prompt).toBe("focused task");
    expect(message.details.prompt).not.toContain("BEGIN UNTRUSTED CONTEXT CAPSULE");
    expect(message.details.status).toBe("degraded");
    expect(message.content).toContain("panel answer");
    expect(message.content).toContain("focused task");
  });
});
