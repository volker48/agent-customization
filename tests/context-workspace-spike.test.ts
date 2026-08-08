import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compact,
  createAgentSession,
  createExtensionRuntime,
  DefaultResourceLoader,
  estimateTokens,
  ExtensionRunner,
  ModelRuntime,
  SessionManager,
  sessionEntryToContextMessages,
  SettingsManager,
  type ContextEvent,
  type Extension,
  type ExtensionContext,
  type ExtensionFactory,
  type ModelRegistry,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, type Context } from "@earendil-works/pi-ai";

type AgentMessage = ContextEvent["messages"][number];
type ReadonlySessionManager = ExtensionContext["sessionManager"];

const LARGE_PAYLOAD_MARKER = "CONTEXT_WORKSPACE_LARGE_PAYLOAD";
const LARGE_PAYLOAD = `${LARGE_PAYLOAD_MARKER}:${"x".repeat(120_000)}`;
const ARCHIVED_FILE_PATH = "/archived-diagnostics.txt";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function appendLargeToolExchange(session: SessionManager) {
  session.appendMessage({
    role: "user",
    content: "Inspect the generated diagnostic payload.",
    timestamp: 1,
  });
  const assistantEntryId = session.appendMessage({
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "call-large",
        name: "write",
        arguments: { path: ARCHIVED_FILE_PATH, content: "generate-diagnostics" },
      },
    ],
    api: "openai-responses",
    provider: "spike",
    model: "spike",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 2,
  } as Parameters<SessionManager["appendMessage"]>[0]);
  const toolResultId = session.appendMessage({
    role: "toolResult",
    toolCallId: "call-large",
    toolName: "write",
    content: [{ type: "text", text: LARGE_PAYLOAD }],
    isError: false,
    timestamp: 3,
  });
  return { assistantEntryId, toolResultId };
}

function projectArchivedEntries(
  session: ReadonlySessionManager,
  messages: AgentMessage[],
  archivedEntryIds: ReadonlySet<string>,
): AgentMessage[] {
  const entryByMessageOccurrence = new Map<string, string>();
  const entryOccurrences = new Map<string, number>();
  for (const entry of session.buildContextEntries()) {
    for (const message of sessionEntryToContextMessages(entry)) {
      const fingerprint = contextMessageFingerprint(message);
      const occurrence = (entryOccurrences.get(fingerprint) ?? 0) + 1;
      entryOccurrences.set(fingerprint, occurrence);
      entryByMessageOccurrence.set(`${fingerprint}:${occurrence}`, entry.id);
    }
  }

  const eventOccurrences = new Map<string, number>();
  return messages.filter((message) => {
    const fingerprint = contextMessageFingerprint(message);
    const occurrence = (eventOccurrences.get(fingerprint) ?? 0) + 1;
    eventOccurrences.set(fingerprint, occurrence);
    const entryId = entryByMessageOccurrence.get(`${fingerprint}:${occurrence}`);
    return entryId === undefined || !archivedEntryIds.has(entryId);
  });
}

function contextMessageFingerprint(message: AgentMessage): string {
  if (message.role === "assistant") {
    const { timestamp: _timestamp, usage: _usage, ...assistantContent } = message;
    return JSON.stringify(assistantContent);
  }
  const { timestamp: _timestamp, ...stableMessage } = message;
  return JSON.stringify(stableMessage);
}

async function providerBoundMessages(
  session: SessionManager,
  archivedEntryIds: ReadonlySet<string>,
): Promise<AgentMessage[]> {
  const runtime = createExtensionRuntime();
  const contextHandler = (event: ContextEvent, ctx: ExtensionContext) => ({
    messages: projectArchivedEntries(ctx.sessionManager, event.messages, archivedEntryIds),
  });
  const extension = {
    path: "<context-workspace-spike>",
    resolvedPath: "<context-workspace-spike>",
    sourceInfo: {},
    handlers: new Map([["context", [contextHandler]]]),
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  } as unknown as Extension;
  const runner = new ExtensionRunner(
    [extension],
    runtime,
    session.getCwd(),
    session,
    {} as ModelRegistry,
  );
  return runner.emitContext(session.buildSessionContext().messages);
}

