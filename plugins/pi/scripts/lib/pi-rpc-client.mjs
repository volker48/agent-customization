import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export class PiRpcClient {
  constructor(options) {
    this.command = options.command;
    this.args = options.args ?? [];
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.stderrMaxBytes = options.stderrMaxBytes ?? 64 * 1024;
    this.nextId = 1;
    this.pending = new Map();
    this.eventWaiters = [];
    this.eventListeners = [];
    this.stderr = "";
    this.closed = false;
    this.terminated = false;
    this.protocolError = null;
    this.detached = options.detached === true;
  }

  start() {
    this.process = spawn(this.command, this.args, {
      detached: this.detached,
      stdio: ["pipe", "pipe", "pipe"],
    });
    attachJsonlReader(this.process.stdout, (line) => this.handleLine(line));
    this.process.stderr.on("data", (chunk) => {
      this.appendStderr(chunk.toString());
    });
    this.process.once("close", () => {
      this.closed = true;
      this.terminated = true;
      this.failPending(new Error("Pi RPC process exited before completing the request"));
    });
  }

  async request(command, options = {}) {
    if (!this.process) this.start();
    if (this.protocolError) throw this.protocolError;
    const id = `req-${this.nextId++}`;
    const payload = JSON.stringify({ id, ...command }) + "\n";
    const responsePromise = this.waitForResponse(
      id,
      command.type,
      options.timeoutMs ?? this.timeoutMs,
    );
    this.process.stdin.write(payload);
    return responsePromise;
  }

  waitForEvent(type, options = {}) {
    return this.waitForEventHandle(type, options).promise;
  }

  waitForEventHandle(type, options = {}) {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const predicate = options.predicate ?? (() => true);
    let waiter = null;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeEventWaiter(waiter);
        reject(new Error(this.timeoutMessage(`Timed out waiting for Pi RPC ${type} event`)));
      }, timeoutMs);
      waiter = { predicate, reject, resolve, timer, type };
      this.eventWaiters.push(waiter);
    });
    return {
      cancel: () => {
        if (!waiter) return;
        this.removeEventWaiter(waiter);
        clearTimeout(waiter.timer);
      },
      promise,
    };
  }

  async abort() {
    return this.request({ type: "abort" });
  }

  // Persistent subscription: buffers matching events so none are dropped between
  // awaits (one-shot waiters miss events that arrive before they are armed).
  // next() resolves the oldest buffered event, or null on timeout.
  eventQueue(types) {
    const listener = { error: null, notify: null, queue: [], types: new Set(types) };
    this.eventListeners.push(listener);
    const take = (resolve, reject) => {
      if (listener.error) {
        reject(listener.error);
        return true;
      }
      if (listener.queue.length > 0) {
        resolve(listener.queue.shift());
        return true;
      }
      return false;
    };
    return {
      close: () => {
        this.eventListeners = this.eventListeners.filter((candidate) => candidate !== listener);
      },
      next: (timeoutMs) =>
        new Promise((resolve, reject) => {
          if (take(resolve, reject)) return;
          const timer = setTimeout(() => {
            listener.notify = null;
            resolve(null);
          }, timeoutMs);
          listener.notify = () => {
            if (!take(resolve, reject)) return;
            clearTimeout(timer);
            listener.notify = null;
          };
        }),
    };
  }

  async terminate(timeoutMs = 10_000) {
    if (!this.process || this.closed) return true;
    if (this.process.exitCode === null) this.process.kill("SIGTERM");
    return this.waitForExit(timeoutMs);
  }

  appendStderr(text) {
    if (this.stderrMaxBytes <= 0) {
      this.stderr = "";
      return;
    }
    this.stderr = `${this.stderr}${text}`.slice(-this.stderrMaxBytes);
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
    if (message.type === "extension_ui_request" && typeof message.id === "string") {
      this.sendExtensionUICancellation(message.id);
      return;
    }
    if (message.type !== "response" || typeof message.id !== "string") {
      this.dispatchToListeners(message);
      this.resolveEvent(message);
      return;
    }
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
    for (const waiter of this.eventWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    for (const listener of this.eventListeners) {
      listener.error = error;
      listener.notify?.();
    }
  }

  dispatchToListeners(message) {
    for (const listener of this.eventListeners) {
      if (!listener.types.has(message.type)) continue;
      listener.queue.push(message);
      listener.notify?.();
    }
  }

  resolveEvent(message) {
    const waiter = this.eventWaiters.find(
      (candidate) => candidate.type === message.type && candidate.predicate(message),
    );
    if (!waiter) return;
    this.removeEventWaiter(waiter);
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  }

  removeEventWaiter(waiter) {
    this.eventWaiters = this.eventWaiters.filter((candidate) => candidate !== waiter);
  }

  timeoutMessage(message) {
    const stderr = this.stderr.trim();
    return stderr ? `${message}. Pi stderr: ${stderr.slice(-400)}` : message;
  }

  sendExtensionUICancellation(id) {
    if (!this.process?.stdin?.writable) return;
    const payload = JSON.stringify({ type: "extension_ui_response", id, cancelled: true }) + "\n";
    this.process.stdin.write(payload);
  }

  waitForResponse(id, commandType, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(this.timeoutMessage(`Timed out waiting for Pi RPC ${commandType} response`)),
        );
      }, timeoutMs);
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
      if (!this.process || this.closed) {
        resolve(true);
        return;
      }
      const timer = setTimeout(() => {
        this.process.kill("SIGKILL");
        resolve(false);
      }, timeoutMs);
      this.process.once("close", () => {
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
