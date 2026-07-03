import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENTRY_PATH = "../pi-extensions/remote/daemon-entry.js";
const DAEMON_PATH = "../pi-extensions/remote/daemon.js";
const AUTH_PATH = "../pi-extensions/remote/authorization.js";

type DaemonEntryImport = {
  createPairingCode: ReturnType<typeof vi.fn>;
  startRemoteDaemon: ReturnType<typeof vi.fn>;
};

async function importDaemonEntry(generatedCode = "123-456"): Promise<DaemonEntryImport> {
  const createPairingCode = vi.fn().mockReturnValue(generatedCode);
  const startRemoteDaemon = vi
    .fn()
    .mockResolvedValue({ close: vi.fn().mockResolvedValue(undefined) });
  vi.doMock(AUTH_PATH, async () => {
    const actual =
      await vi.importActual<typeof import("../pi-extensions/remote/authorization.js")>(AUTH_PATH);
    return { ...actual, createPairingCode };
  });
  vi.doMock(DAEMON_PATH, () => ({ startRemoteDaemon }));
  vi.doMock("node:events", async () => {
    const actual = await vi.importActual<typeof import("node:events")>("node:events");
    return { ...actual, once: vi.fn().mockResolvedValue([]) };
  });

  await import(ENTRY_PATH);
  return { createPairingCode, startRemoteDaemon };
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

  it("passes the generated-code factory without creating an always-valid code", async () => {
    delete process.env.PI_REMOTE_PAIRING_CODE;

    const { createPairingCode, startRemoteDaemon } = await importDaemonEntry();

    expect(createPairingCode).not.toHaveBeenCalled();
    expect(startRemoteDaemon).toHaveBeenCalledTimes(1);
    const options = startRemoteDaemon.mock.calls[0]?.[0];
    expect(options).toMatchObject({ remoteRoot: expect.any(String) });
    expect(options.createPairingCode()).toBe("123-456");
    expect(createPairingCode).toHaveBeenCalledTimes(1);
  });

  it("requests a fresh generated code whenever the daemon arms pairing", async () => {
    delete process.env.PI_REMOTE_PAIRING_CODE;

    const first = await importDaemonEntry("111-111");
    vi.resetModules();
    const second = await importDaemonEntry("222-222");

    const firstOptions = first.startRemoteDaemon.mock.calls[0]?.[0];
    const secondOptions = second.startRemoteDaemon.mock.calls[0]?.[0];
    expect(firstOptions.createPairingCode()).toBe("111-111");
    expect(secondOptions.createPairingCode()).toBe("222-222");
  });

  it("honors an explicit PI_REMOTE_PAIRING_CODE override", async () => {
    process.env.PI_REMOTE_PAIRING_CODE = "999-999";

    const { createPairingCode, startRemoteDaemon } = await importDaemonEntry();

    expect(createPairingCode).not.toHaveBeenCalled();
    expect(startRemoteDaemon).toHaveBeenCalledWith(
      expect.objectContaining({ pairingCode: "999-999" }),
    );
  });
});