function messageText(messages: AgentMessage[]): string {
  return JSON.stringify(messages);
}

function providerContextContainsArchive(context: Context): boolean {
  const text = messageText(context.messages as AgentMessage[]);
  return text.includes(LARGE_PAYLOAD_MARKER) || text.includes(ARCHIVED_FILE_PATH);
}

function persistedEntryLine(sessionFile: string, entryId: string): string {
  const line = readFileSync(sessionFile, "utf8")
    .split("\n")
    .find((candidate) => {
      if (!candidate) return false;
      const entry = JSON.parse(candidate) as { id?: unknown };
      return entry.id === entryId;
    });
  if (!line) throw new Error(`persisted entry ${entryId} missing`);
  return line;
}

interface ObservedCompaction {
  reason: SessionBeforeCompactEvent["reason"];
  nativeInput: string;
}

async function createPersistedSession() {
  const root = await mkdtemp(join(tmpdir(), "context-workspace-spike-"));
  temporaryDirectories.push(root);
  return {
    root,
    sessionManager: SessionManager.create(root, join(root, "sessions")),
  };
}

async function createRuntimeHarness(
  root: string,
  sessionManager: SessionManager,
  archivedEntryIds: ReadonlySet<string>,
  options: {
    reserveTokens?: number;
    keepRecentTokens?: number;
    customCompaction?: boolean;
  } = {},
) {
  const providerContexts: Context[] = [];
  const contextHandlerUsages: Array<ReturnType<ExtensionContext["getContextUsage"]>> = [];
  const observedCompactions: ObservedCompaction[] = [];
  const faux = createFauxCore({
    api: "context-workspace-spike",
    provider: "context-workspace-spike",
    models: [{ id: "spike", contextWindow: 50_000, maxTokens: 1_000 }],
  });
  const response = (context: Context) => {
    providerContexts.push(structuredClone(context));
    const containsArchive = messageText(context.messages as AgentMessage[]).includes(
      LARGE_PAYLOAD_MARKER,
    );
    return fauxAssistantMessage(containsArchive ? LARGE_PAYLOAD_MARKER : "ok");
  };
  faux.setResponses(Array.from({ length: 8 }, () => response));

  const modelRuntime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  modelRuntime.registerProvider("context-workspace-spike", {
    name: "Context Workspace Spike",
    baseUrl: "http://context-workspace.invalid",
    api: faux.api as never,
    streamSimple: faux.streamSimple,
    models: [
      {
        id: "spike",
        name: "Spike",
        api: faux.api as never,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 50_000,
        maxTokens: 1_000,
      },
    ],
  });
  await modelRuntime.setRuntimeApiKey("context-workspace-spike", randomUUID());
  const model = modelRuntime.getModel("context-workspace-spike", "spike");
  if (!model) throw new Error("faux model missing");

  const extension: ExtensionFactory = (pi) => {
    pi.on("context", (event, ctx) => {
      contextHandlerUsages.push(ctx.getContextUsage());
      return {
        messages: projectArchivedEntries(ctx.sessionManager, event.messages, archivedEntryIds),
      };
    });
    if (options.customCompaction) {
      pi.on("session_before_compact", async (event, ctx) => {
        observedCompactions.push({
          reason: event.reason,
          nativeInput: messageText([
            ...event.preparation.messagesToSummarize,
            ...event.preparation.turnPrefixMessages,
          ]),
        });
        if (!ctx.model) throw new Error("compaction model missing");
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
        if (auth.ok === false) throw new Error(auth.error);
        const provider = ctx.modelRegistry.getRegisteredProviderConfig(ctx.model.provider);
        const messagesToSummarize = projectArchivedEntries(
          ctx.sessionManager,
          event.preparation.messagesToSummarize,
          archivedEntryIds,
        );
        const turnPrefixMessages = projectArchivedEntries(
          ctx.sessionManager,
          event.preparation.turnPrefixMessages,
          archivedEntryIds,
        );
        // Deliberately preserve native derived fields: this probe proves that projecting only the
        // message arrays is insufficient because unprojected fileOps still leak into the summary.
        const preparation = {
          ...event.preparation,
          messagesToSummarize,
          turnPrefixMessages,
        };
        return {
          compaction: await compact(
            preparation,
            ctx.model,
            auth.apiKey,
            auth.headers,
            undefined,
            ctx.signal,
            undefined,
            provider?.streamSimple,
            auth.env,
          ),
        };
      });
    }
  };
  const settingsManager = SettingsManager.inMemory({
    compaction: {
      enabled: true,
      reserveTokens: options.reserveTokens ?? 16_384,
      keepRecentTokens: options.keepRecentTokens ?? 1_000,
    },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager,
    extensionFactories: [{ name: "context-workspace-spike", factory: extension }],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: root,
    agentDir: root,
    modelRuntime,
    model,
    settingsManager,
    resourceLoader,
    sessionManager,
    noTools: "all",
  });
  await session.bindExtensions({ mode: "print" });
  return { session, providerContexts, contextHandlerUsages, observedCompactions };
}

