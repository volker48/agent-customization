import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerHeadlongExtension } from "../pi-extensions/headlong/index.js";
import { ActorLease } from "../pi-extensions/headlong/lease.js";
import {
  HeadlongStore,
  createInitialActorState,
  readOperationalEvents,
} from "../pi-extensions/headlong/store.js";

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function createPi() {
  const handlers = new Map<string, (event: unknown, ctx: MockContext) => unknown>();
  const commands = new Map<string, { handler(args: string, ctx: MockContext): Promise<void> }>();
  const tools = new Map<string, RegisteredTool>();
  const pi = {
    on: vi.fn((event: string, handler: (event: unknown, ctx: MockContext) => unknown) =>
      handlers.set(event, handler),
    ),
    registerCommand: vi.fn(
      (name: string, command: { handler(args: string, ctx: MockContext): Promise<void> }) =>
        commands.set(name, command),
    ),
    registerTool: vi.fn((tool: RegisteredTool) => tools.set(tool.name, tool)),
    sendUserMessage: vi.fn(),
    appendEntry: vi.fn(),
    getActiveTools: vi.fn(() => ["read", "bash"]),
    getAllTools: vi.fn(() => []),
    setActiveTools: vi.fn(),
  };
  return { pi, handlers, commands, tools };
}

type RegisteredTool = {
  name: string;
  executionMode?: string;
  execute(
    id: string,
    params: { [key: string]: unknown },
    signal: AbortSignal | undefined,
    update: unknown,
    ctx: MockContext,
  ): Promise<unknown>;
};

type MockContext = ReturnType<typeof createContext>;

function createContext(root: string) {
  return {
    cwd: join(root, "workspace"),
    isIdle: () => true,
    abort: vi.fn(),
    ui: { notify: vi.fn(), setStatus: vi.fn() },
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionFile: () => join(root, "session.jsonl"),
      getBranch: () => [],
    },
  };
}

