import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  CachedNodeAllowlist,
  FileNodeAllowlist,
  PairingWindow,
  authorizeRemoteEnvelope,
  createPairingCode,
  defaultRemoteRoot,
  renderPairingTicket,
  verifyPairingCode,
} from "../pi-extensions/remote/authorization.js";
import type { NodeAllowlist } from "../pi-extensions/remote/authorization.js";
import type { Envelope } from "../pi-extensions/remote/protocol.js";

describe("remote authorization", () => {
  it("generates human-transcribable pairing codes and rejects the wrong code", () => {
    const code = createPairingCode(() => Buffer.from([0x12, 0x34, 0x56]));

    expect(code).toBe("193-046");
    expect(verifyPairingCode(code, "193-046")).toBe(true);
    expect(verifyPairingCode(code, "193-047")).toBe(false);
  });

  it("resamples pairing codes from the biased tail", () => {
    const samples = [Buffer.from([0xf4, 0x24, 0x00]), Buffer.from([0x12, 0x34, 0x56])];
    let index = 0;

    const code = createPairingCode(() => samples[index++]);

    expect(code).toBe("193-046");
    expect(index).toBe(2);
  });

  it("persists allowed node ids under the remote root", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-remote-auth-"));
    const allowlist = new FileNodeAllowlist(root);

    await allowlist.add("node-a");

    const loaded = new FileNodeAllowlist(root);
    await expect(loaded.has("node-a")).resolves.toBe(true);
    await expect(readFile(join(root, "allowed-node-ids.json"), "utf8")).resolves.toContain(
      "node-a",
    );
  });

  it("rejects unpaired session data before it is routed", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-remote-auth-"));
    const allowlist = new FileNodeAllowlist(root);
    const envelope: Envelope = { sessionId: "session-1", type: "prompt", payload: {} };

    await expect(
      authorizeRemoteEnvelope({
        nodeId: "node-a",
        envelope,
        allowlist,
      }),
    ).resolves.toEqual({ accepted: false, reason: "node is not paired" });
  });

  it("rejects a wrong pairing code", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-remote-auth-"));
    const allowlist = new FileNodeAllowlist(root);
    const envelope: Envelope = {
      sessionId: null,
      type: "pair",
      payload: { code: "000-000" },
    };

    await expect(
      authorizeRemoteEnvelope({
        nodeId: "node-a",
        envelope,
        allowlist,
        pairingWindow: armedPairingWindow("123-456"),
      }),
    ).resolves.toEqual({ accepted: false, reason: "invalid or expired pairing code" });
    await expect(allowlist.has("node-a")).resolves.toBe(false);
  });

  it("records a node id after a valid pairing code", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-remote-auth-"));
    const allowlist = new FileNodeAllowlist(root);
    const envelope: Envelope = {
      sessionId: null,
      type: "pair",
      payload: { code: "123-456" },
    };

    await expect(
      authorizeRemoteEnvelope({
        nodeId: "node-a",
        envelope,
        allowlist,
        pairingWindow: armedPairingWindow("123-456"),
      }),
    ).resolves.toEqual({ accepted: true, mode: "pairing" });
    await expect(allowlist.has("node-a")).resolves.toBe(true);
  });

  it("accepts a paired node id with no code", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-remote-auth-"));
    const allowlist = new FileNodeAllowlist(root);
    await allowlist.add("node-a");
    const envelope: Envelope = { sessionId: "session-1", type: "prompt", payload: {} };

    await expect(
      authorizeRemoteEnvelope({ nodeId: "node-a", envelope, allowlist }),
    ).resolves.toEqual({ accepted: true, mode: "paired" });
  });

  it("only accepts pairing codes while the pairing window is open", () => {
    let now = 1000;
    const window = new PairingWindow(
      () => "123-456",
      () => now,
      100,
    );

    expect(window.verify("123-456")).toBe(false);
    expect(window.arm()).toBe("123-456");
    expect(window.verify("123-456")).toBe(true);

    window.arm();
    now = 1101;
    expect(window.verify("123-456")).toBe(false);
  });

  it("rotates the pairing code whenever the pairing window is armed", () => {
    const codes = ["111-111", "222-222"];
    const window = new PairingWindow(() => codes.shift() ?? "333-333");

    expect(window.arm()).toBe("111-111");
    expect(window.arm()).toBe("222-222");
    expect(window.verify("111-111")).toBe(false);
    expect(window.verify("222-222")).toBe(true);
  });

  it("renders the endpoint ticket with generated QR output and a pairing code", () => {
    const rendered = renderPairingTicket({
      ticket: "ticket-abc",
      pairingCode: "123-456",
      generateQr: (_ticket, onOutput) => onOutput("█ mocked QR"),
    });

    expect(rendered).toContain("Pi remote endpoint ticket QR");
    expect(rendered).toContain("ticket-abc");
    expect(rendered).toContain("Enter pairing code: 123-456");
    expect(rendered).toContain("█");
  });

  it("fails loudly if QR generation does not synchronously return output", () => {
    expect(() =>
      renderPairingTicket({
        ticket: "ticket-abc",
        pairingCode: "123-456",
        generateQr: () => {},
      }),
    ).toThrow("qrcode-terminal did not synchronously render ticket QR");
  });

  it("uses ~/.pi/agent/remote as the default remote root", () => {
    expect(defaultRemoteRoot()).toMatch(/\.pi\/agent\/remote$/u);
  });
});

function armedPairingWindow(code: string): PairingWindow {
  const window = new PairingWindow(() => code);
  window.arm();
  return window;
}

describe("CachedNodeAllowlist", () => {
  function countingAllowlist(present: Set<string>): NodeAllowlist & { reads: number } {
    return {
      reads: 0,
      async has(nodeId: string) {
        this.reads += 1;
        return present.has(nodeId);
      },
      async add(nodeId: string) {
        present.add(nodeId);
      },
    };
  }

  it("reads the delegate once per node id across repeated checks", async () => {
    const delegate = countingAllowlist(new Set(["node-a"]));
    const cached = new CachedNodeAllowlist(delegate);

    await expect(cached.has("node-a")).resolves.toBe(true);
    await expect(cached.has("node-a")).resolves.toBe(true);
    await expect(cached.has("node-a")).resolves.toBe(true);

    expect(delegate.reads).toBe(1);
  });

  it("makes a paired node visible without re-reading the delegate", async () => {
    const delegate = countingAllowlist(new Set());
    const cached = new CachedNodeAllowlist(delegate);

    await expect(cached.has("node-a")).resolves.toBe(false);
    await cached.add("node-a");
    await expect(cached.has("node-a")).resolves.toBe(true);

    expect(delegate.reads).toBe(1);
  });
});
