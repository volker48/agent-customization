import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HeadlongStore,
  createInitialActorState,
  parseActorState,
  readOperationalEvents,
  workspaceActorId,
} from "../pi-extensions/headlong/store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "headlong-state-"));
  roots.push(root);
  return root;
}

describe("Headlong durable actor store", () => {
  it("maps symlink aliases of one physical workspace to one actor identity", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    const alias = join(root, "workspace-alias");
    await mkdir(workspace);
    await symlink(workspace, alias);

    const direct = new HeadlongStore({ stateRoot: join(root, "state"), workspace });
    const throughAlias = new HeadlongStore({ stateRoot: join(root, "state"), workspace: alias });

    expect(throughAlias.actorId).toBe(direct.actorId);
    expect(throughAlias.workspace).toBe(direct.workspace);
    expect(workspaceActorId(alias)).toBe(workspaceActorId(workspace));
  });

  it("atomically round-trips explicit versioned state under a deterministic private workspace root", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    const store = new HeadlongStore({ stateRoot: join(root, "state"), workspace });
    const state = createInitialActorState({
      workspace,
      sessionFile: join(root, "session.jsonl"),
      sessionId: "session-1",
      now: 1_786_000_000_000,
    });

    await store.writeState(state);

    await expect(store.readState()).resolves.toEqual(state);
    expect(store.actorId).toBe(workspaceActorId(workspace));
    expect(Number((await stat(store.directoryPath)).mode & 0o777)).toBe(0o700);
    expect(Number((await stat(store.statePath)).mode & 0o777)).toBe(0o600);
    expect((await readFile(store.statePath, "utf8")).endsWith("\n")).toBe(true);
  });

  it("keeps complete operational events and ignores only a malformed truncated tail", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    const store = new HeadlongStore({ stateRoot: join(root, "state"), workspace });
    await store.appendEvent({
      at: "2026-08-25T16:00:00.000Z",
      type: "actor.started",
      detail: { source: "command" },
    });
    await store.appendEvent({
      at: "2026-08-25T16:00:01.000Z",
      type: "wake.scheduled",
      wakeId: "wake-1",
    });
    await writeFile(store.eventsPath, '{"version":1,"sequence":3', { flag: "a" });
    expect(readOperationalEvents(await readFile(store.eventsPath, "utf8"))).toHaveLength(2);

    await store.appendEvent({
      at: "2026-08-25T16:00:02.000Z",
      type: "wake.recovered",
      wakeId: "wake-1",
    });
    const events = readOperationalEvents(await readFile(store.eventsPath, "utf8"));

    expect(events.map((event) => [event.sequence, event.type, event.wakeId])).toEqual([
      [1, "actor.started", undefined],
      [2, "wake.scheduled", "wake-1"],
      [3, "wake.recovered", "wake-1"],
    ]);
    expect(events[0]?.actorId).toBe(store.actorId);
  });

  it("refuses a precreated symlinked actor directory instead of following it", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    const stateRoot = join(root, "state");
    const outside = join(root, "outside");
    const store = new HeadlongStore({ stateRoot, workspace });
    await mkdir(stateRoot, { recursive: true });
    await mkdir(outside);
    await writeFile(join(outside, "sentinel"), "keep");
    await symlink(outside, store.directoryPath, "dir");

    await expect(
      store.writeState(
        createInitialActorState({ workspace, sessionFile: join(root, "session.jsonl"), sessionId: "s" }),
      ),
    ).rejects.toThrow(/unsafe Headlong directory/);
    await expect(readFile(join(outside, "sentinel"), "utf8")).resolves.toBe("keep");
  });

  it("refuses to read through a precreated symlinked actor directory", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    const stateRoot = join(root, "state");
    const outside = join(root, "outside");
    const store = new HeadlongStore({ stateRoot, workspace });
    await mkdir(stateRoot, { recursive: true });
    await mkdir(outside);
    await writeFile(
      join(outside, basename(store.statePath)),
      JSON.stringify(
        createInitialActorState({ workspace, sessionFile: join(root, "session.jsonl"), sessionId: "s" }),
      ),
    );
    await symlink(outside, store.directoryPath, "dir");

    await expect(store.readState()).rejects.toThrow(/unsafe Headlong directory/);
  });

  it("rejects unknown statuses, negative counters, and invalid timestamps as corrupt state", () => {
    const valid = createInitialActorState({
      workspace: "/tmp/workspace",
      sessionFile: "/tmp/session.jsonl",
      sessionId: "session",
      now: 1_786_000_000_000,
    });

    for (const invalid of [
      { ...valid, status: "launching" },
      { ...valid, consecutiveFailures: -1 },
      { ...valid, backoffLevel: -1 },
      { ...valid, wakeAt: "tomorrow" },
      { ...valid, updatedAt: "not-a-time" },
      { ...valid, workspace: "relative-workspace" },
      { ...valid, sessionFile: "relative-session.jsonl" },
      { ...valid, sessionId: "" },
      { ...valid, activeWakeId: "wake-1", wakeStartedAt: null },
      {
        ...valid,
        status: "completed",
        activeWakeId: "wake-terminal",
        wakeStartedAt: valid.updatedAt,
      },
      { ...valid, activeWakeId: null, wakeStartedAt: valid.updatedAt },
      { ...valid, unexpected: true },
    ]) {
      expect(() => parseActorState(JSON.stringify(invalid))).toThrow(/invalid fields/);
    }
  });

  it("refuses to persist actor state for a different workspace", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    const store = new HeadlongStore({ stateRoot: join(root, "state"), workspace });
    const foreign = createInitialActorState({
      workspace: join(root, "different-workspace"),
      sessionFile: join(root, "session.jsonl"),
      sessionId: "session",
    });

    await expect(store.writeState(foreign)).rejects.toThrow(/another workspace/i);
    await expect(store.readState()).resolves.toBeUndefined();
  });

  it("removes an orphan temporary state file when an atomic transition is interrupted", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    const store = new HeadlongStore({
      stateRoot: join(root, "state"),
      workspace,
      beforeStateRename: async () => {
        throw new Error("injected interruption");
      },
    });

    await expect(
      store.writeState(
        createInitialActorState({ workspace, sessionFile: join(root, "session.jsonl"), sessionId: "s" }),
      ),
    ).rejects.toThrow("injected interruption");

    expect((await readdir(store.directoryPath)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    await expect(store.readState()).resolves.toBeUndefined();
  });

  it("refuses to read a symlinked state file", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    const store = new HeadlongStore({ stateRoot: join(root, "state"), workspace });
    await store.ensureDirectory();
    const outsideState = join(root, "outside-state.json");
    await writeFile(
      outsideState,
      JSON.stringify(
        createInitialActorState({ workspace, sessionFile: join(root, "session.jsonl"), sessionId: "s" }),
      ),
    );
    await symlink(outsideState, store.statePath);

    await expect(store.readState()).rejects.toThrow(/unsafe Headlong state file/i);
  });

  it("keeps every operational event and unique sequence under concurrent append pressure", async () => {
    const root = await temporaryRoot();
    const options = { stateRoot: join(root, "state"), workspace: join(root, "workspace") };
    const stores = Array.from({ length: 40 }, () => new HeadlongStore(options));

    await Promise.all(
      stores.map((store, index) =>
        store.appendEvent({
          at: new Date(1_787_680_000_000 + index).toISOString(),
          type: "pressure",
          detail: { index },
        }),
      ),
    );

    const raw = await readFile(stores[0]!.eventsPath, "utf8");
    const events = readOperationalEvents(raw);
    expect(events).toHaveLength(40);
    expect(new Set(events.map((event) => event.sequence)).size).toBe(40);
  });

  it("rejects non-consecutive or cross-actor operational event history", () => {
    const base = {
      version: 1,
      sequence: 1,
      at: "2026-08-25T16:00:00.000Z",
      type: "actor.started",
      actorId: "actor-a",
    };
    for (const second of [
      { ...base, sequence: 1, type: "duplicate" },
      { ...base, sequence: 3, type: "gap" },
      { ...base, sequence: 2, actorId: "actor-b" },
    ]) {
      expect(() =>
        readOperationalEvents(`${JSON.stringify(base)}\n${JSON.stringify(second)}\n`),
      ).toThrow(/Invalid Headlong operational event/);
    }
  });

  it("refuses to append when an existing event log belongs to another actor", async () => {
    const root = await temporaryRoot();
    const store = new HeadlongStore({
      stateRoot: join(root, "state"),
      workspace: join(root, "workspace"),
    });
    await store.ensureDirectory();
    await writeFile(
      store.eventsPath,
      `${JSON.stringify({
        version: 1,
        sequence: 1,
        at: "2026-08-25T16:00:00.000Z",
        type: "actor.started",
        actorId: "another-actor",
      })}\n`,
    );

    await expect(
      store.appendEvent({ at: "2026-08-25T16:00:01.000Z", type: "wake.dispatched" }),
    ).rejects.toThrow(/another actor/i);
  });
});
