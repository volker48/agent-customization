import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { HeadlongStore } from "./store.js";

export type ActorLeaseOwner = {
  version: 1;
  token: string;
  pid: number;
  processIdentity: string;
  role: string;
  acquiredAt: string;
  heartbeatAt: string;
};

export type ActorLeaseAcquireOptions = {
  store: HeadlongStore;
  role: string;
  processIdentity?: string;
  adoptToken?: string;
  now?: () => number;
  isOwnerLive?: (owner: ActorLeaseOwner) => Promise<boolean>;
  staleAfterMs?: number;
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
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
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
      typeof value.role !== "string" ||
      typeof value.acquiredAt !== "string" ||
      !Number.isFinite(Date.parse(value.acquiredAt)) ||
      typeof value.heartbeatAt !== "string" ||
      !Number.isFinite(Date.parse(value.heartbeatAt))
    ) {
      throw new InvalidLeaseOwnerError(`Invalid Headlong lease owner: ${path}`);
    }
    return value as ActorLeaseOwner;
  } finally {
    await handle.close();
  }
}

function sameOwner(left: ActorLeaseOwner | undefined, right: ActorLeaseOwner | undefined): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.version === right.version &&
    left.token === right.token &&
    left.pid === right.pid &&
    left.processIdentity === right.processIdentity &&
    left.role === right.role &&
    left.acquiredAt === right.acquiredAt &&
    left.heartbeatAt === right.heartbeatAt
  );
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
  ) {
    this.owner = owner;
    this.adopted = adopted;
    this.ownerPath = join(store.leasePath, "owner.v1.json");
  }

  static async acquire(options: ActorLeaseAcquireOptions): Promise<ActorLease | undefined> {
    await options.store.ensureDirectory();
    const now = options.now ?? Date.now;
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
    if (published) return new ActorLease(options.store, owner, false);

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
    let invalidOwner = false;
    try {
      current = await readOwner(ownerPath);
    } catch (error) {
      if (!(error instanceof InvalidLeaseOwnerError)) throw error;
      invalidOwner = true;
    }
    if (current && options.adoptToken && current.token === options.adoptToken) {
      const adopted: ActorLeaseOwner = {
        ...current,
        pid: process.pid,
        processIdentity: options.processIdentity ?? (await currentProcessIdentity()),
        role: options.role,
        heartbeatAt: new Date(now()).toISOString(),
      };
      await replaceOwner(ownerPath, adopted);
      return new ActorLease(options.store, adopted, true);
    }

    const staleAfterMs = options.staleAfterMs ?? 30_000;
    const observedAt = current ? Date.parse(current.heartbeatAt) : leaseMetadata.mtimeMs;
    if (!Number.isFinite(observedAt) || now() - observedAt < staleAfterMs) return undefined;
    if (current) {
      const isOwnerLive = options.isOwnerLive ?? defaultIsOwnerLive;
      if (await isOwnerLive(current)) return undefined;
      const confirmed = await readOwner(ownerPath);
      if (!sameOwner(current, confirmed)) return undefined;
      current = confirmed;
    } else if (!invalidOwner) {
      return undefined;
    }

    const stalePath = `${options.store.leasePath}.stale-${randomUUID()}`;
    try {
      await rename(options.store.leasePath, stalePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return ActorLease.acquire(options);
      return undefined;
    }
    const movedMetadata = await lstat(stalePath);
    if (movedMetadata.dev !== leaseMetadata.dev || movedMetadata.ino !== leaseMetadata.ino) {
      await rename(stalePath, options.store.leasePath).catch(() => undefined);
      return undefined;
    }
    if (current) {
      const movedOwner = await readOwner(join(stalePath, "owner.v1.json"));
      if (!sameOwner(current, movedOwner)) {
        await rename(stalePath, options.store.leasePath);
        return undefined;
      }
    }
    await rm(stalePath, { recursive: true, force: true });
    return ActorLease.acquire(options);
  }

  async assertOwned(): Promise<void> {
    const current = await readOwner(this.ownerPath);
    if (!current || current.token !== this.owner.token) {
      throw new Error("Headlong lease is not owned by this token");
    }
  }

  async release(): Promise<void> {
    if (this.released || this.adopted) return;
    await this.assertOwned();
    await rm(this.store.leasePath, { recursive: true, force: false });
    this.released = true;
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
