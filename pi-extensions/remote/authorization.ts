import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { Envelope } from "./protocol.js";

type RandomBytes = (size: number) => Uint8Array;
type QrGenerator = (ticket: string, onOutput: (output: string) => void) => void;
type QrCodeTerminal = {
  generate(ticket: string, options: { small: true }, onOutput: (output: string) => void): void;
};

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
  pairingWindow?: PairingWindow;
};

const PAIRING_CODE_MODULUS = 1_000_000;
const PAIRING_CODE_SAMPLE_SPACE = 0x1_00_00_00;
const PAIRING_CODE_UNBIASED_LIMIT =
  Math.floor(PAIRING_CODE_SAMPLE_SPACE / PAIRING_CODE_MODULUS) * PAIRING_CODE_MODULUS;
export const DEFAULT_PAIRING_WINDOW_MS = 5 * 60 * 1000;
const MAX_PAIRING_ATTEMPTS = 5;

const ALLOWLIST_FILE = "allowed-node-ids.json";
const require = createRequire(import.meta.url);

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

export class PairingWindow {
  #code: string | undefined;
  #expiresAt = 0;
  #failures = 0;

  constructor(
    readonly createCode: () => string = createPairingCode,
    readonly now: () => number = Date.now,
    readonly ttlMs: number = DEFAULT_PAIRING_WINDOW_MS,
  ) {}

  arm(): string {
    this.#code = this.createCode();
    this.#expiresAt = this.now() + this.ttlMs;
    this.#failures = 0;
    return this.#code;
  }

  verify(receivedCode: string): boolean {
    const code = this.currentCode();
    if (!code || !verifyPairingCode(code, receivedCode)) {
      if (code) {
        this.#failures += 1;
        if (this.#failures >= MAX_PAIRING_ATTEMPTS) {
          this.close();
        }
      }
      return false;
    }
    this.close();
    return true;
  }

  currentCode(): string | undefined {
    if (this.#code && this.now() <= this.#expiresAt) {
      return this.#code;
    }
    this.close();
    return undefined;
  }

  close(): void {
    this.#code = undefined;
    this.#expiresAt = 0;
    this.#failures = 0;
  }
}

export class FileNodeAllowlist implements NodeAllowlist {
  readonly #filePath: string;
  #writeChain: Promise<void> = Promise.resolve();

  constructor(remoteRoot = defaultRemoteRoot()) {
    this.#filePath = join(remoteRoot, ALLOWLIST_FILE);
  }

  async has(nodeId: string): Promise<boolean> {
    return (await this.#read()).includes(nodeId);
  }

  add(nodeId: string): Promise<void> {
    const next = this.#writeChain.then(() => this.#addLocked(nodeId));
    this.#writeChain = next.catch(() => undefined);
    return next;
  }

  async #addLocked(nodeId: string): Promise<void> {
    const nodeIds = new Set(await this.#read());
    nodeIds.add(nodeId);
    await mkdir(dirname(this.#filePath), { recursive: true });
    const tmpPath = `${this.#filePath}.${randomUUID()}.tmp`;
    const contents = `${JSON.stringify([...nodeIds].sort(), null, 2)}\n`;
    await writeFile(tmpPath, contents, { mode: 0o600 });
    await rename(tmpPath, this.#filePath);
    await chmod(this.#filePath, 0o600);
  }

  async count(): Promise<number> {
    return (await this.#read()).length;
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
    if (!request.pairingWindow?.verify(request.envelope.payload.code)) {
      return { accepted: false, reason: "invalid or expired pairing code" };
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
  const qrcode = requireQrCodeTerminal();
  qrcode.generate(ticket, { small: true }, onOutput);
}

function requireQrCodeTerminal(): QrCodeTerminal {
  try {
    return require("qrcode-terminal") as QrCodeTerminal;
  } catch (error) {
    if (isMissingQrCodeTerminal(error)) {
      throw new Error(
        'Missing runtime dependency "qrcode-terminal". Run `pnpm install` for this package.',
        { cause: error },
      );
    }
    throw error;
  }
}

function isMissingQrCodeTerminal(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "MODULE_NOT_FOUND";
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
