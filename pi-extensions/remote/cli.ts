#!/usr/bin/env -S tsx

import { stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";

import { defaultRemoteRoot, FileNodeAllowlist } from "./authorization.js";
import type { IpcEnvelope } from "./ipc.js";

const DAEMON_SOCKET_FILE = "daemon.sock";

type SessionSummary = {
  sessionId: string;
  name: string;
  cwd: string;
};

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "status") {
    await printStatus(socketPath());
    return;
  }
  if (command === "stop") {
    await stopDaemon(socketPath());
    return;
  }

  console.error("Usage: pi-remote status|stop");
  process.exitCode = 1;
}

async function printStatus(path: string): Promise<void> {
  try {
    const response = await requestDaemon(path, { sessionId: null, type: "list", payload: {} });
    console.log(formatStatus(response.payload, await pairedDeviceCount(dirname(path))));
  } catch (error) {
    if (!isMissingSocket(error)) {
      throw error;
    }
    console.log("Remote daemon is not running");
  }
}

async function stopDaemon(path: string): Promise<void> {
  try {
    await requestDaemon(path, { sessionId: null, type: "daemon_stop", payload: {} });
    await waitForSocketRemoval(path);
    console.log("Remote daemon stop requested");
  } catch (error) {
    if (!isMissingSocket(error)) {
      throw error;
    }
    console.log("Remote daemon is not running");
  }
}

function formatStatus(payload: unknown, pairedDevices: number): string {
  const sessions = Array.isArray(payload) ? payload.flatMap(sessionSummary) : [];
  return [
    "Remote daemon is running",
    `Sessions: ${sessions.length}`,
    ...sessions.map((session) => `- ${session.sessionId} ${session.name} (${session.cwd})`),
    `Paired devices: ${pairedDevices}`,
  ].join("\n");
}

function sessionSummary(value: unknown): SessionSummary[] {
  if (
    typeof value !== "object" ||
    value === null ||
    !("sessionId" in value) ||
    !("name" in value) ||
    !("cwd" in value) ||
    typeof value.sessionId !== "string" ||
    typeof value.name !== "string" ||
    typeof value.cwd !== "string"
  ) {
    return [];
  }
  return [{ sessionId: value.sessionId, name: value.name, cwd: value.cwd }];
}

async function pairedDeviceCount(remoteRoot: string): Promise<number> {
  return new FileNodeAllowlist(remoteRoot).count();
}

function requestDaemon(path: string, envelope: IpcEnvelope): Promise<IpcEnvelope> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let buffered = "";
    let settled = false;
    let timeout: NodeJS.Timeout;
    const cleanup = () => {
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
    };
    const fail = (error: Error) => {
      if (!settled) {
        cleanup();
        reject(error);
      }
    };
    const succeed = (response: IpcEnvelope) => {
      if (!settled) {
        cleanup();
        resolve(response);
      }
    };
    timeout = setTimeout(() => fail(new Error("remote daemon request timed out")), 2_000);

    socket.once("connect", () => socket.write(`${JSON.stringify(envelope)}\n`));
    socket.once("error", fail);
    socket.once("close", () => fail(new Error("remote daemon closed before responding")));
    socket.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      const newline = buffered.indexOf("\n");
      if (newline === -1) {
        return;
      }
      try {
        succeed(JSON.parse(buffered.slice(0, newline)) as IpcEnvelope);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

async function waitForSocketRemoval(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (!(await socketExists(path))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("remote daemon socket was not removed after stop");
}

async function socketExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function socketPath(): string {
  return join(process.env.PI_REMOTE_ROOT ?? defaultRemoteRoot(), DAEMON_SOCKET_FILE);
}

function isMissingSocket(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ECONNREFUSED" || error.code === "ENOTSOCK")
  );
}

await main();
