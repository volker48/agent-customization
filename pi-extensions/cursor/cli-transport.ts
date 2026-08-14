import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

import { createOutput, finishBufferedOutput, pushError } from "./output.js";
import { buildPrompt, hasCursorHistory } from "./prompt.js";
import { createToolEntry } from "./tool-entry.js";
import type { CursorModelInfo, CursorStream } from "./types.js";

const execFileAsync = promisify(execFile);

export interface CliTransport {
  discoverModels(): Promise<CursorModelInfo[]>;
  stream: CursorStream;
  reset(): void;
}

export function createCliTransport(binary: string): CliTransport {
  let activeCursorChatId: string | undefined;

  async function discoverModels(): Promise<CursorModelInfo[]> {
    try {
      const { stdout } = await execFileAsync(binary, ["models"], { timeout: 15000 });
      const ids: CursorModelInfo[] = [];
      for (const rawLine of stdout.split("\n")) {
        const line = rawLine.trim();
        if (!line) continue;
        const token = line.split(/\s+/)[0].replace(/^[*>-]+\s*/, "");
        if (/^[a-z0-9][a-z0-9.\-_/]*$/i.test(token) && /[a-z]/i.test(token)) {
          ids.push({ id: token, name: token });
        }
      }
      return ids;
    } catch {
      return [];
    }
  }

  const stream: CursorStream = (model, context, options, onToolActivity) => {
    const eventStream = createAssistantMessageEventStream();

    (async () => {
      const output = createOutput(model);
      if (options?.signal?.aborted) {
        pushError(eventStream, output, new Error("Aborted"), true);
        return;
      }

      const resume = hasCursorHistory(context) ? activeCursorChatId : undefined;
      const prompt = buildPrompt(
        context,
        !resume,
        "[attached image unavailable over Cursor CLI transport]",
      );

      const args = [
        "--print",
        "--output-format",
        "stream-json",
        "--stream-partial-output",
        "--model",
        model.id,
        "--workspace",
        process.cwd(),
        "--trust",
      ];
      if (process.env.PI_CURSOR_NO_FORCE !== "1") args.push("--force");
      if (resume) args.push("--resume", resume);
      args.push(prompt);

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(binary, args, {
          cwd: process.cwd(),
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        pushError(eventStream, output, error, false);
        return;
      }

      const onAbort = () => child.kill("SIGTERM");
      if (options?.signal?.aborted) onAbort();
      else options?.signal?.addEventListener("abort", onAbort, { once: true });

      try {
        output.content.push({ type: "text", text: "" });
        const contentIndex = 0;
        let textOpen = false;
        let buffer = "";
        let stderrText = "";
        let sawResult = false;

        const pushDelta = (delta: string) => {
          if (!delta) return;
          textOpen = true;
          const block = output.content[contentIndex] as { type: "text"; text: string };
          block.text += delta;
        };

        child.stderr!.on("data", (chunk: Buffer) => {
          stderrText += chunk.toString();
        });

        const exitPromise = new Promise<number | null>((resolve) => child.on("close", resolve));

        await new Promise<void>((resolve, reject) => {
          child.on("error", reject);
          child.stdout!.on("data", (chunk: Buffer) => {
            buffer += chunk.toString();
            let newlineIndex: number;
            while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, newlineIndex).trim();
              buffer = buffer.slice(newlineIndex + 1);
              if (!line) continue;

              let event: Record<string, never>;
              try {
                event = JSON.parse(line);
              } catch {
                continue;
              }

              switch (event.type) {
                case "system":
                  if (event.subtype === "init" && typeof event.session_id === "string") {
                    activeCursorChatId = event.session_id;
                  }
                  break;

                case "assistant": {
                  // Only streaming deltas carry new text: timestamp_ms is present and
                  // model_call_id is absent. Other assistant events are duplicate flushes.
                  const isDelta =
                    typeof event.timestamp_ms === "number" && event.model_call_id === undefined;
                  if (!isDelta) break;
                  const content =
                    (event.message as { content?: Array<{ type?: string; text?: string }> })
                      ?.content ?? [];
                  for (const block of content) {
                    if (block?.type === "text" && block.text) pushDelta(block.text);
                  }
                  break;
                }

                case "tool_call":
                  if (event.subtype === "completed") {
                    onToolActivity(createToolEntry(event.tool_call));
                  }
                  break;

                case "result": {
                  sawResult = true;
                  if (event.is_error) {
                    const message =
                      typeof event.result === "string" && event.result
                        ? event.result
                        : stderrText.trim() || "cursor-agent reported an error";
                    reject(new Error(message));
                    return;
                  }
                  break;
                }
              }
            }
          });
          child.stdout!.on("end", () => resolve());
        });

        const exitCode = await exitPromise;

        if (options?.signal?.aborted) {
          throw Object.assign(new Error("Aborted"), { aborted: true });
        }
        if (!sawResult || (exitCode !== 0 && exitCode !== null)) {
          const detail = stderrText.trim();
          throw new Error(
            `cursor-agent exited with code ${exitCode ?? "unknown"}${detail ? `: ${detail}` : ""}. ` +
              `Check auth with 'cursor-agent status' (or run /cursor-status).`,
          );
        }

        if (!textOpen) output.content.pop();

        output.stopReason = "stop";
        output.errorMessage = undefined;
        finishBufferedOutput(eventStream, output);
      } catch (error) {
        pushError(eventStream, output, error, options?.signal?.aborted ?? false);
      } finally {
        options?.signal?.removeEventListener("abort", onAbort);
      }
    })();

    return eventStream;
  };

  return {
    discoverModels,
    stream,
    reset() {
      activeCursorChatId = undefined;
    },
  };
}
