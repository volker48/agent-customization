#!/usr/bin/env node
import { createInterface } from "node:readline";
/** @param {unknown} value */
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
/** @type {string | undefined} */
let selected;
createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  /** @param {unknown} data */
  const reply = (data) =>
    emit({ type: "response", id: command.id, command: command.type, success: true, data });
  if (command.type === "get_available_models")
    reply({
      models: [
        "ok",
        "error",
        "retry",
        "hang",
        "malformed",
        "empty",
        "mixed",
        "length",
        "muse-spark-1.3-contributor-free",
        "gemini-3.8-flash",
      ].map((id) => ({ provider: "opencode", id })),
    });
  else if (command.type === "set_model") {
    selected = command.modelId;
    reply({ provider: command.provider, id: selected });
  } else if (command.type === "set_thinking_level") reply({ level: command.level });
  else if (command.type === "prompt") {
    const args = process.argv.slice(2);
    if (
      !args.includes("--no-extensions") ||
      args[args.indexOf("--tools") + 1] !== "read,grep,find,ls"
    )
      throw new Error("Unsafe review tools");
    reply({});
    if (selected === "hang") return;
    if (selected === "malformed") {
      process.stdout.write("not JSON\n");
      return;
    }
    /** @param {string} reason @param {string} text */
    const message = (reason, text) =>
      emit({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: reason,
          errorMessage: reason === "error" ? "provider unavailable" : undefined,
          content:
            selected === "mixed"
              ? [
                  { type: "text", text: "" },
                  { type: "text", text },
                ]
              : [{ type: "text", text }],
        },
      });
    if (selected === "retry") {
      message("error", "");
      emit({ type: "agent_end", willRetry: true });
    }
    setTimeout(() => {
      message(
        selected === "error" ? "error" : selected === "length" ? "length" : "stop",
        selected === "empty" ? "" : "Review\u2028finding\u2029preserved",
      );
      emit({ type: "agent_end", willRetry: false });
      emit({ type: "agent_settled" });
    }, 10);
  }
});
