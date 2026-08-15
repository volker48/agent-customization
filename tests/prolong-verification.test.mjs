import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  assertNoExtensionErrors,
  assertNoToolActivity,
  assertSuccessfulAgentEnd,
  findSuccessfulLookup,
  parseRpcFrame,
  parseRpcTrailingFrame,
} from "../scripts/verify-prolong-extension.mjs";

const execFileAsync = promisify(execFile);
const logPath = "/runtime/pi-prolong/session/active-branch.jsonl";
const nonce = "PROLONG-0123456789abcdef";

function messageEntry(id, message) {
  return { type: "message", id, message };
}

function readCall(path = logPath, id = "lookup-1") {
  return messageEntry("assistant-tool", {
    role: "assistant",
    content: [{ type: "toolCall", id, name: "read", arguments: { path } }],
  });
}

function readResult({ id = "lookup-1", isError = false, text = nonce, toolName = "read" } = {}) {
  return messageEntry("tool-result", {
    role: "toolResult",
    toolCallId: id,
    toolName,
    isError,
    content: [{ type: "text", text }],
  });
}

function bashCall(command, id = "lookup-1") {
  return messageEntry("assistant-tool", {
    role: "assistant",
    content: [{ type: "toolCall", id, name: "bash", arguments: { command } }],
  });
}

describe("PRO-LONG verification acceptance helpers", () => {
  it("accepts only an exact post-compaction log path with a successful nonce-bearing result", () => {
    expect(findSuccessfulLookup([readCall(), readResult()], logPath, nonce)).toMatchObject({
      call: { name: "read" },
      result: { isError: false },
    });

    expect(() =>
      findSuccessfulLookup([readCall(`${logPath}.missing`), readResult()], logPath, nonce),
    ).toThrow("exact PRO-LONG log");
    expect(() =>
      findSuccessfulLookup([readCall(), readResult({ isError: true })], logPath, nonce),
    ).toThrow("successful tool result");
    expect(() =>
      findSuccessfulLookup([readCall(), readResult({ toolName: "bash" })], logPath, nonce),
    ).toThrow("successful tool result");
    expect(() =>
      findSuccessfulLookup([readCall(), readResult({ text: "no match" })], logPath, nonce),
    ).toThrow("nonce");
    expect(() =>
      findSuccessfulLookup([bashCall(`echo ${logPath}`), readResult()], logPath, nonce),
    ).toThrow("exact PRO-LONG log");
    expect(() =>
      findSuccessfulLookup([bashCall(`rg 'PROLONG-' ${logPath}`), readResult()], logPath, nonce),
    ).toThrow("exact PRO-LONG log");
    expect(() =>
      findSuccessfulLookup([bashCall(`jq --null-input ${logPath}`), readResult()], logPath, nonce),
    ).toThrow("exact PRO-LONG log");
    expect(() =>
      findSuccessfulLookup([bashCall(`grep -n ${logPath}`), readResult()], logPath, nonce),
    ).toThrow("exact PRO-LONG log");
    expect(
      findSuccessfulLookup(
        [
          readCall(logPath, "failed"),
          readResult({ id: "failed", isError: true }),
          readCall(logPath, "successful"),
          readResult({ id: "successful" }),
        ],
        logPath,
        nonce,
      ),
    ).toMatchObject({ call: { id: "successful", name: "read" }, result: { isError: false } });
  });

  it("requires successful terminal model stops and an exact tool-free ACK when requested", () => {
    const ack = {
      type: "agent_end",
      willRetry: false,
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "ACK" }],
          stopReason: "stop",
        },
      ],
    };
    expect(() =>
      assertSuccessfulAgentEnd(ack, { expectedText: "ACK", forbidTools: true }),
    ).not.toThrow();

    for (const stopReason of ["error", "aborted", "length"]) {
      expect(() =>
        assertSuccessfulAgentEnd({
          ...ack,
          messages: [{ ...ack.messages[0], stopReason }],
        }),
      ).toThrow("unsuccessful stop reason");
    }
    expect(() =>
      assertSuccessfulAgentEnd(
        {
          ...ack,
          messages: [
            {
              ...ack.messages[0],
              content: [{ type: "toolCall", id: "tool", name: "read", arguments: {} }],
            },
          ],
        },
        { expectedText: "ACK", forbidTools: true },
      ),
    ).toThrow("tool-free");
    expect(() =>
      assertSuccessfulAgentEnd(
        {
          ...ack,
          messages: [{ ...ack.messages[0], stopReason: "toolUse" }, ack.messages[0]],
        },
        { expectedText: "ACK", forbidTools: true },
      ),
    ).toThrow("tool-free");
    expect(() => assertNoToolActivity([{ type: "tool_execution_start" }])).toThrow("tool-free");
    expect(() => assertNoToolActivity([{ type: "message_update" }])).not.toThrow();
    expect(() =>
      assertSuccessfulAgentEnd(
        {
          ...ack,
          messages: [
            { ...ack.messages[0], content: [{ type: "text", text: nonce }] },
            { ...ack.messages[0], content: [] },
          ],
        },
        { expectedText: nonce },
      ),
    ).toThrow("exactly equal");
    expect(() =>
      assertSuccessfulAgentEnd(
        {
          ...ack,
          messages: [{ ...ack.messages[0], content: [{ type: "text", text: " ACK " }] }],
        },
        { expectedText: "ACK" },
      ),
    ).toThrow("exactly equal");
  });

  it("rejects malformed RPC frames and extension errors", () => {
    expect(parseRpcFrame('{"type":"agent_settled"}')).toEqual({ type: "agent_settled" });
    expect(() => parseRpcFrame("not-json")).toThrow("Malformed Pi RPC frame");
    expect(parseRpcTrailingFrame('{"type":"agent_settled"}')).toEqual({
      type: "agent_settled",
    });
    expect(parseRpcTrailingFrame("\r")).toBeUndefined();
    expect(() => parseRpcTrailingFrame("trailing-garbage")).toThrow("Malformed Pi RPC frame");
    expect(() =>
      assertNoExtensionErrors([
        {
          type: "extension_error",
          extensionPath: "prolong.ts",
          event: "session_shutdown",
          error: "denied",
        },
      ]),
    ).toThrow("extension error");
  });

  it("reports a missing Pi binary through the verifier failure path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prolong-missing-pi-test-"));
    const verifierPath = fileURLToPath(
      new URL("../scripts/verify-prolong-extension.mjs", import.meta.url),
    );
    try {
      let failure;
      try {
        await execFileAsync(
          process.execPath,
          [
            verifierPath,
            "--pi-bin",
            join(directory, "missing-pi"),
            "--session",
            join(directory, "session.jsonl"),
            "--timeout-ms",
            "1000",
          ],
          { cwd: fileURLToPath(new URL("..", import.meta.url)) },
        );
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeDefined();
      expect(failure.stderr).toContain("[prolong-verify] FAILURE:");
      expect(failure.stderr).not.toContain("Unhandled 'error' event");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("validates trailing stdout only after child stdio closes", async () => {
    const source = await readFile(
      new URL("../scripts/verify-prolong-extension.mjs", import.meta.url),
      "utf8",
    );
    expect(source).toContain('this.child.once("close"');
    expect(source).not.toContain('this.child.once("exit"');
  });
});
