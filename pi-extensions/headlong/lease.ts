import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HeadlongStore } from "./store.js";

export type ActorLeaseDelegate = {
  pid: number;
  processIdentity: string;
  role: string;
  acquiredAt: string;
  heartbeatAt: string;
};

export type ActorLeaseOwner = {
  version: 1;
  token: string;
  pid: number;
  processIdentity: string;
  role: string;
  acquiredAt: string;
  heartbeatAt: string;
  delegate?: ActorLeaseDelegate;
};

export type ActorLeaseAcquireOptions = {
  store: HeadlongStore;
  role: string;
  processIdentity?: string;
  adoptToken?: string;
  now?: () => number;
  isOwnerLive?: (owner: ActorLeaseOwner) => Promise<boolean>;
  staleAfterMs?: number;
  beforeReleaseValidation?: (tombstonePath: string) => Promise<void>;
};

class InvalidLeaseOwnerError extends Error {}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeOwner(path: string, owner: ActorLeaseOwner): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function replaceOwner(path: string, owner: ActorLeaseOwner): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeOwner(temporaryPath, owner);
    await rename(temporaryPath, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function isValidTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isValidProcessIdentity(value: unknown): value is ActorLeaseDelegate {
  if (!value || typeof value !== "object") return false;
  const identity = value as Partial<ActorLeaseDelegate>;
  return (
    Number.isSafeInteger(identity.pid) &&
    (identity.pid ?? 0) > 0 &&
    typeof identity.processIdentity === "string" &&
    Boolean(identity.processIdentity) &&
    typeof identity.role === "string" &&
    Boolean(identity.role) &&
    isValidTimestamp(identity.acquiredAt) &&
    isValidTimestamp(identity.heartbeatAt)
  );
}

async function readOwner(path: string): Promise<ActorLeaseOwner | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    handle = await open(path, constants.O_RDONLY | noFollow);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error(`Refusing unsafe Headlong lease owner: ${path}`, { cause: error });
    }
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    ) {
      throw new Error(`Refusing unsafe Headlong lease owner: ${path}`);
    }
    let value: Partial<ActorLeaseOwner>;
    try {
      value = JSON.parse(await handle.readFile("utf8")) as Partial<ActorLeaseOwner>;
    } catch (error) {
      throw new InvalidLeaseOwnerError(`Invalid Headlong lease owner: ${path}`, { cause: error });
    }
    if (
      value.version !== 1 ||
      typeof value.token !== "string" ||
      !value.token ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid ?? 0) <= 0 ||
      typeof value.processIdentity !== "string" ||
      !value.processIdentity ||
      typeof value.role !== "string" ||
      !value.role ||
      !isValidTimestamp(value.acquiredAt) ||
      !isValidTimestamp(value.heartbeatAt) ||
      !(value.delegate === undefined || isValidProcessIdentity(value.delegate))
    ) {
      throw new InvalidLeaseOwnerError(`Invalid Headlong lease owner: ${path}`);
    }
    return value as ActorLeaseOwner;
  } finally {
    await handle.close();
  }
}

function sameDelegate(
  left: ActorLeaseDelegate | undefined,
  right: ActorLeaseDelegate | undefined,
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.pid === right.pid &&
      left.processIdentity === right.processIdentity &&
      left.role === right.role &&
      left.acquiredAt === right.acquiredAt &&
      left.heartbeatAt === right.heartbeatAt)
  );
}

function samePrimary(
  left: ActorLeaseOwner | undefined,
  right: ActorLeaseOwner | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.version === right.version &&
    left.token === right.token &&
    left.pid === right.pid &&
    left.processIdentity === right.processIdentity &&
    left.role === right.role &&
    left.acquiredAt === right.acquiredAt
  );
}

function sameOwner(left: ActorLeaseOwner | undefined, right: ActorLeaseOwner | undefined): boolean {
  return (
    samePrimary(left, right) &&
    left?.heartbeatAt === right?.heartbeatAt &&
    sameDelegate(left?.delegate, right?.delegate)
  );
}

function delegateAsOwner(owner: ActorLeaseOwner, delegate: ActorLeaseDelegate): ActorLeaseOwner {
  return {
    version: 1,
    token: owner.token,
    pid: delegate.pid,
    processIdentity: delegate.processIdentity,
    role: delegate.role,
    acquiredAt: delegate.acquiredAt,
    heartbeatAt: delegate.heartbeatAt,
  };
}

async function restoreMovedLease(tombstonePath: string, leasePath: string): Promise<void> {
  try {
    await rename(tombstonePath, leasePath);
  } catch {
    // A new owner may already occupy leasePath. Keep the tombstone for operator inspection.
  }
}

export class ActorLease {
  readonly owner: ActorLeaseOwner;
  readonly adopted: boolean;

