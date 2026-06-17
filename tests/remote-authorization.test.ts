import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  FileNodeAllowlist,
  authorizeRemoteEnvelope,
  createPairingCode,
  defaultRemoteRoot,
  renderPairingTicket,
  verifyPairingCode,
} from "../pi-extensions/remote/authorization.js";
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
        pairingCode: "123-456",
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
        pairingCode: "123-456",
      }),
    ).resolves.toEqual({ accepted: false, reason: "invalid pairing code" });
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
        pairingCode: "123-456",
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

  it("renders the endpoint ticket as a terminal QR with a hand-transcribed pairing code", () => {
    const rendered = renderPairingTicket({ ticket: "ticket-abc", pairingCode: "123-456" });

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
