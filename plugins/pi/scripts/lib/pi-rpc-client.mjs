import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export class PiRpcClient {
  constructor(options) {
    this.command = options.command;
    this.args = options.args ?? [];
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    this.terminated = false;
    this.protocolError = null;
  }

  start() {
    this.process = spawn(this.command, this.args, { stdio: ["pipe", "pipe", "pipe"] });
    attachJsonlReader(this.process.stdout, (line) => this.handleLine(line));
    this.process.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString();
    });
    this.process.once("exit", () => {
      this.terminated = true;
    });
  }

  async request(command) {
    if (!this.process) this.start();
    if (this.protocolError) throw this.protocolError;
    const id = `req-${this.nextId++}`;
    const payload = JSON.stringify({ id, ...command }) + "\n";
    const responsePromise = this.waitForResponse(id, command.type);
    this.process.stdin.write(payload);
    return responsePromise;
  }

  async terminate() {
    if (!this.process || this.process.exitCode !== null) return true;
    this.process.kill("SIGTERM");
    return this.waitForExit(1_000);
  }

  handleLine(line) {
    if (line.length === 0) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      this.failPending(new Error(`Malformed Pi RPC JSON: ${cause}`));
      return;
    }
    if (message.type !== "response" || typeof message.id !== "string") return;
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    waiter.resolve(message);
  }

  failPending(error) {
    this.protocolError = error;
    for (const [id, waiter] of this.pending) {
      this.pending.delete(id);
      waiter.reject(error);
    }
  }

  waitForResponse(id, commandType) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for Pi RPC ${commandType} response`));
      }, this.timeoutMs);
      this.pending.set(id, {
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      });
    });
  }

  waitForExit(timeoutMs) {
    return new Promise((resolve) => {
      if (!this.process || this.process.exitCode !== null) {
        resolve(true);
        return;
      }
      const timer = setTimeout(() => {
        this.process.kill("SIGKILL");
        resolve(false);
      }, timeoutMs);
      this.process.once("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}

export function attachJsonlReader(stream, onLine) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    buffer = emitCompleteLines(buffer, onLine);
  });
  stream.on("end", () => {
    buffer += decoder.end();
    if (buffer.length > 0) onLine(stripCarriageReturn(buffer));
  });
}

function emitCompleteLines(buffer, onLine) {
  let remaining = buffer;
  while (true) {
    const newlineIndex = remaining.indexOf("\n");
    if (newlineIndex === -1) return remaining;
    onLine(stripCarriageReturn(remaining.slice(0, newlineIndex)));
    remaining = remaining.slice(newlineIndex + 1);
  }
}

function stripCarriageReturn(line) {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}
