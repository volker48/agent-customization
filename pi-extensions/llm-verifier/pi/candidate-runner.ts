import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";

import { abortError } from "../run/git.js";
import type {
  CandidateAction,
  CandidateExecution,
  CandidateRunInput,
  CandidateRunner,
} from "../run/types.js";

export interface PiCandidateRunnerOptions {
  model: CreateAgentSessionOptions["model"];
  thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
  agentDir?: string;
}

export class PiAgentSessionCandidateRunner implements CandidateRunner {
  constructor(private readonly options: PiCandidateRunnerOptions) {}

  async run(input: CandidateRunInput): Promise<CandidateExecution> {
    if (input.signal.aborted) throw abortError();
    if (!this.options.model) throw new Error("A candidate model is required");

    const agentDir = this.options.agentDir ?? getAgentDir();
    const settingsManager = SettingsManager.inMemory();
    const resourceLoader = createLavChildResourceLoader(input.cwd, agentDir, settingsManager);
    await resourceLoader.reload();
    if (input.signal.aborted) throw abortError();

    const { session } = await createAgentSession({
      cwd: input.cwd,
      agentDir,
      model: this.options.model,
      thinkingLevel: this.options.thinkingLevel,
      resourceLoader,
      sessionManager: SessionManager.inMemory(input.cwd),
      settingsManager,
      tools: ["read", "bash", "edit", "write"],
    });

    const actions: CandidateAction[] = [];
    const toolInputs = new Map<string, { toolName: string; input: string }>();
    let finalMessage = "";
    let finalAssistantError = "";
    let sequence = 0;
    let abortPromise: Promise<void> | undefined;

    const unsubscribe = session.subscribe((event) => {
      captureEvent(event, {
        actions,
        toolInputs,
        nextSequence: () => {
          sequence += 1;
          return sequence;
        },
        setFinalMessage: (value) => {
          finalMessage = value;
        },
        setFinalAssistantError: (value) => {
          finalAssistantError = value;
        },
      });
    });
    const onAbort = () => {
      abortPromise ??= session.abort().catch(() => undefined);
    };
    input.signal.addEventListener("abort", onAbort, { once: true });

    try {
      if (input.signal.aborted) {
        onAbort();
        throw abortError();
      }
      await session.prompt(buildCandidatePrompt(input.task), {
        expandPromptTemplates: false,
        source: "extension",
      });
      if (input.signal.aborted) throw abortError();
      if (finalAssistantError) throw new Error(finalAssistantError);
      return {
        status: "completed",
        actions,
        finalMessage,
      };
    } finally {
      input.signal.removeEventListener("abort", onAbort);
      if (input.signal.aborted) {
        onAbort();
      }
      await abortPromise;
      unsubscribe();
      session.dispose();
    }
  }
}

export function createLavChildResourceLoader(
  cwd: string,
  agentDir: string,
  settingsManager: SettingsManager,
): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
  });
}

export function buildCandidatePrompt(task: string): string {
  return [
    "Implement the task in the current Git worktree.",
    "",
    "Rules:",
    "- Work only inside the current worktree.",
    "- Inspect the repository and follow its local instructions.",
    "- Make the complete code change, including tests and documentation when relevant.",
    "- Run the most relevant deterministic verification available.",
    "- Do not commit, create branches, stash, add worktrees, or modify another checkout.",
    "- Do not invoke /lav-run, /lav-status, or any other LAV command.",
    "- Treat command output as authoritative and report failures honestly.",
    "",
    "Task:",
    task.trim(),
  ].join("\n");
}

interface CaptureState {
  actions: CandidateAction[];
  toolInputs: Map<string, { toolName: string; input: string }>;
  nextSequence: () => number;
  setFinalMessage: (value: string) => void;
  setFinalAssistantError: (value: string) => void;
}

function captureEvent(event: AgentSessionEvent, state: CaptureState): void {
  if (event.type === "tool_execution_start") {
    state.toolInputs.set(event.toolCallId, {
      toolName: event.toolName,
      input: safeJson(event.args),
    });
    return;
  }
  if (event.type === "tool_execution_end") {
    const started = state.toolInputs.get(event.toolCallId);
    state.actions.push({
      sequence: state.nextSequence(),
      kind: "tool",
      toolName: started?.toolName ?? event.toolName,
      input: started?.input ?? "",
      output: extractText(event.result),
      isError: event.isError,
    });
    state.toolInputs.delete(event.toolCallId);
    return;
  }
  if (event.type !== "message_end" || !isAssistantMessage(event.message)) return;

  const text = extractText(event.message);
  if (text.trim()) {
    state.actions.push({
      sequence: state.nextSequence(),
      kind: "assistant",
      toolName: "",
      input: "",
      output: text,
      isError: event.message.stopReason === "error" || event.message.stopReason === "aborted",
    });
    state.setFinalMessage(text);
  }
  if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
    state.setFinalAssistantError(
      `Candidate model ${event.message.stopReason}: ${
        typeof event.message.errorMessage === "string"
          ? event.message.errorMessage
          : "provider returned no error detail"
      }`,
    );
  } else {
    state.setFinalAssistantError("");
  }
}

function isAssistantMessage(value: unknown): value is {
  role: "assistant";
  content?: unknown;
  stopReason?: string;
  errorMessage?: unknown;
} {
  return isObject(value) && value.role === "assistant";
}

function extractText(value: unknown): string {
  if (!isObject(value)) return typeof value === "string" ? value : safeJson(value);
  const content = value.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return safeJson(value);
  return content
    .flatMap((part) =>
      isObject(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join("\n");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(toJsonSafe(value, new WeakSet<object>(), 0)) ?? "";
  } catch {
    return String(value);
  }
}

function toJsonSafe(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    return String(value);
  }
  if (value === undefined) return null;
  if (depth >= 8) return "[Depth limit]";
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => toJsonSafe(item, seen, depth + 1));
  }
  const output: { [key: string]: unknown } = {};
  for (const key of Object.keys(value).sort()) {
    output[key] = toJsonSafe((value as { [key: string]: unknown })[key], seen, depth + 1);
  }
  return output;
}

function isObject(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null;
}
