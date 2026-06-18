import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENTRY_PATH = "../pi-extensions/remote/daemon-entry.js";
const DAEMON_PATH = "../pi-extensions/remote/daemon.js";

async function importDaemonEntry(): Promise<ReturnType<typeof vi.fn>> {
  const startRemoteDaemon = vi.fn().mockResolvedValue({ close: vi.fn().mockResolvedValue(undefined) });
  vi.doMock(DAEMON_PATH, () => ({ startRemoteDaemon }));
  vi.doMock("node:events", async () => {
    const actual = await vi.importActual<typeof import("node:events")>("node:events");
    return { ...actual, once: vi.fn().mockResolvedValue([]) };
  });

  await import(ENTRY_PATH);
  return startRemoteDaemon;
}

describe("remote daemon entry pairing code default", () => {
  let originalCode: string | undefined;

  beforeEach(() => {
    originalCode = process.env.PI_REMOTE_PAIRING_CODE;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalCode === undefined) {
      delete process.env.PI_REMOTE_PAIRING_CODE;
    } else {
      process.env.PI_REMOTE_PAIRING_CODE = originalCode;
    }
  });

  it("defaults to a freshly generated, non-constant pairing code", async () => {
    delete process.env.PI_REMOTE_PAIRING_CODE;

    const startRemoteDaemon = await importDaemonEntry();

    expect(startRemoteDaemon).toHaveBeenCalledTimes(1);
    const pairingCode = startRemoteDaemon.mock.calls[0][0].pairingCode;
    expect(pairingCode).not.toBe("000-000");
    expect(pairingCode).toMatch(/^\d{3}-\d{3}$/);
  });

  it("generates a different code on each run", async () => {
    delete process.env.PI_REMOTE_PAIRING_CODE;

    const first = await importDaemonEntry();
    vi.resetModules();
    const second = await importDaemonEntry();

    const firstCode = first.mock.calls[0][0].pairingCode;
    const secondCode = second.mock.calls[0][0].pairingCode;
    expect(firstCode).not.toBe(secondCode);
  });

  it("honors an explicit PI_REMOTE_PAIRING_CODE override", async () => {
    process.env.PI_REMOTE_PAIRING_CODE = "999-999";

    const startRemoteDaemon = await importDaemonEntry();

    expect(startRemoteDaemon).toHaveBeenCalledWith(
      expect.objectContaining({ pairingCode: "999-999" }),
    );
  });
});
