import type { TokenUsage } from "@cursor/sdk";
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
} from "@earendil-works/pi-ai";

function estimateContentTokens(content: unknown): number {
  if (typeof content === "string") return Math.ceil(content.length / 4);
  if (!Array.isArray(content)) return 0;
  let tokens = 0;
  for (const block of content as Array<Record<string, unknown>>) {
    if (block?.type === "image") tokens += 1200;
    else if (typeof block?.text === "string") tokens += Math.ceil(block.text.length / 4);
    else if (typeof block?.thinking === "string") tokens += Math.ceil(block.thinking.length / 4);
    else if (block?.type === "toolCall") {
      tokens += Math.ceil(JSON.stringify(block.arguments ?? {}).length / 4);
    }
  }
  return tokens;
}

export function estimateVisibleContextTokens(context: Context, output: AssistantMessage): number {
  let tokens = context.systemPrompt ? Math.ceil(context.systemPrompt.length / 4) : 0;
  for (const message of context.messages ?? []) {
    tokens += estimateContentTokens((message as { content?: unknown }).content);
  }
  tokens += estimateContentTokens(output.content);
  return Math.max(1, tokens);
}

export function applyCursorUsage(output: AssistantMessage, usage: TokenUsage): void {
  // Cursor aggregates every internal agent request in a turn. Pi's cache-miss
  // detector assumes one provider request, so separate cache buckets create
  // false re-billing notices. Preserve total prompt volume in input instead.
  output.usage.input = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  output.usage.output = usage.outputTokens;
  output.usage.cacheRead = 0;
  output.usage.cacheWrite = 0;
  output.usage.reasoning = usage.reasoningTokens;
}

export function sumTurnUsage(usages: TokenUsage[]): TokenUsage | undefined {
  if (usages.length === 0) return undefined;
  return usages.reduce<TokenUsage>(
    (total, usage) => ({
      inputTokens: total.inputTokens + usage.inputTokens,
      outputTokens: total.outputTokens + usage.outputTokens,
      cacheReadTokens: total.cacheReadTokens + usage.cacheReadTokens,
      cacheWriteTokens: total.cacheWriteTokens + usage.cacheWriteTokens,
      reasoningTokens: (total.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0),
      totalTokens: total.totalTokens + usage.totalTokens,
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    },
  );
}

export function createOutput(model: Model<never>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

export function finishBufferedOutput(
  stream: AssistantMessageEventStream,
  output: AssistantMessage,
): void {
  const content = output.content;
  output.content = [];
  stream.push({ type: "start", partial: output });

  for (const block of content) {
    const contentIndex = output.content.length;
    if (block.type === "text") {
      output.content.push({ ...block, text: "" });
      stream.push({ type: "text_start", contentIndex, partial: output });
      if (block.text) {
        (output.content[contentIndex] as { type: "text"; text: string }).text = block.text;
        stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: output });
      }
      stream.push({
        type: "text_end",
        contentIndex,
        content: block.text,
        partial: output,
      });
    } else if (block.type === "thinking") {
      output.content.push({ ...block, thinking: "" });
      stream.push({ type: "thinking_start", contentIndex, partial: output });
      if (block.thinking) {
        (output.content[contentIndex] as { type: "thinking"; thinking: string }).thinking =
          block.thinking;
        stream.push({
          type: "thinking_delta",
          contentIndex,
          delta: block.thinking,
          partial: output,
        });
      }
      stream.push({
        type: "thinking_end",
        contentIndex,
        content: block.thinking,
        partial: output,
      });
    } else {
      output.content.push(block);
    }
  }

  stream.push({ type: "done", reason: "stop", message: output });
  stream.end();
}

export function pushError(
  stream: AssistantMessageEventStream,
  output: AssistantMessage,
  error: unknown,
  aborted: boolean,
): void {
  output.stopReason = aborted ? "aborted" : "error";
  output.errorMessage = error instanceof Error ? error.message : String(error);
  stream.push({ type: "start", partial: output });
  stream.push({ type: "error", reason: output.stopReason, error: output });
  stream.end();
}
