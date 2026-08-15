#!/usr/bin/env node

import { spawn, execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { ProlongMemory } from "../pi-extensions/lib/prolong-memory.ts";

const execFileAsync = promisify(execFile);
const DEFAULT_MODEL = "openai-codex/gpt-5.6-luna";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function parseArguments(argv) {
  const values = argv.filter((value) => value !== "--");
  const options = {
    benchmarkOnly: false,
    keepSession: false,
    model: DEFAULT_MODEL,
    thinking: "minimal",
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  function takeValue(name) {
    const index = values.indexOf(name);
    if (index < 0) return undefined;
    const value = values[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    values.splice(index, 2);
    return value;
  }

  function takeBoolean(name) {
    const index = values.indexOf(name);
    if (index < 0) return false;
    values.splice(index, 1);
    return true;
  }

  options.benchmarkOnly = takeBoolean("--benchmark-only");
  options.keepSession = takeBoolean("--keep-session");
  options.model = takeValue("--model") ?? options.model;
  options.thinking = takeValue("--thinking") ?? options.thinking;
  options.session = takeValue("--session");
  options.piBin = takeValue("--pi-bin") ?? process.env.PI_BIN;
  const timeout = takeValue("--timeout-ms");
  if (timeout) {
    options.timeoutMs = Number(timeout);
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new Error("--timeout-ms must be a positive number");
    }
  }
  if (values.length > 0) throw new Error(`Unknown arguments: ${values.join(" ")}`);
  return options;
}

function parseJsonl(raw) {
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function entryMessages(entries) {
  return entries.filter((entry) => entry?.type === "message" && entry.message);
}

function assistantText(entry) {
  if (entry?.type !== "message" || entry.message?.role !== "assistant") return "";
  if (!Array.isArray(entry.message.content)) return "";
  return entry.message.content
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

function toolCalls(entries) {
  const calls = [];
  for (const entry of entryMessages(entries)) {
    if (entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
    for (const item of entry.message.content) {
      if (item?.type === "toolCall") {
        calls.push({ id: item.id, name: item.name, arguments: item.arguments, entryId: entry.id });
      }
    }
  }
  return calls;
}

function toolResults(entries) {
  return entryMessages(entries)
    .filter((entry) => entry.message.role === "toolResult")
    .map((entry) => ({
      entryId: entry.id,
      toolCallId: entry.message.toolCallId,
      toolName: entry.message.toolName,
      content: entry.message.content,
      isError: entry.message.isError === true,
    }));
}

function messageText(message) {
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

function callTargetsExactLog(call, logPath) {
  return call.name === "read" && call.arguments?.path === logPath;
}

export function findSuccessfulLookup(entries, logPath, nonce) {
  const calls = toolCalls(entries).filter((candidate) => callTargetsExactLog(candidate, logPath));
  if (calls.length === 0) {
    throw new Error(`No post-compaction tool call targeted the exact PRO-LONG log ${logPath}`);
  }
  const results = toolResults(entries);
  let successfulResultFound = false;
  for (const call of calls) {
    for (const result of results.filter(
      (candidate) =>
        candidate.toolCallId === call.id && candidate.toolName === call.name && !candidate.isError,
    )) {
      successfulResultFound = true;
      if (JSON.stringify(result.content).includes(nonce)) return { call, result };
    }
  }
  if (!successfulResultFound) {
    throw new Error("No successful tool result was recorded for an exact PRO-LONG lookup");
  }
  throw new Error(`PRO-LONG lookup result did not contain the nonce ${nonce}`);
}

export function assertSuccessfulAgentEnd(agentEnd, options = {}) {
  if (!agentEnd || agentEnd.type !== "agent_end" || agentEnd.willRetry === true) {
    throw new Error("Agent run did not reach a terminal non-retry agent_end");
  }
  const assistants = (agentEnd.messages ?? []).filter((message) => message?.role === "assistant");
  if (assistants.length === 0) throw new Error("Agent run produced no assistant message");
  for (const message of assistants) {
    if (message.stopReason !== "stop" && message.stopReason !== "toolUse") {
      throw new Error(`Agent run had unsuccessful stop reason: ${message.stopReason ?? "missing"}`);
    }
  }
  const last = assistants.at(-1);
  if (last.stopReason !== "stop") {
    throw new Error(`Agent run did not finish with a terminal stop: ${last.stopReason}`);
  }
  if (
    options.forbidTools &&
    assistants.some(
      (message) =>
        message.stopReason === "toolUse" ||
        message.content?.some((item) => item?.type === "toolCall"),
    )
  ) {
    throw new Error("Agent run was required to be tool-free");
  }
  if (options.expectedText !== undefined && messageText(last) !== options.expectedText) {
    throw new Error(`Agent answer did not exactly equal ${JSON.stringify(options.expectedText)}`);
  }
}

export function parseRpcFrame(line) {
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(`Malformed Pi RPC frame: ${line}`, { cause: error });
  }
}

export function parseRpcTrailingFrame(buffer) {
  const line = buffer.replace(/\r$/, "");
  return line.length === 0 ? undefined : parseRpcFrame(line);
}

export function assertNoExtensionErrors(events) {
  const failure = events.find((event) => event?.type === "extension_error");
  if (failure) {
    throw new Error(
      `Pi extension error during ${failure.event ?? "unknown event"}: ${failure.error ?? "unknown error"}`,
    );
  }
}

export function assertNoToolActivity(events) {
  const toolEvent = events.find(
    (event) => event?.type === "tool_execution_start" || event?.type === "tool_execution_end",
  );
  if (toolEvent) throw new Error("Agent run was required to be tool-free");
}

function timeoutError(label, timeoutMs) {
  return new Error(`${label} timed out after ${timeoutMs} ms`);
}

class RpcProcess {
  constructor(binary, args, options) {
    this.events = [];
    this.pending = new Map();
    this.waiters = new Set();
    this.sequence = 0;
    this.stdoutBuffer = "";
    this.stderr = "";
    this.fatalError = undefined;
    this.timeoutMs = options.timeoutMs;
    this.child = spawn(binary, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.exitPromise = new Promise((resolveExit) => {
      this.child.once("error", (error) => {
        this.fail(new Error(`Could not spawn Pi RPC process: ${error.message}`, { cause: error }));
        resolveExit({ code: null, signal: null });
      });
      this.child.once("close", (code, signal) => {
        try {
          const trailingFrame = parseRpcTrailingFrame(this.stdoutBuffer);
          this.stdoutBuffer = "";
          if (trailingFrame !== undefined) this.consumeFrame(trailingFrame);
        } catch (trailingError) {
          this.fail(trailingError);
        }
        const error = new Error(`Pi RPC exited (code=${code}, signal=${signal})\n${this.stderr}`);
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
        for (const waiter of this.waiters) waiter.reject(error);
        this.waiters.clear();
        resolveExit({ code, signal });
      });
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.consume(chunk));
  }

  get eventCount() {
    return this.events.length;
  }

  consume(chunk) {
    this.stdoutBuffer += chunk;
    for (;;) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      try {
        const frame = parseRpcFrame(line);
        this.consumeFrame(frame);
      } catch (error) {
        this.fail(error);
        return;
      }
    }
  }

  consumeFrame(frame) {
    if (frame?.type === "response" && frame.id && this.pending.has(frame.id)) {
      const pending = this.pending.get(frame.id);
      this.pending.delete(frame.id);
      clearTimeout(pending.timer);
      if (frame.success) pending.resolve(frame);
      else pending.reject(new Error(`RPC ${frame.command} failed: ${frame.error}`));
      return;
    }
    this.events.push(frame);
    if (frame?.type === "extension_error") {
      this.fail(
        new Error(`Pi extension error during ${frame.event ?? "unknown event"}: ${frame.error}`),
      );
      return;
    }
    for (const waiter of this.waiters) {
      if (this.events.length - 1 < waiter.fromIndex || !waiter.predicate(frame)) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(frame);
    }
  }

  fail(error) {
    if (this.fatalError) return;
    this.fatalError = error instanceof Error ? error : new Error(String(error));
    for (const pending of this.pending.values()) pending.reject(this.fatalError);
    this.pending.clear();
    for (const waiter of this.waiters) waiter.reject(this.fatalError);
    this.waiters.clear();
    if (this.child.exitCode === null) this.child.kill("SIGTERM");
  }

  request(command, timeoutMs = this.timeoutMs) {
    if (this.fatalError) return Promise.reject(this.fatalError);
    const id = `prolong-verify-${++this.sequence}`;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(timeoutError(`RPC ${command.type}`, timeoutMs));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
      this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    });
  }

  waitFor(predicate, fromIndex = 0, timeoutMs = this.timeoutMs) {
    for (let index = fromIndex; index < this.events.length; index += 1) {
      if (predicate(this.events[index])) return Promise.resolve(this.events[index]);
    }
    return new Promise((resolveWait, rejectWait) => {
      const waiter = {
        predicate,
        fromIndex,
        resolve: resolveWait,
        reject: rejectWait,
        timer: undefined,
      };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        rejectWait(timeoutError("RPC event", timeoutMs));
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  async prompt(message, acceptance = {}) {
    const start = this.eventCount;
    await this.request({ type: "prompt", message });
    await this.waitFor((event) => event?.type === "agent_settled", start);
    const events = this.events.slice(start);
    assertNoExtensionErrors(events);
    if (acceptance.forbidTools) assertNoToolActivity(events);
    const agentEnd = events.filter((event) => event?.type === "agent_end").at(-1);
    assertSuccessfulAgentEnd(agentEnd, acceptance);
    return agentEnd;
  }

  async stop() {
    if (this.child.exitCode === null) {
      this.child.stdin.end();
    }
    const graceful = await Promise.race([
      this.exitPromise.then(() => true),
      new Promise((resolveWait) => setTimeout(() => resolveWait(false), 3000)),
    ]);
    if (!graceful && this.child.exitCode === null) this.child.kill("SIGTERM");
    const result = await this.exitPromise;
    if (this.fatalError) throw this.fatalError;
    assertNoExtensionErrors(this.events);
    if (result.code !== 0 || result.signal !== null) {
      throw new Error(`Pi RPC did not exit cleanly (code=${result.code}, signal=${result.signal})`);
    }
    return result;
  }
}

async function resolvePiBinary(explicit) {
  if (explicit) return explicit;
  const local = resolve("node_modules/.bin/pi");
  try {
    await access(local, constants.X_OK);
    return local;
  } catch {
    return "pi";
  }
}

async function runBenchmark(artifactDirectory) {
  const runtimeDirectory = join(artifactDirectory, "benchmark-runtime");
  await mkdir(runtimeDirectory, { recursive: true });
  const memory = new ProlongMemory({ runtimeDirectory, sessionId: "benchmark" });
  const entries = Array.from({ length: 50_000 }, (_, index) => ({
    type: "message",
    id: `entry-${index}`,
    parentId: index === 0 ? null : `entry-${index - 1}`,
    timestamp: "2026-08-14T00:00:00.000Z",
    payload: `payload-${index}-${"x".repeat(96)}`,
  }));
  const rebuild = await memory.sync(entries);
  const beforeAppend = await stat(memory.logPath, { bigint: true });
  const suffix = Array.from({ length: 10 }, (_, offset) => ({
    type: "message",
    id: `entry-${entries.length + offset}`,
    parentId: `entry-${entries.length + offset - 1}`,
    timestamp: "2026-08-14T00:00:01.000Z",
    payload: `suffix-${offset}`,
  }));
  const appended = await memory.sync([...entries, ...suffix]);
  const afterAppend = await stat(memory.logPath, { bigint: true });
  const noop = await memory.sync([...entries, ...suffix]);
  const divergent = await memory.sync([
    ...entries.slice(0, -1),
    { ...entries.at(-1), id: "replacement-leaf", payload: "divergent branch" },
  ]);
  let writable = true;
  try {
    await access(memory.logPath, constants.W_OK);
  } catch {
    writable = false;
  }
  const result = {
    entryCount: entries.length,
    rebuild,
    append: appended,
    noop,
    divergence: divergent,
    appendPreservedInode: beforeAppend.ino === afterAppend.ino,
    idleFileWritable: writable,
    architecture: process.arch,
    node: process.version,
  };
  await memory.cleanup();
  if (
    result.rebuild.mode !== "rebuild" ||
    result.append.mode !== "append" ||
    result.noop.mode !== "noop" ||
    result.divergence.mode !== "rebuild" ||
    !result.appendPreservedInode ||
    result.idleFileWritable
  ) {
    throw new Error(`Model-free benchmark contract failed: ${JSON.stringify(result)}`);
  }
  return result;
}

async function runRealSession(options, artifactDirectory, piBin) {
  const sessionPath =
    options.session ?? join(artifactDirectory, "prolong-verification-session.jsonl");
  await mkdir(dirname(sessionPath), { recursive: true });
  const runtimeDirectory = join(artifactDirectory, "runtime");
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  const agentDirectory = join(artifactDirectory, "pi-agent");
  await mkdir(agentDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(agentDirectory, "settings.json"),
    `${JSON.stringify({ compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 512 } })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  const extensionPath = resolve("pi-extensions/prolong.ts");
  const args = [
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--extension",
    extensionPath,
    "--session",
    sessionPath,
    "--tools",
    "read",
    "--model",
    options.model,
    "--thinking",
    options.thinking,
    "--mode",
    "rpc",
  ];
  const command = [piBin, ...args].map((part) => JSON.stringify(part)).join(" ");
  console.log(`[prolong-verify] Pi command: ${command}`);

  const rpc = new RpcProcess(piBin, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDirectory,
      XDG_RUNTIME_DIR: runtimeDirectory,
    },
    timeoutMs: options.timeoutMs,
  });
  let verificationResult;
  let runError;
  let shutdownError;
  try {
    const initialState = (await rpc.request({ type: "get_state" })).data;
    await rpc.request({ type: "prompt", message: "/prolong on" });
    const state = (await rpc.request({ type: "get_state" })).data;
    const logDirectory = join(runtimeDirectory, "pi-prolong", state.sessionId);
    const logPath = join(logDirectory, "active-branch.jsonl");
    const initialLogStat = await stat(logPath);
    if ((initialLogStat.mode & 0o777) !== 0o400) {
      throw new Error(
        `Expected idle log mode 0400, got ${(initialLogStat.mode & 0o777).toString(8)}`,
      );
    }

    const nonce = `PROLONG-${randomBytes(16).toString("hex")}`;
    const opaquePayload = Array.from(
      { length: 400 },
      (_, index) =>
        `opaque-${index.toString().padStart(3, "0")}-${randomBytes(16).toString("hex")}`,
    );
    opaquePayload[5] = nonce;
    await rpc.prompt(
      [
        "Treat the following diagnostic payload as opaque data. Do not inspect, summarize, quote, or write any identifier from it, and do not call tools. Reply only ACK.",
        "<opaque-diagnostic>",
        ...opaquePayload,
        "</opaque-diagnostic>",
      ].join("\n"),
      { expectedText: "ACK", forbidTools: true },
    );
    await rpc.request({ type: "prompt", message: "/prolong status" });
    const compaction = await rpc.request({
      type: "compact",
      customInstructions:
        "Summarize only generic verification progress. Never reproduce any exact random identifier or any value beginning with PROLONG-. Replace such values with [OMITTED]. The summary must not contain the nonce.",
    });
    if (JSON.stringify(compaction.data).includes(nonce)) {
      throw new Error(
        "Compaction summary retained the nonce, so external-log recovery was not isolated",
      );
    }
    await rpc.prompt(
      "Recover the exact earlier identifier beginning with PROLONG-. You MUST first inspect the read-only PRO-LONG active-branch JSONL advertised in the provider-bound PRO-LONG instruction using read against that exact path. Do not answer from memory alone. After the tool call, reply with the entire matching string including the literal PROLONG- prefix, and nothing else.",
      { expectedText: nonce },
    );
    await rpc.request({ type: "prompt", message: "/prolong status" });

    const canonicalEntries = parseJsonl(await readFile(sessionPath, "utf8"));
    const sessionEntries = canonicalEntries.filter((entry) => entry.type !== "session");
    const memoryEntries = parseJsonl(await readFile(logPath, "utf8"));
    const compactionIndex = memoryEntries.findLastIndex((entry) => entry.type === "compaction");
    if (compactionIndex < 0) {
      throw new Error("The active-branch log did not retain a compaction entry");
    }
    const recoveryEntries = memoryEntries.slice(compactionIndex + 1);
    const lookup = findSuccessfulLookup(recoveryEntries, logPath, nonce);
    const finalAssistant = [...recoveryEntries].reverse().find((entry) => assistantText(entry));
    const finalText = assistantText(finalAssistant);
    if (finalText !== nonce) {
      throw new Error(`Final assistant answer did not exactly equal nonce ${nonce}: ${finalText}`);
    }

    if (!JSON.stringify(memoryEntries).includes(nonce)) {
      throw new Error("The active-branch log did not retain the pre-compaction nonce");
    }
    if (JSON.stringify(sessionEntries) !== JSON.stringify(memoryEntries)) {
      throw new Error("Derived JSONL did not exactly match the canonical linear active branch");
    }

    await rpc.request({ type: "prompt", message: "/prolong off" });
    try {
      await stat(logDirectory);
      throw new Error("Derived PRO-LONG directory still exists after /prolong off");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await stat(sessionPath);

    await rpc.request({ type: "prompt", message: "/prolong on" });
    await stat(logDirectory);

    const { stdout: version } = await execFileAsync(piBin, ["--version"], { cwd: process.cwd() });
    verificationResult = {
      command,
      piVersion: version.trim(),
      model: options.model,
      thinking: options.thinking,
      architecture: process.arch,
      initialSessionId: initialState.sessionId,
      sessionId: state.sessionId,
      sessionPath,
      logPath,
      nonce,
      compaction: compaction.data,
      sessionEntryCount: sessionEntries.length,
      memoryEntryCount: memoryEntries.length,
      lookupToolCall: lookup.call,
      lookupToolResult: lookup.result,
      finalText,
      offRemovedProjection: true,
      shutdownRemovedProjection: false,
      canonicalSessionPreserved: true,
      stderr: rpc.stderr.trim(),
    };
  } catch (error) {
    runError = error;
  } finally {
    if (!verificationResult) {
      try {
        await rpc.request({ type: "prompt", message: "/prolong off" }, 5000);
      } catch {
        // Keep original failure and artifacts.
      }
    }
    try {
      await rpc.stop();
    } catch (error) {
      shutdownError = error;
    }
    if (verificationResult) {
      try {
        await stat(join(runtimeDirectory, "pi-prolong", verificationResult.sessionId));
        shutdownError = new Error("Derived PRO-LONG directory still exists after session_shutdown");
      } catch (error) {
        if (error?.code !== "ENOENT") shutdownError = error;
      }
      verificationResult.shutdownRemovedProjection = shutdownError === undefined;
    }
  }
  if (runError && shutdownError) {
    throw new AggregateError(
      [runError, shutdownError],
      "PRO-LONG verification and shutdown failed",
    );
  }
  if (runError) throw runError;
  if (shutdownError) throw shutdownError;
  return verificationResult;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const artifactDirectory = options.session
    ? dirname(resolve(options.session))
    : await mkdtemp(join(tmpdir(), "pi-prolong-verify-"));
  const reportPath = join(artifactDirectory, "prolong-verification-report.json");
  const piBin = await resolvePiBinary(options.piBin);
  console.log(`[prolong-verify] Artifacts: ${artifactDirectory}`);
  console.log(`[prolong-verify] Pi binary: ${piBin}`);

  const report = {
    startedAt: new Date().toISOString(),
    artifactDirectory,
    benchmark: await runBenchmark(artifactDirectory),
  };
  console.log(`[prolong-verify] Benchmark: ${JSON.stringify(report.benchmark)}`);

  if (!options.benchmarkOnly) {
    report.realSession = await runRealSession(options, artifactDirectory, piBin);
    console.log(
      `[prolong-verify] SUCCESS: ${report.realSession.lookupToolCall.name} inspected the PRO-LONG log after compaction and recovered ${report.realSession.nonce}.`,
    );
  }
  report.completedAt = new Date().toISOString();
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`[prolong-verify] Report: ${reportPath}`);

  if (!options.keepSession && !options.session) {
    await rm(artifactDirectory, { recursive: true, force: true });
    console.log(
      "[prolong-verify] Temporary successful artifacts removed; use --keep-session to retain them.",
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(async (error) => {
    console.error(
      `[prolong-verify] FAILURE: ${error instanceof Error ? error.stack : String(error)}`,
    );
    console.error("[prolong-verify] Failure artifacts were retained.");
    process.exitCode = 1;
  });
}
