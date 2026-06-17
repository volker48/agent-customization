import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import qrcode from "qrcode-terminal";

import type { Envelope } from "./protocol.js";

type RandomBytes = (size: number) => Uint8Array;
type QrGenerator = (ticket: string, onOutput: (output: string) => void) => void;

export type NodeAllowlist = {
  has(nodeId: string): Promise<boolean>;
  add(nodeId: string): Promise<void>;
};

export type AuthorizationResult =
  | { accepted: true; mode: "paired" | "pairing" }
  | { accepted: false; reason: string };

export type AuthorizationRequest = {
  nodeId: string;
  envelope: Envelope;
  allowlist: NodeAllowlist;
  pairingCode?: string;
};

const PAIRING_CODE_MODULUS = 1_000_000;
const PAIRING_CODE_SAMPLE_SPACE = 0x1_00_00_00;
const PAIRING_CODE_UNBIASED_LIMIT =
  Math.floor(PAIRING_CODE_SAMPLE_SPACE / PAIRING_CODE_MODULUS) * PAIRING_CODE_MODULUS;
const ALLOWLIST_FILE = "allowed-node-ids.json";

export function defaultRemoteRoot(): string {
  return join(homedir(), ".pi", "agent", "remote");
}

export function createPairingCode(randomBytes: RandomBytes = cryptoRandomBytes): string {
  let value = drawPairingCodeValue(randomBytes);
  while (value >= PAIRING_CODE_UNBIASED_LIMIT) {
    value = drawPairingCodeValue(randomBytes);
  }

  const digits = (value % PAIRING_CODE_MODULUS).toString().padStart(6, "0");
  return `${digits.slice(0, 3)}-${digits.slice(3)}`;
}

export function verifyPairingCode(expected: string, received: string): boolean {
  const left = Buffer.from(normalizePairingCode(expected));
  const right = Buffer.from(normalizePairingCode(received));
  return left.length === right.length && timingSafeEqual(left, right);
}

export class FileNodeAllowlist implements NodeAllowlist {
  readonly #filePath: string;

  constructor(remoteRoot = defaultRemoteRoot()) {
    this.#filePath = join(remoteRoot, ALLOWLIST_FILE);
  }

  async has(nodeId: string): Promise<boolean> {
    return (await this.#read()).includes(nodeId);
  }

  async add(nodeId: string): Promise<void> {
    const nodeIds = new Set(await this.#read());
    nodeIds.add(nodeId);
    await mkdir(dirname(this.#filePath), { recursive: true });
    await writeFile(this.#filePath, `${JSON.stringify([...nodeIds].sort(), null, 2)}\n`, {
      mode: 0o600,
    });
    await chmod(this.#filePath, 0o600);
  }

  async #read(): Promise<string[]> {
    try {
      const raw = await readFile(this.#filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }
}

export class CachedNodeAllowlist implements NodeAllowlist {
  readonly #delegate: NodeAllowlist;
  readonly #cache = new Map<string, boolean>();

  constructor(delegate: NodeAllowlist) {
    this.#delegate = delegate;
  }

  async has(nodeId: string): Promise<boolean> {
    const cached = this.#cache.get(nodeId);
    if (cached !== undefined) {
      return cached;
    }
    const result = await this.#delegate.has(nodeId);
    this.#cache.set(nodeId, result);
    return result;
  }

  async add(nodeId: string): Promise<void> {
    await this.#delegate.add(nodeId);
    this.#cache.set(nodeId, true);
  }
}

export async function authorizeRemoteEnvelope(
  request: AuthorizationRequest,
): Promise<AuthorizationResult> {
  if (await request.allowlist.has(request.nodeId)) {
    return { accepted: true, mode: "paired" };
  }

  if (isPairingEnvelope(request.envelope)) {
    if (
      !request.pairingCode ||
      !verifyPairingCode(request.pairingCode, request.envelope.payload.code)
    ) {
      return { accepted: false, reason: "invalid pairing code" };
    }

    await request.allowlist.add(request.nodeId);
    return { accepted: true, mode: "pairing" };
  }

  return { accepted: false, reason: "node is not paired" };
}

export function renderPairingTicket(input: {
  ticket: string;
  pairingCode: string;
  generateQr?: QrGenerator;
}): string {
  let qr = "";
  const generateQr = input.generateQr ?? generateTerminalQr;
  generateQr(input.ticket, (generated) => {
    qr = generated;
  });
  if (qr === "") {
    throw new Error("qrcode-terminal did not synchronously render ticket QR");
  }

  return [
    "Pi remote endpoint ticket QR",
    qr,
    `Ticket: ${input.ticket}`,
    `Enter pairing code: ${input.pairingCode}`,
  ].join("\n");
}

function drawPairingCodeValue(randomBytes: RandomBytes): number {
  const bytes = randomBytes(3);
  if (bytes.length !== 3) {
    throw new Error(`pairing code generation expected 3 random bytes, received ${bytes.length}`);
  }

  return (bytes[0] << 16) | (bytes[1] << 8) | bytes[2];
}

function generateTerminalQr(ticket: string, onOutput: (output: string) => void): void {
  qrcode.generate(ticket, { small: true }, onOutput);
}

function cryptoRandomBytes(size: number): Uint8Array {
  return randomBytes(size);
}

function normalizePairingCode(code: string): string {
  return code.replace(/[^0-9]/gu, "");
}

function isPairingEnvelope(
  envelope: Envelope,
): envelope is Envelope & { payload: { code: string } } {
  return (
    envelope.sessionId === null &&
    envelope.type === "pair" &&
    typeof envelope.payload === "object" &&
    envelope.payload !== null &&
    "code" in envelope.payload &&
    typeof envelope.payload.code === "string"
  );
}
