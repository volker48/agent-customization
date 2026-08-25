import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ActorLease } from "../pi-extensions/headlong/lease.js";
import { HeadlongStore } from "../pi-extensions/headlong/store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Headlong single-flight actor lease", () => {
  it("allows only one winner across racing independent lease instances", async () => {
    const root = await mkdtemp(join(tmpdir(), "headlong-lease-race-"));
    roots.push(root);
    const store = new HeadlongStore({ stateRoot: join(root, "state"), workspace: join(root, "work") });
    const contenders = Array.from({ length: 20 }, (_, index) =>
      ActorLease.acquire({
        store,
        role: `contender-${index}`,
        processIdentity: `test-process-${index}`,
        isOwnerLive: async () => true,
      }),
    );

    const results = await Promise.all(contenders);
    const winners = results.filter((lease) => lease !== undefined);

    expect(winners).toHaveLength(1);
    await winners[0]?.release();
  });

  it("uses a stale grace window before recovering a dead owner with a new token", async () => {
    const root = await mkdtemp(join(tmpdir(), "headlong-lease-stale-"));
    roots.push(root);
    const store = new HeadlongStore({ stateRoot: join(root, "state"), workspace: join(root, "work") });
    const first = await ActorLease.acquire({
      store,
      role: "host",
      processIdentity: "dead-owner",
      now: () => 1_000,
    });
    expect(first).toBeDefined();

    await expect(
      ActorLease.acquire({
        store,
        role: "supervisor",
        processIdentity: "candidate",
        now: () => 1_500,
        staleAfterMs: 1_000,
        isOwnerLive: async () => false,
      }),
    ).resolves.toBeUndefined();

    const recovered = await ActorLease.acquire({
      store,
      role: "supervisor",
      processIdentity: "candidate",
      now: () => 3_000,
      staleAfterMs: 1_000,
      isOwnerLive: async () => false,
    });
    expect(recovered?.owner.token).not.toBe(first?.owner.token);
    await recovered?.release();
  });

  it("recovers an incomplete owner file only after the lease directory is stale", async () => {
    const root = await mkdtemp(join(tmpdir(), "headlong-lease-incomplete-"));
    roots.push(root);
    const store = new HeadlongStore({ stateRoot: join(root, "state"), workspace: join(root, "work") });
    await store.ensureDirectory();
    await mkdir(store.leasePath, { mode: 0o700 });
    await writeFile(join(store.leasePath, "owner.v1.json"), "", { mode: 0o600 });
    await utimes(store.leasePath, new Date(0), new Date(0));

    const recovered = await ActorLease.acquire({
      store,
      role: "supervisor",
      processIdentity: "candidate",
      now: () => 100_000,
      staleAfterMs: 1_000,
      isOwnerLive: async () => false,
    });

    expect(recovered).toBeDefined();
    await expect(recovered?.assertOwned()).resolves.toBeUndefined();
    await recovered?.release();
  });

  it("adopts an inherited same-token lease without self-deadlock or releasing the supervisor owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "headlong-lease-adopt-"));
    roots.push(root);
    const store = new HeadlongStore({ stateRoot: join(root, "state"), workspace: join(root, "work") });
    const supervisor = await ActorLease.acquire({
      store,
      role: "supervisor",
      processIdentity: "supervisor-process",
    });
    const extension = await ActorLease.acquire({
      store,
      role: "extension",
      processIdentity: "child-process",
      adoptToken: supervisor?.owner.token,
    });

    expect(extension?.adopted).toBe(true);
    expect(extension?.owner).toMatchObject({
      token: supervisor?.owner.token,
      processIdentity: "child-process",
      role: "extension",
    });
    await expect(extension?.assertOwned()).resolves.toBeUndefined();
    await extension?.release();
    await expect(supervisor?.assertOwned()).resolves.toBeUndefined();
    await supervisor?.release();
  });

  it("refuses a malicious precreated symlink at the lease boundary even with a matching token", async () => {
    const root = await mkdtemp(join(tmpdir(), "headlong-lease-symlink-"));
    roots.push(root);
    const store = new HeadlongStore({ stateRoot: join(root, "state"), workspace: join(root, "work") });
    await store.ensureDirectory();
    const outside = join(root, "outside");
    await mkdir(outside);
    const token = "attacker-matching-token";
    await writeFile(
      join(outside, "owner.v1.json"),
      `${JSON.stringify({
        version: 1,
        token,
        pid: process.pid,
        processIdentity: "attacker",
        role: "attacker",
        acquiredAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
      })}\n`,
    );
    await symlink(outside, store.leasePath);

    await expect(
      ActorLease.acquire({ store, role: "child", adoptToken: token }),
    ).rejects.toThrow(/unsafe Headlong lease/i);
  });

  it("does not evict a live child that adopts while stale-owner recovery is checking liveness", async () => {
    const root = await mkdtemp(join(tmpdir(), "headlong-lease-adoption-recovery-race-"));
    roots.push(root);
    const store = new HeadlongStore({ stateRoot: root, workspace: join(root, "workspace") });
    const supervisor = await ActorLease.acquire({
      store,
      role: "supervisor",
      processIdentity: "dead-parent",
      now: () => 1_000,
    });
    expect(supervisor).toBeDefined();

    let releaseLiveness!: () => void;
    const livenessGate = new Promise<void>((resolve) => {
      releaseLiveness = resolve;
    });
    let observed!: () => void;
    const ownerObserved = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const reaperPromise = ActorLease.acquire({
      store,
      role: "reaper",
      processIdentity: "reaper",
      now: () => 100_000,
      staleAfterMs: 1_000,
      isOwnerLive: async () => {
        observed();
        await livenessGate;
        return false;
      },
    });
    await ownerObserved;

    const child = await ActorLease.acquire({
      store,
      role: "extension",
      adoptToken: supervisor?.owner.token,
      processIdentity: "live-child",
      now: () => 100_000,
    });
    expect(child?.adopted).toBe(true);
    releaseLiveness();

    await expect(reaperPromise).resolves.toBeUndefined();
    await expect(child?.assertOwned()).resolves.toBeUndefined();
  });

  it("refuses a symlinked lease owner file even when its target contains a matching token", async () => {
    const root = await mkdtemp(join(tmpdir(), "headlong-lease-owner-symlink-"));
    roots.push(root);
    const store = new HeadlongStore({ stateRoot: join(root, "state"), workspace: join(root, "work") });
    await store.ensureDirectory();
    await mkdir(store.leasePath);
    const token = "attacker-matching-token";
    const outsideOwner = join(root, "outside-owner.json");
    await writeFile(
      outsideOwner,
      `${JSON.stringify({
        version: 1,
        token,
        pid: process.pid,
        processIdentity: "attacker",
        role: "attacker",
        acquiredAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
      })}\n`,
    );
    await symlink(outsideOwner, join(store.leasePath, "owner.v1.json"));

    await expect(
      ActorLease.acquire({ store, role: "child", adoptToken: token }),
    ).rejects.toThrow(/unsafe Headlong lease owner/i);
  });
});
