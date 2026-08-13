import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage, Message, Tool, ToolCall } from "@earendil-works/pi-ai";
import type {
  CompletionClient,
  FusionModelRunDiagnostics,
  FusionReasoning,
  FusionTool,
  ResolvedModel,
  ToolUseSummary,
} from "./types.js";

export interface ModelRunResult {
  content: string;
  toolCalls: ToolUseSummary[];
}

export class FusionModelRunError extends Error {
  constructor(
    message: string,
    readonly details: FusionModelRunDiagnostics,
  ) {
    super(message);
    this.name = "FusionModelRunError";
  }
}

export const defaultCompletionClient: CompletionClient = {
  async complete(args) {
    return completeSimple(
      args.model.model,
      {
        systemPrompt: args.systemPrompt,
        messages: args.messages,
        tools: args.tools.map(toAiTool),
      },
      {
        apiKey: args.model.apiKey,
        headers: args.model.headers,
        signal: args.signal,
        maxTokens: args.maxCompletionTokens,
        reasoning: args.reasoning?.effort,
      },
    );
  },
};

export interface CompleteWithToolsArgs {
  model: ResolvedModel;
  systemPrompt: string;
  userPrompt: string;
  tools: FusionTool[];
  maxToolCalls: number;
  signal: AbortSignal;
  client?: CompletionClient;
  maxCompletionTokens?: number;
  reasoning?: FusionReasoning;
}

export async function completeWithTools(args: CompleteWithToolsArgs): Promise<ModelRunResult> {
  const client = args.client ?? defaultCompletionClient;
  const messages: Message[] = [{ role: "user", content: args.userPrompt, timestamp: Date.now() }];
  const toolCalls: ToolUseSummary[] = [];
  let callsUsed = 0;
  let toolBudgetExceeded = false;

  while (true) {
    throwIfAborted(args.signal);
    const assistant = await client.complete({
      model: args.model,
      systemPrompt: args.systemPrompt,
      messages,
      tools: toolBudgetExceeded ? [] : args.tools,
      signal: args.signal,
      maxCompletionTokens: args.maxCompletionTokens,
      reasoning: args.reasoning,
    });
    messages.push(assistant);

    const calls = extractToolCalls(assistant);
    if (calls.length === 0 || assistant.stopReason !== "toolUse") {
      return { content: finalContentOrThrow(args.model.ref, assistant), toolCalls };
    }

    if (toolBudgetExceeded) {
      return finalAfterBudgetExceeded(args.model.ref, assistant, toolCalls);
    }

    if (callsUsed + calls.length > args.maxToolCalls) {
      messages.push(
        ...recordBudgetExceeded(calls, args.model.ref, callsUsed, args.maxToolCalls, toolCalls),
      );
      toolBudgetExceeded = true;
      continue;
    }

    throwIfAborted(args.signal);
    const results = await Promise.all(
      calls.map((call) => executeAllowedTool(call, args.tools, args.signal)),
    );
    callsUsed += calls.length;
    toolCalls.push(...results.map((result) => ({ name: result.toolName, ok: !result.isError })));
    messages.push(...results);
  }
}

function finalContentOrThrow(modelRef: string, assistant: AssistantMessage): string {
  const content = extractText(assistant);
  if (assistant.stopReason === "error") {
    throw modelRunError(modelRef, assistant, "Model error");
  }
  if (!content) {
    throw modelRunError(modelRef, assistant, "Empty response");
  }
  return content;
}

function finalAfterBudgetExceeded(
  modelRef: string,
  assistant: AssistantMessage,
  toolCalls: ToolUseSummary[],
): ModelRunResult {
  const content = extractText(assistant);
  if (content) return { content, toolCalls };
  throw new Error(`Tool-call budget exhausted for ${modelRef}; no final answer returned`);
}

function recordBudgetExceeded(
  calls: ToolCall[],
  modelRef: string,
  callsUsed: number,
  maxToolCalls: number,
  toolCalls: ToolUseSummary[],
): Message[] {
  const results = calls.map((call) => {
    return toolBudgetExceededResult(call, modelRef, callsUsed, maxToolCalls);
  });
  toolCalls.push(...results.map((result) => ({ name: result.toolName, ok: false })));
  return results;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error("Fusion cancelled");
  }
}

function modelRunError(
  modelRef: string,
  assistant: AssistantMessage,
  reason: "Empty response" | "Model error",
): FusionModelRunError {
  const suffix = assistant.errorMessage ? `: ${assistant.errorMessage}` : "";
  return new FusionModelRunError(
    `${reason} from ${modelRef} (stopReason: ${assistant.stopReason})${suffix}`,
    assistantDiagnostics(assistant),
  );
}

function assistantDiagnostics(assistant: AssistantMessage): FusionModelRunDiagnostics {
  return {
    api: assistant.api,
    provider: assistant.provider,
    model: assistant.model,
    responseModel: assistant.responseModel,
    responseId: assistant.responseId,
    stopReason: assistant.stopReason,
    errorMessage: assistant.errorMessage,
    usage: assistant.usage,
    diagnostics: assistant.diagnostics,
    content: assistant.content.map((part) => {
      if (part.type === "text") return { type: part.type, chars: part.text.length };
      if (part.type === "toolCall") return { type: part.type, name: part.name, id: part.id };
      return { type: part.type };
    }),
  };
}

function toAiTool(tool: FusionTool): Tool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as Tool["parameters"],
  };
}

function extractToolCalls(message: AssistantMessage): ToolCall[] {
  return message.content.filter((part): part is ToolCall => part.type === "toolCall");
}

function extractText(message: AssistantMessage): string {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function toolBudgetExceededResult(
  call: ToolCall,
  modelRef: string,
  callsUsed: number,
  maxToolCalls: number,
) {
  return toolError(
    call.id,
    call.name,
    `Tool-call budget exceeded for ${modelRef}: ${callsUsed}/${maxToolCalls} used. ` +
      "No more tools are available; answer from existing context.",
  );
}

async function executeAllowedTool(call: ToolCall, tools: FusionTool[], signal: AbortSignal) {
  const tool = tools.find((candidate) => candidate.name === call.name);
  if (!tool) return toolError(call.id, call.name, `Tool not allowed: ${call.name}`);

  try {
    return await tool.execute(call, signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return toolError(call.id, call.name, message);
  }
}

function toolError(toolCallId: string, toolName: string, text: string) {
  return {
    role: "toolResult" as const,
    toolCallId,
    toolName,
    content: [{ type: "text" as const, text }],
    isError: true,
    timestamp: Date.now(),
  };
}
