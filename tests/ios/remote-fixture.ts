import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startRemoteDaemon, type RemoteDaemon } from "../../pi-extensions/remote/daemon.js";
import { connectIpcExtension, type IpcExtensionClient } from "../../pi-extensions/remote/ipc.js";
import {
  projectSessionState,
  type SessionState,
} from "../../pi-extensions/remote/session-state.js";
import {
  projectTranscriptEvent,
  type TranscriptEntry,
} from "../../pi-extensions/remote/transcript-projection.js";

/** A real daemon/iroh connection with a scripted execution host instead of an LLM. */
export class RemoteFixture {
  readonly sessions = new Map<string, IpcExtensionClient>();
  readonly prompts: string[] = [];
  aborts = 0;
  capsuleFails = false;
  historyText = "Ready to help.";
  #loops: Promise<void>[] = [];
  #closing = false;
  #state: SessionState = {
    model: { provider: "test", id: "alpha", name: "Alpha" },
    models: [
      { provider: "test", id: "alpha", name: "Alpha" },
      { provider: "test", id: "beta", name: "Beta" },
    ],
    thinkingLevel: "medium",
    thinkingLevels: ["off", "low", "medium", "high"],
  };

  private constructor(
    readonly root: string,
    readonly daemon: RemoteDaemon,
  ) {}

  static async start(): Promise<RemoteFixture> {
    const root = await mkdtemp(join(tmpdir(), "pi-ios-e2e-"));
    let daemon: RemoteDaemon | undefined;
    try {
      daemon = await startRemoteDaemon({ remoteRoot: root, pairingCode: "123-456" });
      const fixture = new RemoteFixture(root, daemon);
      await fixture.armPairing();
      return fixture;
    } catch (error) {
      await daemon?.close();
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  async armPairing(): Promise<void> {
    const control = await connectIpcExtension(this.daemon.socketPath, {
      sessionId: "pairing-control",
      name: "Pairing control",
      cwd: "/tmp",
    });
    try {
      await control.send({ sessionId: null, type: "pairing_info", payload: {} });
      const response = await control.readNext();
      if (response.type !== "pairing_info") throw new Error("Expected pairing info");
    } finally {
      await control.close();
      await this.daemon.ipc.waitForSessionEnd("pairing-control");
    }
  }

  async addSession(id = "session-1", name = "E2E Session", history = true): Promise<void> {
    const client = await connectIpcExtension(this.daemon.socketPath, {
      sessionId: id,
      name,
      cwd: "/Users/test/project",
      capabilities: ["context-capsule-v1"],
    });
    this.sessions.set(id, client);
    await this.daemon.ipc.waitForSession(id);
    // Observe rejections immediately; close() still awaits every loop and propagates errors.
    const loop = this.serveSession(id, client, history);
    void loop.catch(() => {});
    this.#loops.push(loop);
  }

  async endSession(id = "session-1"): Promise<void> {
    const client = this.sessions.get(id);
    if (!client) throw new Error(`No fixture session ${id}`);
    await client.send({ sessionId: id, type: "session_shutdown", payload: {} });
    await this.daemon.ipc.waitForSessionEnd(id);
  }

  async emit(entry: TranscriptEntry, id = "session-1"): Promise<void> {
    const client = this.sessions.get(id);
    if (!client) throw new Error(`No fixture session ${id}`);
    await client.send({ sessionId: id, type: "event", payload: entry });
  }

  async close(): Promise<void> {
    this.#closing = true;
    try {
      for (const client of this.sessions.values()) await client.close();
      await Promise.all(this.#loops);
    } finally {
      await this.daemon.close();
      await rm(this.root, { recursive: true, force: true });
    }
  }

  private async serveSession(
    id: string,
    client: IpcExtensionClient,
    history: boolean,
  ): Promise<void> {
    const state = structuredClone(this.#state);
    try {
      while (!this.#closing) {
        const frame = await client.readNext();
        switch (frame.type) {
          case "attach":
            if (history) {
              await this.emit(transcript("user", "Review the project", "backfill"), id);
              await this.emit(transcript("assistant", this.historyText, "backfill"), id);
            }
            await this.emit(projectSessionState(state), id);
            break;
          case "prompt": {
            const text = stringField(frame.payload, "text");
            this.prompts.push(text);
            if (text.startsWith("/model ")) {
              const model = state.models.find(
                (item) => `${item.provider}/${item.id}` === text.slice(7),
              );
              if (!model) throw new Error(`Unknown fixture model ${text}`);
              state.model = model;
              await this.emit(projectSessionState(state), id);
            } else if (text.startsWith("/thinking ")) {
              const level = state.thinkingLevels.find((item) => item === text.slice(10));
              if (!level) throw new Error(`Unknown fixture thinking level ${text}`);
              state.thinkingLevel = level;
              await this.emit(projectSessionState(state), id);
            } else {
              await this.emit(
                projectTranscriptEvent({
                  type: "message_end",
                  message: { role: "user", content: text },
                }),
                id,
              );
              await this.emit(projectTranscriptEvent({ type: "turn_start" }), id);
              await this.emit(
                projectTranscriptEvent({
                  type: "message_update",
                  message: { role: "assistant", content: "Working on your request" },
                }),
                id,
              );
            }
            break;
          }
          case "abort":
            this.aborts += 1;
            await this.emit(
              projectTranscriptEvent({
                type: "message_end",
                message: { role: "assistant", content: "Stopped on request." },
              }),
              id,
            );
            await this.emit(projectTranscriptEvent({ type: "agent_end" }), id);
            break;
          case "capsule":
            await client.send({
              sessionId: id,
              type: "capsule",
              payload: {
                requestId: stringField(frame.payload, "requestId"),
                supported: true,
                ...(this.capsuleFails
                  ? { error: { code: "unavailable", message: "Capsule is unavailable." } }
                  : {
                      capsule: {
                        capsuleId: "e2e-capsule",
                        schemaVersion: 1,
                        revision: 1,
                        objective: "Verify remote control",
                        constraints: ["Keep execution on the laptop"],
                        decisions: [{ statement: "Use the real daemon", status: "confirmed" }],
                        validation: [
                          {
                            command: "pnpm test:ios:e2e",
                            outcome: "passed",
                            evidence: "Simulator",
                          },
                        ],
                        blockers: [],
                        risks: [],
                        nextAction: "Review the test results",
                        redactions: [{ category: "secret", count: 1 }],
                        truncated: false,
                        maxPayloadBytes: 32768,
                      },
                    }),
              },
            });
            break;
        }
      }
    } catch (error) {
      if (!this.#closing) throw error;
    }
  }
}

export function transcript(role: string, text: string, status: string): TranscriptEntry {
  return { role, text, status, toolName: null, truncatedOutput: false };
}

function stringField(payload: unknown, key: string): string {
  if (typeof payload !== "object" || payload === null || !(key in payload)) {
    throw new Error(`Fixture frame missing ${key}`);
  }
  const value: unknown = Reflect.get(payload, key);
  if (typeof value !== "string") throw new Error(`Fixture frame has invalid ${key}`);
  return value;
}