describe("Headlong Pi extension", () => {
  it("registers four sequential structured control tools and a visible slash kill switch", async () => {
    const root = await mkdtemp(join(tmpdir(), "headlong-extension-register-"));
    roots.push(root);
    const runtime = createPi();

    registerHeadlongExtension(runtime.pi as never, { stateRoot: join(root, "state") });

    expect([...runtime.tools.keys()].sort()).toEqual([
      "headlong_blocked",
      "headlong_checkpoint",
      "headlong_complete",
      "headlong_sleep",
    ]);
    expect([...runtime.tools.values()].every((tool) => tool.executionMode === "sequential")).toBe(
      true,
    );
    expect(runtime.commands.has("headlong")).toBe(true);
  });

  it("starts one canonical-session actor and dispatches a generation-bound live Pi wake", async () => {
    const root = await mkdtemp(join(tmpdir(), "headlong-extension-start-"));
    roots.push(root);
    const stateRoot = join(root, "state");
    const runtime = createPi();
    const context = createContext(root);
    registerHeadlongExtension(runtime.pi as never, { stateRoot });

    await runtime.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, context);
    await runtime.commands.get("headlong")?.handler("start", context);

    const store = new HeadlongStore({ stateRoot, workspace: context.cwd });
    await vi.waitFor(async () => {
      await expect(store.readState()).resolves.toMatchObject({
        sessionFile: context.sessionManager.getSessionFile(),
        sessionId: "session-1",
        status: "running",
        wakeSequence: 1,
        activeWakeId: expect.stringMatching(/^wake-1-/),
      });
    });
    await vi.waitFor(() =>
      expect(runtime.pi.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining("Pi session tree/JSONL is the canonical conversation trajectory"),
        { deliverAs: "followUp" },
      ),
    );
  });

  it("persists an explicit sleep transition for the active wake and arms durable wake_at", async () => {
    const root = await mkdtemp(join(tmpdir(), "headlong-extension-sleep-"));
    roots.push(root);
    const stateRoot = join(root, "state");
    const runtime = createPi();
    const context = createContext(root);
    const clock = 1_787_680_000_000;
    registerHeadlongExtension(runtime.pi as never, { stateRoot, now: () => clock });
    await runtime.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, context);
    await runtime.commands.get("headlong")?.handler("start", context);
    const store = new HeadlongStore({ stateRoot, workspace: context.cwd });
    let wakeId = "";
    await vi.waitFor(async () => {
      const state = await store.readState();
      expect(state?.activeWakeId).toMatch(/^wake-1-/);
      wakeId = state?.activeWakeId ?? "";
    });

    await runtime.tools
      .get("headlong_sleep")
      ?.execute("tool-1", { reason: "idle", delaySeconds: 5 }, undefined, undefined, context);

    await expect(store.readState()).resolves.toMatchObject({
      status: "sleeping",
      wakeAt: new Date(clock + 5_000).toISOString(),
      activeWakeId: null,
      lastTransitionWakeId: wakeId,
    });
    await runtime.handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, context);
  });

  it("keeps unattended tools restricted until a transitioned turn settles", async () => {
    const root = await mkdtemp(join(tmpdir(), "headlong-extension-transition-cleanup-"));
    roots.push(root);
    const stateRoot = join(root, "state");
    const runtime = createPi();
    const context = createContext(root);
    registerHeadlongExtension(runtime.pi as never, { stateRoot });
    await runtime.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, context);
    await runtime.commands.get("headlong")?.handler("start", context);
    const store = new HeadlongStore({ stateRoot, workspace: context.cwd });
    await vi.waitFor(async () => {
      expect((await store.readState())?.activeWakeId).toMatch(/^wake-1-/);
    });

    await runtime.tools
      .get("headlong_complete")
      ?.execute("tool-complete", { summary: "done" }, undefined, undefined, context);

    expect(context.abort).not.toHaveBeenCalled();
    expect(runtime.pi.setActiveTools).toHaveBeenLastCalledWith([]);
    await runtime.handlers
      .get("agent_settled")
      ?.({ type: "agent_settled", outcome: "done", messages: [] }, context);
    expect(runtime.pi.setActiveTools).toHaveBeenLastCalledWith(["read", "bash"]);
    await expect(store.readState()).resolves.toMatchObject({ status: "completed" });
  });

  it("does not dispatch meaningful input while a transitioned turn is still settling", async () => {
    const root = await mkdtemp(join(tmpdir(), "headlong-extension-transition-input-"));
    roots.push(root);
    const stateRoot = join(root, "state");
    const runtime = createPi();
    const context = createContext(root);
    registerHeadlongExtension(runtime.pi as never, { stateRoot });
    await runtime.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, context);
    await runtime.commands.get("headlong")?.handler("start", context);
    const store = new HeadlongStore({ stateRoot, workspace: context.cwd });
    await vi.waitFor(async () => {
      expect((await store.readState())?.activeWakeId).toMatch(/^wake-1-/);
    });
    await runtime.tools
      .get("headlong_sleep")
      ?.execute("tool-sleep", { reason: "idle", delaySeconds: 5 }, undefined, undefined, context);

    await runtime.handlers.get("input")?.(
      { type: "input", text: "new evidence", source: "interactive" },
      context,
    );

    await expect(store.readState()).resolves.toMatchObject({
      status: "sleeping",
      wakeSequence: 1,
      activeWakeId: null,
    });
  });

  it("clears pending transition cleanup across session shutdown and restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "headlong-extension-transition-restart-"));
    roots.push(root);
    const stateRoot = join(root, "state");
    const runtime = createPi();
    const context = createContext(root);
    registerHeadlongExtension(runtime.pi as never, { stateRoot });
    await runtime.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, context);
    await runtime.commands.get("headlong")?.handler("start", context);
    const store = new HeadlongStore({ stateRoot, workspace: context.cwd });
    await vi.waitFor(async () => {
      expect((await store.readState())?.activeWakeId).toMatch(/^wake-1-/);
    });
    await runtime.tools
      .get("headlong_sleep")
      ?.execute("tool-sleep", { reason: "idle", delaySeconds: 5 }, undefined, undefined, context);

    await runtime.handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "reload" }, context);
    await runtime.handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, context);
    await runtime.handlers.get("input")?.(
      { type: "input", text: "resume with evidence", source: "interactive" },
      context,
    );

    await expect(store.readState()).resolves.toMatchObject({
      status: "running",
      wakeSequence: 2,
      activeWakeId: expect.stringMatching(/^wake-2-/),
    });
  });

  it("turns meaningful interactive input into an immediate wake and resets idle backoff", async () => {
    const root = await mkdtemp(join(tmpdir(), "headlong-extension-input-"));
    roots.push(root);
    const stateRoot = join(root, "state");
    const context = createContext(root);
    const clock = 1_787_680_000_000;
    const store = new HeadlongStore({ stateRoot, workspace: context.cwd });
    const initial = createInitialActorState({
      workspace: context.cwd,
      sessionFile: context.sessionManager.getSessionFile(),
      sessionId: context.sessionManager.getSessionId(),
      now: clock,
    });
    await store.writeState({
      ...initial,
      status: "sleeping",
      wakeAt: new Date(clock + 60_000).toISOString(),
      backoffLevel: 4,
      ticksAtLevel: 2,
      consecutiveFailures: 2,
    });
    const runtime = createPi();
    registerHeadlongExtension(runtime.pi as never, {
      stateRoot,
      now: () => clock,
      setTimer: () => 1,
      clearTimer: vi.fn(),
    });
    await runtime.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, context);

    await runtime.handlers.get("input")?.(
      { type: "input", text: "New evidence is available", source: "interactive" },
      context,
    );

    await expect(store.readState()).resolves.toMatchObject({
      status: "running",
      wakeAt: null,
      activeWakeId: expect.stringMatching(/^wake-1-/),
      backoffLevel: 0,
      ticksAtLevel: 0,
      consecutiveFailures: 0,
    });
    expect(runtime.pi.sendUserMessage).not.toHaveBeenCalled();
    await runtime.handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, context);
  });

  it("serializes simultaneous meaningful inputs into one active wake", async () => {
    const root = await mkdtemp(join(tmpdir(), "headlong-extension-input-race-"));
    roots.push(root);
    const stateRoot = join(root, "state");
    const context = createContext(root);
    const store = new HeadlongStore({ stateRoot, workspace: context.cwd });
    const initial = createInitialActorState({
      workspace: context.cwd,
      sessionFile: context.sessionManager.getSessionFile(),
      sessionId: context.sessionManager.getSessionId(),
    });
    await store.writeState({ ...initial, status: "sleeping", wakeAt: initial.updatedAt });
    const runtime = createPi();
    registerHeadlongExtension(runtime.pi as never, {
      stateRoot,
      setTimer: () => 1,
      clearTimer: vi.fn(),
    });
    await runtime.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, context);
    const input = runtime.handlers.get("input");

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        input?.(
          { type: "input", text: `Meaningful event ${index}`, source: "interactive" },
          context,
        ),
      ),
    );

    await expect(store.readState()).resolves.toMatchObject({ wakeSequence: 1, status: "running" });
    const events = readOperationalEvents(await readFile(store.eventsPath, "utf8"));
    expect(events.filter((event) => event.type === "wake.dispatched")).toHaveLength(1);
    await runtime.handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, context);
  });

  it("fails closed when a dispatched wake settles without an explicit control transition", async () => {
    const root = await mkdtemp(join(tmpdir(), "headlong-extension-settled-"));
    roots.push(root);
    const stateRoot = join(root, "state");
    const runtime = createPi();
    const context = createContext(root);
    registerHeadlongExtension(runtime.pi as never, { stateRoot });
    await runtime.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, context);
    await runtime.commands.get("headlong")?.handler("start", context);
    const store = new HeadlongStore({ stateRoot, workspace: context.cwd });
    await vi.waitFor(async () => {
      expect((await store.readState())?.activeWakeId).toMatch(/^wake-1-/);
    });

    await runtime.handlers
      .get("agent_settled")
      ?.({ type: "agent_settled", outcome: "done", messages: [] }, context);

    await expect(store.readState()).resolves.toMatchObject({
      status: "paused",
      wakeAt: null,
      activeWakeId: null,
      consecutiveFailures: 1,
    });
    expect(runtime.pi.setActiveTools).toHaveBeenLastCalledWith(["read", "bash"]);
    await runtime.handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, context);
  });

  it("aborts the active turn when the visible pause kill switch is used", async () => {
    const root = await mkdtemp(join(tmpdir(), "headlong-extension-pause-"));
    roots.push(root);
    const stateRoot = join(root, "state");
    const runtime = createPi();
    const context = createContext(root);
    registerHeadlongExtension(runtime.pi as never, { stateRoot });
    await runtime.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, context);
    await runtime.commands.get("headlong")?.handler("start", context);
    const store = new HeadlongStore({ stateRoot, workspace: context.cwd });
    await vi.waitFor(async () => expect((await store.readState())?.activeWakeId).toMatch(/^wake-1-/));

    await runtime.commands.get("headlong")?.handler("pause", context);

    expect(context.abort).toHaveBeenCalledTimes(1);
    await expect(store.readState()).resolves.toMatchObject({
      status: "paused",
      activeWakeId: null,
      wakeAt: null,
    });
    expect(runtime.pi.setActiveTools).toHaveBeenLastCalledWith(
      expect.not.arrayContaining(["bash"]),
    );
    await runtime.handlers
      .get("agent_settled")
      ?.({ type: "agent_settled", outcome: "aborted", messages: [] }, context);
    expect(runtime.pi.setActiveTools).toHaveBeenLastCalledWith(["read", "bash"]);
    await runtime.handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, context);
  });

  it("refuses to settle or mutate an active wake after lease ownership changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "headlong-extension-lost-lease-"));
    roots.push(root);
    const stateRoot = join(root, "state");
    const runtime = createPi();
    const context = createContext(root);
    registerHeadlongExtension(runtime.pi as never, { stateRoot });
    await runtime.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, context);
    await runtime.commands.get("headlong")?.handler("start", context);
    const store = new HeadlongStore({ stateRoot, workspace: context.cwd });
    await vi.waitFor(async () => expect((await store.readState())?.activeWakeId).toMatch(/^wake-1-/));
    const ownerPath = join(store.leasePath, "owner.v1.json");
    const owner = JSON.parse(await readFile(ownerPath, "utf8"));
    await writeFile(ownerPath, `${JSON.stringify({ ...owner, token: "replacement-owner" })}\n`);

    await expect(
      runtime.handlers
        .get("agent_settled")
        ?.({ type: "agent_settled", outcome: "done", messages: [] }, context),
    ).rejects.toThrow(/lease is not owned/i);

    await expect(store.readState()).resolves.toMatchObject({
      status: "running",
      activeWakeId: expect.stringMatching(/^wake-1-/),
    });
  });

  it("invalidates a queued wake across shutdown so a stale lifecycle callback cannot inject", async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(join(tmpdir(), "headlong-extension-race-"));
    roots.push(root);
    const runtime = createPi();
    const context = createContext(root);
    const callbacks: Array<() => Promise<void> | void> = [];
    registerHeadlongExtension(runtime.pi as never, {
      stateRoot: join(root, "state"),
      setTimer: (callback: () => Promise<void> | void) => {
        callbacks.push(callback);
        return 1;
      },
      clearTimer: vi.fn(),
    });
    await runtime.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, context);
    await runtime.commands.get("headlong")?.handler("start", context);
    expect(callbacks).toHaveLength(1);

    await runtime.handlers
      .get("session_shutdown")
      ?.({ type: "session_shutdown", reason: "reload" }, context);
    await callbacks[0]?.();

    expect(runtime.pi.sendUserMessage).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("does not resurrect a stale extension when shutdown overtakes lease acquisition", async () => {
    const root = await mkdtemp(join(tmpdir(), "headlong-extension-startup-race-"));
    roots.push(root);
    const stateRoot = join(root, "state");
    const runtime = createPi();
    const context = createContext(root);
    let releaseAcquire!: () => void;
    const acquireGate = new Promise<void>((resolve) => {
      releaseAcquire = resolve;
    });
    const acquireLease = vi.fn(async (options: Parameters<typeof ActorLease.acquire>[0]) => {
      await acquireGate;
      return ActorLease.acquire(options);
    });
    registerHeadlongExtension(runtime.pi as never, { stateRoot, acquireLease });

    const starting = Promise.resolve(
      runtime.handlers
        .get("session_start")
        ?.({ type: "session_start", reason: "startup" }, context),
    );
    await vi.waitFor(() => expect(acquireLease).toHaveBeenCalledTimes(1));
    const shutting = Promise.resolve(
      runtime.handlers
        .get("session_shutdown")
        ?.({ type: "session_shutdown", reason: "reload" }, context),
    );
    releaseAcquire();
    await Promise.all([starting, shutting]);

    const store = new HeadlongStore({ stateRoot, workspace: context.cwd });
    const observer = await ActorLease.acquire({ store, role: "observer" });
    expect(observer).toBeDefined();
    expect(runtime.pi.sendUserMessage).not.toHaveBeenCalled();
    await observer?.release();
  });

  it("invalidates an in-flight meaningful input before shutdown", async () => {
    const root = await mkdtemp(join(tmpdir(), "headlong-extension-input-shutdown-"));
    roots.push(root);
    const stateRoot = join(root, "state");
    const context = createContext(root);
    const store = new HeadlongStore({ stateRoot, workspace: context.cwd });
    const initial = createInitialActorState({
      workspace: context.cwd,
      sessionFile: context.sessionManager.getSessionFile(),
      sessionId: context.sessionManager.getSessionId(),
    });
    await store.writeState({ ...initial, status: "sleeping", wakeAt: initial.updatedAt });
    let releasePublication!: () => void;
    const publicationGate = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    const beforeWakeStateWrite = vi.fn(() => publicationGate);
    const runtime = createPi();
    registerHeadlongExtension(runtime.pi as never, {
      stateRoot,
      setTimer: () => 1,
      clearTimer: vi.fn(),
      beforeWakeStateWrite,
    });
    await runtime.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, context);

    const input = Promise.resolve(
      runtime.handlers.get("input")?.(
        { type: "input", text: "new event", source: "interactive" },
        context,
      ),
    );
    await vi.waitFor(() => expect(beforeWakeStateWrite).toHaveBeenCalledTimes(1));
    const shutdown = Promise.resolve(
      runtime.handlers
        .get("session_shutdown")
        ?.({ type: "session_shutdown", reason: "reload" }, context),
    );
    releasePublication();
    await Promise.all([input, shutdown]);

    await expect(store.readState()).resolves.toMatchObject({ status: "sleeping", activeWakeId: null });
    const rawEvents = await readFile(store.eventsPath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const events = readOperationalEvents(rawEvents);
    expect(events.filter((event) => event.type === "wake.dispatched")).toHaveLength(0);
  });

  it("invalidates an in-flight wake publication before shutdown releases the lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "headlong-extension-shutdown-race-"));
    roots.push(root);
    const stateRoot = join(root, "state");
    const runtime = createPi();
    const context = createContext(root);
    const callbacks: Array<() => Promise<void> | void> = [];
    let releasePublication!: () => void;
    const publicationGate = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    const beforeWakeStateWrite = vi.fn(() => publicationGate);
    registerHeadlongExtension(runtime.pi as never, {
      stateRoot,
      setTimer: (callback: () => Promise<void> | void) => {
        callbacks.push(callback);
        return 1;
      },
      clearTimer: vi.fn(),
      beforeWakeStateWrite,
    });
    await runtime.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, context);
    await runtime.commands.get("headlong")?.handler("start", context);
    const dispatch = Promise.resolve(callbacks[0]?.());
    await vi.waitFor(() => expect(beforeWakeStateWrite).toHaveBeenCalledTimes(1));

    const shutdown = Promise.resolve(
      runtime.handlers
        .get("session_shutdown")
        ?.({ type: "session_shutdown", reason: "reload" }, context),
    );
    releasePublication();
    await Promise.all([dispatch, shutdown]);

    const store = new HeadlongStore({ stateRoot, workspace: context.cwd });
    await expect(store.readState()).resolves.toMatchObject({ status: "sleeping", activeWakeId: null });
    expect(runtime.pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("aborts and pauses a wake that exceeds the configured turn budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "headlong-extension-budget-"));
    roots.push(root);
    const stateRoot = join(root, "state");
    const runtime = createPi();
    const context = createContext(root);
    registerHeadlongExtension(runtime.pi as never, { stateRoot, maxTurnsPerWake: 1 });
    await runtime.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, context);
    await runtime.commands.get("headlong")?.handler("start", context);
    const store = new HeadlongStore({ stateRoot, workspace: context.cwd });
    await vi.waitFor(async () => expect((await store.readState())?.activeWakeId).toMatch(/^wake-1-/));

    await runtime.handlers.get("turn_start")?.({ type: "turn_start" }, context);
    await runtime.handlers.get("turn_start")?.({ type: "turn_start" }, context);

    expect(context.abort).toHaveBeenCalledTimes(1);
    await expect(store.readState()).resolves.toMatchObject({ status: "paused", activeWakeId: null });
    await runtime.handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, context);
  });

  it("aborts and pauses a hung live wake when its wall-clock deadline fires", async () => {
    const root = await mkdtemp(join(tmpdir(), "headlong-extension-deadline-"));
    roots.push(root);
    const stateRoot = join(root, "state");
    const context = createContext(root);
    const store = new HeadlongStore({ stateRoot, workspace: context.cwd });
    const initial = createInitialActorState({
      workspace: context.cwd,
      sessionFile: context.sessionManager.getSessionFile(),
      sessionId: context.sessionManager.getSessionId(),
      now: 1_787_680_000_000,
    });
    await store.writeState({
      ...initial,
      status: "sleeping",
      wakeAt: new Date(1_787_680_060_000).toISOString(),
    });
    const runtime = createPi();
    let deadline: (() => Promise<void> | void) | undefined;
    const setDeadlineTimer = vi.fn((callback: () => Promise<void> | void) => {
      deadline = callback;
      return 2;
    });
    registerHeadlongExtension(runtime.pi as never, {
      stateRoot,
      now: () => 1_787_680_000_000,
      maxWakeMs: 100,
      setTimer: () => 1,
      clearTimer: vi.fn(),
      setDeadlineTimer,
      clearDeadlineTimer: vi.fn(),
    });
    await runtime.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, context);
    await runtime.handlers.get("input")?.(
      { type: "input", text: "Start now", source: "interactive" },
      context,
    );

    expect(setDeadlineTimer).toHaveBeenCalledWith(expect.any(Function), 100);
    await deadline?.();

    expect(context.abort).toHaveBeenCalledTimes(1);
    await expect(store.readState()).resolves.toMatchObject({
      status: "paused",
      activeWakeId: null,
      consecutiveFailures: 1,
    });
    const events = readOperationalEvents(await readFile(store.eventsPath, "utf8"));
    expect(events.at(-1)).toMatchObject({ type: "wake.budget_exceeded" });
    expect(runtime.pi.setActiveTools).toHaveBeenLastCalledWith(
      expect.not.arrayContaining(["bash"]),
    );
    await runtime.handlers
      .get("agent_settled")
      ?.({ type: "agent_settled", outcome: "aborted", messages: [] }, context);
    expect(runtime.pi.setActiveTools).toHaveBeenLastCalledWith(["read", "bash"]);
    await runtime.handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, context);
  });

  it.each(["start", "resume"] as const)(
    "keeps a stopped actor terminal when /headlong %s is requested",
    async (action) => {
      const root = await mkdtemp(join(tmpdir(), `headlong-extension-terminal-${action}-`));
      roots.push(root);
      const stateRoot = join(root, "state");
      const context = createContext(root);
      const store = new HeadlongStore({ stateRoot, workspace: context.cwd });
      const initial = createInitialActorState({
        workspace: context.cwd,
        sessionFile: context.sessionManager.getSessionFile(),
        sessionId: context.sessionManager.getSessionId(),
        now: 1_787_680_000_000,
      });
      await store.writeState({ ...initial, status: "stopped" });
      const runtime = createPi();
      const setTimer = vi.fn(() => 1);
      registerHeadlongExtension(runtime.pi as never, { stateRoot, setTimer });
      await runtime.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, context);

      await runtime.commands.get("headlong")?.handler(action, context);

      await expect(store.readState()).resolves.toMatchObject({ status: "stopped", wakeAt: null });
      expect(setTimer).not.toHaveBeenCalled();
      expect(context.ui.notify).toHaveBeenCalledWith(expect.stringContaining("terminal"), "warning");
      await runtime.handlers.get("session_shutdown")?.(
        { type: "session_shutdown", reason: "quit" },
        context,
      );
    },
  );

  it("rejects a different live Pi session instead of splitting the canonical trajectory", async () => {
    const root = await mkdtemp(join(tmpdir(), "headlong-extension-session-mismatch-"));
    roots.push(root);
    const stateRoot = join(root, "state");
    const context = createContext(root);
    const store = new HeadlongStore({ stateRoot, workspace: context.cwd });
    const initial = createInitialActorState({
      workspace: context.cwd,
      sessionFile: join(root, "old-session.jsonl"),
      sessionId: "old-session",
      now: 1_787_680_000_000,
    });
    await store.writeState({
      ...initial,
      status: "sleeping",
      wakeAt: new Date(1_787_680_000_000).toISOString(),
    });
    context.sessionManager.getSessionId = () => "new-session";
    context.sessionManager.getSessionFile = () => join(root, "new-session.jsonl");
    const runtime = createPi();
    const setTimer = vi.fn(() => 1);
    registerHeadlongExtension(runtime.pi as never, { stateRoot, setTimer });

    await runtime.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, context);

    expect(setTimer).not.toHaveBeenCalled();
    expect(runtime.pi.sendUserMessage).not.toHaveBeenCalled();
    expect(context.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("canonical Pi session"),
      "error",
    );
    const observer = await ActorLease.acquire({ store, role: "observer" });
    expect(observer).toBeDefined();
    await observer?.release();
  });

  it("adopts a supervisor wake token without self-scheduling another overlapping wake", async () => {
    const root = await mkdtemp(join(tmpdir(), "headlong-extension-supervisor-"));
    roots.push(root);
    const stateRoot = join(root, "state");
    const context = createContext(root);
    const store = new HeadlongStore({ stateRoot, workspace: context.cwd });
    const initial = createInitialActorState({
      workspace: context.cwd,
      sessionFile: context.sessionManager.getSessionFile(),
      sessionId: context.sessionManager.getSessionId(),
      now: 1_787_680_000_000,
    });
    await store.writeState({
      ...initial,
      status: "running",
      activeWakeId: "wake-supervised",
      wakeStartedAt: initial.updatedAt,
      wakeSequence: 1,
    });
    const supervisor = await ActorLease.acquire({ store, role: "supervisor" });
    const callbacks: Array<() => void | Promise<void>> = [];
    const runtime = createPi();
    vi.stubEnv("PI_HEADLONG_TOOLS", "read,bash,external_message");
    runtime.pi.getAllTools.mockReturnValue(
      [
        "read",
        "bash",
        "external_message",
        "headlong_checkpoint",
        "headlong_sleep",
        "headlong_complete",
        "headlong_blocked",
      ].map((name) => ({ name })),
    );
    registerHeadlongExtension(runtime.pi as never, {
      stateRoot,
      leaseToken: supervisor?.owner.token,
      supervisorWakeId: "wake-supervised",
      setTimer: (callback: () => void | Promise<void>) => {
        callbacks.push(callback);
        return callbacks.length;
      },
      clearTimer: vi.fn(),
    });
    await runtime.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, context);
    expect(runtime.pi.setActiveTools).toHaveBeenCalledWith([
      "read",
      "headlong_checkpoint",
      "headlong_sleep",
      "headlong_complete",
      "headlong_blocked",
    ]);

    await runtime.tools
      .get("headlong_checkpoint")
      ?.execute("tool", { note: "progress" }, undefined, undefined, context);

    expect(callbacks).toHaveLength(0);
    await expect(store.readState()).resolves.toMatchObject({
      status: "sleeping",
      activeWakeId: null,
      lastTransitionWakeId: "wake-supervised",
    });
    await runtime.handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, context);
    await supervisor?.release();
  });
});
