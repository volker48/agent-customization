import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ActorLease } from "../pi-extensions/headlong/lease.js";
import {
  HeadlongStore,
  createInitialActorState,
  readOperationalEvents,
} from "../pi-extensions/headlong/store.js";
import { runPiRpcChild, runSupervisorWake } from "../pi-extensions/headlong/supervisor.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Headlong fault-path hardening", () => {
  it("does not mutate actor state or remove a replacement lease after child ownership is lost", async () => {
    const root = await mkdtemp(join(tmpdir(), "headlong-supervisor-replacement-lease-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const store = new HeadlongStore({ stateRoot: join(root, "state"), workspace });
    const initial = createInitialActorState({
      workspace,
      sessionFile: join(root, "session.jsonl"),
      sessionId: "session-1",
      now: 1_000,
    });
    await store.writeState({ ...initial, status: "sleeping", wakeAt: initial.updatedAt });

    let replacement: ActorLease | undefined;
    const result = await runSupervisorWake({
      store,
      extensionPath: join(root, "headlong.ts"),
      now: () => 2_000,
      leaseProcessIdentity: "original-supervisor",
      isLeaseOwnerLive: async (owner) => owner.processIdentity === "replacement-supervisor",
      runChild: async (request) => {
        const child = await ActorLease.acquire({
          store,
          role: "live-extension",
          processIdentity: "exited-child",
          adoptToken: request.leaseToken,
        });
        expect(child).toBeDefined();

        await rename(store.leasePath, `${store.leasePath}.former-owner`);
        replacement = await ActorLease.acquire({
          store,
          role: "supervisor",
          processIdentity: "replacement-supervisor",
        });
        expect(replacement).toBeDefined();
        return { settled: true, timedOut: false, exitCode: 0 };
      },
    });

    expect(result).toMatchObject({
      kind: "failed-closed",
      reason: expect.stringContaining("reclaim lease ownership"),
    });
    await expect(store.readState()).resolves.toMatchObject({
      status: "running",
      activeWakeId: expect.stringMatching(/^wake-1-/),
      lastTransitionWakeId: null,
    });
    await expect(replacement?.assertOwned()).resolves.toBeUndefined();
    await replacement?.release();
  });

  it("does not steal an expired event lock from a live writer", async () => {
    const root = await mkdtemp(join(tmpdir(), "headlong-event-live-lock-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const stateRoot = join(root, "state");
    let entered!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const releaseLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstStore = new HeadlongStore({
      stateRoot,
      workspace,
      eventLockNow: () => 0,
      eventLockStaleAfterMs: 1,
      beforeEventAppend: async () => {
        entered();
        await releaseLock;
      },
    });
    const contenderStore = new HeadlongStore({
      stateRoot,
      workspace,
      eventLockNow: () => 100_000,
      eventLockStaleAfterMs: 1,
      eventLockTimeoutMs: 100,
    });

    const firstAppend = firstStore.appendEvent({
      at: new Date(0).toISOString(),
      type: "writer.one",
    });
    await lockHeld;
    await expect(
      contenderStore.appendEvent({
        at: new Date(1).toISOString(),
        type: "writer.two",
      }),
    ).rejects.toThrow(/Timed out acquiring Headlong event append lock/);

    release();
    await firstAppend;
    await contenderStore.appendEvent({
      at: new Date(2).toISOString(),
      type: "writer.two",
    });
    await expect(
      readFile(firstStore.eventsPath, "utf8").then(readOperationalEvents),
    ).resolves.toEqual([
      expect.objectContaining({ sequence: 1, type: "writer.one" }),
      expect.objectContaining({ sequence: 2, type: "writer.two" }),
    ]);
  });

  it("uses a bounded tail read to allocate the next operational event sequence", async () => {
    const root = await mkdtemp(join(tmpdir(), "headlong-event-bounded-tail-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const bytesRead: number[] = [];
    const store = new HeadlongStore({
      stateRoot: join(root, "state"),
      workspace,
      onEventTailRead: (bytes) => bytesRead.push(bytes),
    });
    await store.ensureDirectory();
    const at = new Date(0).toISOString();
    const existingCount = 8_000;
    const records = Array.from({ length: existingCount }, (_, index) =>
      JSON.stringify({
        version: 1,
        sequence: index + 1,
        at,
        type: "seed",
        actorId: store.actorId,
        detail: { padding: "x".repeat(64) },
      }),
    ).join("\n");
    await writeFile(store.eventsPath, `${records}\n`, { mode: 0o600 });
    const beforeSize = (await readFile(store.eventsPath)).byteLength;

    await store.appendEvent({ at, type: "bounded.append" });

    expect(bytesRead).toHaveLength(1);
    expect(bytesRead[0]).toBeLessThanOrEqual(256 * 1024);
    expect(bytesRead[0]).toBeLessThan(beforeSize);
    const events = readOperationalEvents(await readFile(store.eventsPath, "utf8"));
    expect(events.at(-1)).toMatchObject({
      sequence: existingCount + 1,
      type: "bounded.append",
    });
  });

  it("fails closed instead of guessing ownership for a malformed event lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "headlong-event-corrupt-lock-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const store = new HeadlongStore({ stateRoot: join(root, "state"), workspace });
    await store.ensureDirectory();
    await writeFile(store.eventLockPath, "{}\n", { mode: 0o600 });

    await expect(
      store.appendEvent({ at: new Date(0).toISOString(), type: "must-not-append" }),
    ).rejects.toThrow(/Invalid Headlong event append lock owner/);
    await expect(readFile(store.eventLockPath, "utf8")).resolves.toBe("{}\n");
  });

  it("observes an abort that lands before the RPC child is spawned", async () => {
    const root = await mkdtemp(join(tmpdir(), "headlong-rpc-pre-spawn-abort-"));
    roots.push(root);
    const controller = new AbortController();

    await expect(
      runPiRpcChild(
        {
          wakeId: "wake-aborted",
          leaseToken: "lease-token",
          sessionFile: join(root, "session.jsonl"),
          workspace: root,
          extensionPath: join(root, "headlong.ts"),
          stateRoot: join(root, "state"),
          prompt: "wake",
          timeoutMs: 1_000,
          signal: controller.signal,
        },
        {
          command: "definitely-not-a-real-command",
          beforeSpawn: () => controller.abort(),
        },
      ),
    ).resolves.toEqual({ settled: false, timedOut: false, aborted: true });
  });
});