describe("Context Workspace Pi 0.80.8 architecture spike", () => {
  it("removes an archived 30k-token tool result from provider-bound context", async () => {
    const session = SessionManager.inMemory("/context-workspace-spike");
    const { assistantEntryId, toolResultId } = appendLargeToolExchange(session);
    const toolResult = session.getEntry(toolResultId);

    expect(toolResult?.type).toBe("message");
    if (toolResult?.type !== "message") throw new Error("tool result fixture missing");
    expect(estimateTokens(toolResult.message)).toBeGreaterThanOrEqual(30_000);

    const projected = await providerBoundMessages(
      session,
      new Set([assistantEntryId, toolResultId]),
    );

    expect(messageText(projected)).not.toContain(LARGE_PAYLOAD_MARKER);
    expect(messageText(projected)).not.toContain("generate-diagnostics");
  });

  it("maps duplicate messages by occurrence and preserves unmatched extension messages", () => {
    const session = SessionManager.inMemory("/context-workspace-spike");
    session.appendMessage({ role: "user", content: "duplicate", timestamp: 1 });
    const archivedDuplicateId = session.appendMessage({
      role: "user",
      content: "duplicate",
      timestamp: 2,
    });
    const eventMessages = session.buildSessionContext().messages;
    eventMessages.splice(1, 0, {
      role: "custom",
      customType: "other-extension",
      content: "UNMATCHED_EXTENSION_MESSAGE",
      display: false,
      timestamp: 3,
    });

    const projected = projectArchivedEntries(
      session,
      eventMessages,
      new Set([archivedDuplicateId]),
    );
    const serialized = messageText(projected);

    expect(serialized.match(/duplicate/g)).toHaveLength(1);
    expect(serialized).toContain("UNMATCHED_EXTENSION_MESSAGE");
    expect(
      projected
        .filter((message) => message.role === "user" && message.content === "duplicate")
        .map((message) => message.timestamp),
    ).toEqual([1]);
  });

  it("shows identical extension insertions defeat stable message identity", () => {
    const session = SessionManager.inMemory("/context-workspace-spike");
    session.appendMessage({ role: "user", content: "duplicate", timestamp: 1 });
    const archivedDuplicateId = session.appendMessage({
      role: "user",
      content: "duplicate",
      timestamp: 2,
    });
    const eventMessages = session.buildSessionContext().messages;
    eventMessages.unshift({ role: "user", content: "duplicate", timestamp: 999 });

    const projected = projectArchivedEntries(
      session,
      eventMessages,
      new Set([archivedDuplicateId]),
    );
    const survivingTimestamps = projected
      .filter((message) => message.role === "user" && message.content === "duplicate")
      .map((message) => message.timestamp);

    expect(survivingTimestamps).toEqual([999, 2]);
    expect(survivingTimestamps).not.toContain(1);
    expect(survivingTimestamps).toContain(2);
  });

  it("projects before the provider call and reports usage from the projected context", async () => {
    const { root, sessionManager } = await createPersistedSession();
    const { assistantEntryId, toolResultId } = appendLargeToolExchange(sessionManager);
    const toolResult = sessionManager.getEntry(toolResultId);
    if (toolResult?.type !== "message") throw new Error("tool result fixture missing");
    const harness = await createRuntimeHarness(
      root,
      sessionManager,
      new Set([assistantEntryId, toolResultId]),
    );

    await harness.session.prompt("Continue after archiving diagnostics.");

    expect(harness.providerContexts).toHaveLength(1);
    expect(messageText(harness.providerContexts[0].messages as AgentMessage[])).not.toContain(
      LARGE_PAYLOAD_MARKER,
    );
    const usage = harness.session.getContextUsage();
    expect(harness.contextHandlerUsages).toHaveLength(1);
    expect(harness.contextHandlerUsages[0]?.tokens ?? 0).toBeGreaterThanOrEqual(
      estimateTokens(toolResult.message),
    );
    expect(usage?.tokens).not.toBeNull();
    expect(usage?.tokens ?? Number.POSITIVE_INFINITY).toBeLessThan(
      estimateTokens(toolResult.message),
    );
  });

  it("does not trigger threshold compaction from archived token pressure", async () => {
    const { root, sessionManager } = await createPersistedSession();
    const { assistantEntryId, toolResultId } = appendLargeToolExchange(sessionManager);
    const harness = await createRuntimeHarness(
      root,
      sessionManager,
      new Set([assistantEntryId, toolResultId]),
      { customCompaction: true, reserveTokens: 25_000 },
    );

    await harness.session.prompt("small visible prompt");

    expect(harness.session.getContextUsage()?.tokens ?? Number.POSITIVE_INFINITY).toBeLessThan(
      25_000,
    );
    expect(harness.observedCompactions).toEqual([]);
  });

  it("shows that unprojected native compaction can reintroduce archived content", async () => {
    const { root, sessionManager } = await createPersistedSession();
    const { assistantEntryId, toolResultId } = appendLargeToolExchange(sessionManager);
    sessionManager.appendMessage({
      role: "user",
      content: "recent".repeat(1_000),
      timestamp: 4,
    });
    const harness = await createRuntimeHarness(
      root,
      sessionManager,
      new Set([assistantEntryId, toolResultId]),
      { keepRecentTokens: 1_000 },
    );

    await harness.session.compact();

    expect(
      harness.providerContexts.some((context) =>
        messageText(context.messages as AgentMessage[]).includes(LARGE_PAYLOAD_MARKER),
      ),
    ).toBe(true);
    const nativeContext = messageText(sessionManager.buildSessionContext().messages);
    expect(nativeContext).toContain(LARGE_PAYLOAD_MARKER);
    expect(nativeContext).toContain(ARCHIVED_FILE_PATH);
  });

  it("keeps exact entries but leaks archived file metadata after manual compaction", async () => {
    const { root, sessionManager } = await createPersistedSession();
    const { assistantEntryId, toolResultId } = appendLargeToolExchange(sessionManager);
    const original = JSON.stringify(sessionManager.getEntry(toolResultId));
    const sessionFile = sessionManager.getSessionFile();
    if (!sessionFile) throw new Error("persisted session file missing");
    const originalLine = persistedEntryLine(sessionFile, toolResultId);
    sessionManager.appendMessage({
      role: "user",
      content: "recent".repeat(1_000),
      timestamp: 4,
    });
    const harness = await createRuntimeHarness(
      root,
      sessionManager,
      new Set([assistantEntryId, toolResultId]),
      { customCompaction: true, keepRecentTokens: 1_000 },
    );

    await harness.session.compact();

    expect(harness.session.getContextUsage()?.tokens).toBeNull();
    expect(harness.observedCompactions).toEqual([expect.objectContaining({ reason: "manual" })]);
    expect(harness.observedCompactions[0].nativeInput).toContain(LARGE_PAYLOAD_MARKER);
    expect(
      harness.providerContexts.every((context) => !providerContextContainsArchive(context)),
    ).toBe(true);
    const compactedContext = messageText(sessionManager.buildSessionContext().messages);
    expect(compactedContext).not.toContain(LARGE_PAYLOAD_MARKER);
    expect(compactedContext).toContain(ARCHIVED_FILE_PATH);
    expect(JSON.stringify(sessionManager.getEntry(toolResultId))).toBe(original);
    expect(persistedEntryLine(sessionFile, toolResultId)).toBe(originalLine);

    const reloaded = SessionManager.open(sessionFile);
    expect(JSON.stringify(reloaded.getEntry(toolResultId))).toBe(original);
    expect(persistedEntryLine(sessionFile, toolResultId)).toBe(originalLine);

    const forked = SessionManager.forkFrom(sessionFile, root, join(root, "forked-sessions"));
    expect(JSON.stringify(forked.getEntry(toolResultId))).toBe(original);
    const forkedSessionFile = forked.getSessionFile();
    if (!forkedSessionFile) throw new Error("forked session file missing");
    expect(persistedEntryLine(forkedSessionFile, toolResultId)).toBe(originalLine);

    reloaded.branch(assistantEntryId);
    expect(JSON.stringify(reloaded.getEntry(toolResultId))).toBe(original);
    expect(persistedEntryLine(sessionFile, toolResultId)).toBe(originalLine);
  });

  it("keeps entries but leaks file metadata after threshold compaction", async () => {
    const { root, sessionManager } = await createPersistedSession();
    const { assistantEntryId, toolResultId } = appendLargeToolExchange(sessionManager);
    const original = JSON.stringify(sessionManager.getEntry(toolResultId));
    const sessionFile = sessionManager.getSessionFile();
    if (!sessionFile) throw new Error("persisted session file missing");
    const originalLine = persistedEntryLine(sessionFile, toolResultId);
    const harness = await createRuntimeHarness(
      root,
      sessionManager,
      new Set([assistantEntryId, toolResultId]),
      {
        customCompaction: true,
        keepRecentTokens: 1_000,
        reserveTokens: 20_000,
      },
    );

    await harness.session.prompt("visible-pressure:" + "v".repeat(140_000));

    expect(harness.observedCompactions).toEqual([expect.objectContaining({ reason: "threshold" })]);
    expect(harness.observedCompactions[0].nativeInput).toContain(LARGE_PAYLOAD_MARKER);
    expect(
      harness.providerContexts.every((context) => !providerContextContainsArchive(context)),
    ).toBe(true);
    const compactedContext = messageText(sessionManager.buildSessionContext().messages);
    expect(compactedContext).not.toContain(LARGE_PAYLOAD_MARKER);
    expect(compactedContext).toContain(ARCHIVED_FILE_PATH);
    expect(JSON.stringify(sessionManager.getEntry(toolResultId))).toBe(original);
    expect(persistedEntryLine(sessionFile, toolResultId)).toBe(originalLine);

    const reloaded = SessionManager.open(sessionFile);
    expect(JSON.stringify(reloaded.getEntry(toolResultId))).toBe(original);
    expect(persistedEntryLine(sessionFile, toolResultId)).toBe(originalLine);

    const forked = SessionManager.forkFrom(
      sessionFile,
      root,
      join(root, "threshold-forked-sessions"),
    );
    expect(JSON.stringify(forked.getEntry(toolResultId))).toBe(original);
    const forkedSessionFile = forked.getSessionFile();
    if (!forkedSessionFile) throw new Error("forked session file missing");
    expect(persistedEntryLine(forkedSessionFile, toolResultId)).toBe(originalLine);

    reloaded.branch(assistantEntryId);
    expect(JSON.stringify(reloaded.getEntry(toolResultId))).toBe(original);
    expect(persistedEntryLine(sessionFile, toolResultId)).toBe(originalLine);
  });
});