  private released = false;
  private readonly ownerPath: string;

  private constructor(
    private readonly store: HeadlongStore,
    owner: ActorLeaseOwner,
    adopted: boolean,
    private readonly delegate: ActorLeaseDelegate | undefined,
    private readonly isOwnerLive: (owner: ActorLeaseOwner) => Promise<boolean>,
    private readonly beforeReleaseValidation?: (tombstonePath: string) => Promise<void>,
  ) {
    this.owner = owner;
    this.adopted = adopted;
    this.ownerPath = join(store.leasePath, "owner.v1.json");
  }

  static async acquire(options: ActorLeaseAcquireOptions): Promise<ActorLease | undefined> {
    await options.store.ensureDirectory();
    const now = options.now ?? Date.now;
    const isOwnerLive = options.isOwnerLive ?? defaultIsOwnerLive;
    const at = new Date(now()).toISOString();
    const owner: ActorLeaseOwner = {
      version: 1,
      token: randomUUID(),
      pid: process.pid,
      processIdentity: options.processIdentity ?? (await currentProcessIdentity()),
      role: options.role,
      acquiredAt: at,
      heartbeatAt: at,
    };
    const temporaryLeasePath = `${options.store.leasePath}.creating-${randomUUID()}`;
    let published = false;
    try {
      await mkdir(temporaryLeasePath, { mode: 0o700 });
      await writeOwner(join(temporaryLeasePath, "owner.v1.json"), owner);
      await syncDirectory(temporaryLeasePath);
      await rename(temporaryLeasePath, options.store.leasePath);
      await syncDirectory(options.store.directoryPath);
      published = true;
    } catch (error) {
      await rm(temporaryLeasePath, { recursive: true, force: true });
      try {
        await lstat(options.store.leasePath);
      } catch (metadataError) {
        if ((metadataError as NodeJS.ErrnoException).code === "ENOENT") throw error;
        throw metadataError;
      }
    }
    if (published) {
      return new ActorLease(
        options.store,
        owner,
        false,
        undefined,
        isOwnerLive,
        options.beforeReleaseValidation,
      );
    }

    const ownerPath = join(options.store.leasePath, "owner.v1.json");
    let leaseMetadata;
    try {
      leaseMetadata = await lstat(options.store.leasePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return ActorLease.acquire(options);
      throw error;
    }
    if (
      leaseMetadata.isSymbolicLink() ||
      !leaseMetadata.isDirectory() ||
      (typeof process.getuid === "function" && leaseMetadata.uid !== process.getuid())
    ) {
      throw new Error(`Refusing unsafe Headlong lease: ${options.store.leasePath}`);
    }

    let current: ActorLeaseOwner | undefined;
    try {
      current = await readOwner(ownerPath);
    } catch (error) {
      if (error instanceof InvalidLeaseOwnerError) {
        throw new Error(
          "Headlong lease owner is corrupt; refusing automatic recovery without liveness identity",
          { cause: error },
        );
      }
      throw error;
    }
    if (!current) {
      throw new Error(
        "Headlong lease owner is missing; refusing automatic recovery without liveness identity",
      );
    }

    if (options.adoptToken && current.token === options.adoptToken) {
      const delegate: ActorLeaseDelegate = {
        pid: process.pid,
        processIdentity: options.processIdentity ?? (await currentProcessIdentity()),
        role: options.role,
        acquiredAt: at,
        heartbeatAt: at,
      };
      if (current.delegate && !sameDelegate(current.delegate, delegate)) {
        if (await isOwnerLive(delegateAsOwner(current, current.delegate))) return undefined;
      }
      const adopted: ActorLeaseOwner = { ...current, delegate };
      await replaceOwner(ownerPath, adopted);
      const confirmed = await readOwner(ownerPath);
      if (
        !confirmed ||
        !samePrimary(adopted, confirmed) ||
        !sameDelegate(delegate, confirmed.delegate)
      ) {
        throw new Error("Headlong lease delegation changed during adoption");
      }
      return new ActorLease(
        options.store,
        adopted,
        true,
        delegate,
        isOwnerLive,
        options.beforeReleaseValidation,
      );
    }

    const staleAfterMs = options.staleAfterMs ?? 30_000;
    const observedAt = Math.max(
      Date.parse(current.heartbeatAt),
      current.delegate ? Date.parse(current.delegate.heartbeatAt) : Number.NEGATIVE_INFINITY,
    );
    if (!Number.isFinite(observedAt) || now() - observedAt < staleAfterMs) return undefined;
    if (await isOwnerLive(current)) return undefined;
    if (current.delegate && (await isOwnerLive(delegateAsOwner(current, current.delegate)))) {
      return undefined;
    }
    const confirmed = await readOwner(ownerPath);
    if (!sameOwner(current, confirmed)) return undefined;
    current = confirmed;

    const stalePath = `${options.store.leasePath}.stale-${randomUUID()}`;
    try {
      await rename(options.store.leasePath, stalePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return ActorLease.acquire(options);
      return undefined;
    }
    const movedMetadata = await lstat(stalePath);
    if (movedMetadata.dev !== leaseMetadata.dev || movedMetadata.ino !== leaseMetadata.ino) {
      await restoreMovedLease(stalePath, options.store.leasePath);
      return undefined;
    }
    let movedOwner: ActorLeaseOwner | undefined;
    try {
      movedOwner = await readOwner(join(stalePath, "owner.v1.json"));
    } catch (error) {
      await restoreMovedLease(stalePath, options.store.leasePath);
      throw error;
    }
    if (!sameOwner(current, movedOwner)) {
      await restoreMovedLease(stalePath, options.store.leasePath);
      return undefined;
    }
    await rm(stalePath, { recursive: true, force: true });
    await syncDirectory(options.store.directoryPath);
    return ActorLease.acquire(options);
  }

  async assertOwned(): Promise<void> {
    const current = await readOwner(this.ownerPath);
    if (!current || !samePrimary(this.owner, current)) {
      throw new Error("Headlong lease is not owned by this token");
    }
    if (this.adopted && !sameDelegate(this.delegate, current.delegate)) {
      throw new Error("Headlong lease delegation is not owned by this process");
    }
  }

  async reclaimDelegation(): Promise<void> {
    if (this.adopted) throw new Error("A Headlong lease delegate cannot reclaim primary ownership");
    const current = await readOwner(this.ownerPath);
    if (!current || !samePrimary(this.owner, current)) {
      throw new Error("Headlong lease is not owned by this token");
    }
    if (!current.delegate) return;
    if (await this.isOwnerLive(delegateAsOwner(current, current.delegate))) {
      throw new Error("Headlong lease delegate is still live");
    }
    const { delegate: _delegate, ...primary } = current;
    await replaceOwner(this.ownerPath, primary);
    const confirmed = await readOwner(this.ownerPath);
    if (!confirmed || !samePrimary(primary, confirmed) || confirmed.delegate !== undefined) {
      throw new Error("Headlong lease delegation changed during primary reclaim");
    }
  }

  async release(): Promise<boolean> {
    if (this.released) return true;
    if (this.adopted) return this.releaseDelegate();

    const tombstonePath = `${this.store.leasePath}.release-${randomUUID()}`;
    try {
      await rename(this.store.leasePath, tombstonePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }

    await this.beforeReleaseValidation?.(tombstonePath);
    let movedOwner: ActorLeaseOwner | undefined;
    try {
      movedOwner = await readOwner(join(tombstonePath, "owner.v1.json"));
    } catch (error) {
      await restoreMovedLease(tombstonePath, this.store.leasePath);
      throw error;
    }
    if (!samePrimary(this.owner, movedOwner)) {
      await restoreMovedLease(tombstonePath, this.store.leasePath);
      return false;
    }
    if (
      movedOwner.delegate &&
      (await this.isOwnerLive(delegateAsOwner(movedOwner, movedOwner.delegate)))
    ) {
      await restoreMovedLease(tombstonePath, this.store.leasePath);
      throw new Error("Refusing to release a Headlong lease while its delegate is live");
    }

    await rm(tombstonePath, { recursive: true, force: false });
    await syncDirectory(this.store.directoryPath);
    this.released = true;
    return true;
  }

  private async releaseDelegate(): Promise<boolean> {
    const current = await readOwner(this.ownerPath);
    if (
      !current ||
      !samePrimary(this.owner, current) ||
      !sameDelegate(this.delegate, current.delegate)
    ) {
      return false;
    }
    const { delegate: _delegate, ...primary } = current;
    await replaceOwner(this.ownerPath, primary);
    const confirmed = await readOwner(this.ownerPath);
    if (!confirmed || !samePrimary(primary, confirmed) || confirmed.delegate !== undefined) {
      throw new Error("Headlong lease delegation changed during handback");
    }
    this.released = true;
    return true;
  }
}

export async function defaultIsOwnerLive(owner: ActorLeaseOwner): Promise<boolean> {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
  return (await currentProcessIdentity(owner.pid)) === owner.processIdentity;
}

export async function currentProcessIdentity(pid = process.pid): Promise<string> {
  try {
    const [stat, bootId] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf8"),
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    ]);
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 2).split(" ");
    const startTicks = fields[19];
    if (!startTicks) throw new Error("missing process start ticks");
    return `linux:${bootId.trim()}:${startTicks}`;
  } catch {
    return `portable:${pid}`;
  }
}
