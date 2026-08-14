import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import type { SDKImage, SDKUserMessage } from "@cursor/sdk";

const PROVIDER = "cursor";

function extractText(content: unknown, imagePlaceholder?: string): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as Array<{ type?: string; text?: string }>) {
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block?.type === "image" && imagePlaceholder) parts.push(imagePlaceholder);
  }
  return parts.join("\n");
}

function extractImages(content: unknown): SDKImage[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block: unknown) => {
    if (!block || typeof block !== "object") return [];
    const image = block as { type?: string; data?: string; mimeType?: string };
    if (image.type !== "image" || typeof image.data !== "string" || !image.mimeType) return [];
    return [{ data: image.data, mimeType: image.mimeType }];
  });
}

function lastUserContent(context: Context): { content: unknown; index: number } {
  const messages = context.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return { content: message.content, index };
  }
  return { content: "", index: -1 };
}

export function buildPrompt(
  context: Context,
  isFirstTurn: boolean,
  currentImagePlaceholder?: string,
): string {
  const messages = context.messages ?? [];
  const { content: currentUserContent, index: lastUserIndex } = lastUserContent(context);
  const lastUserText = extractText(currentUserContent, currentImagePlaceholder);

  if (!isFirstTurn) return lastUserText;

  const prompt: string[] = [];
  if (context.systemPrompt) {
    prompt.push("System instructions from Pi:", context.systemPrompt, "");
  }

  if (lastUserIndex > 0) {
    // First Cursor turn in a Pi session that already has history (for example, a
    // mid-session model switch or transcript replay after restart): ship the transcript.
    prompt.push("This conversation continues from another agent. Transcript so far:", "");
    for (const msg of messages.slice(0, lastUserIndex)) {
      const text = extractText(
        (msg as { content?: unknown }).content,
        "[image omitted from transcript replay]",
      );
      if (!text) continue;
      const label =
        msg.role === "user" ? "User" : msg.role === "assistant" ? "Assistant" : "Tool result";
      prompt.push(
        `${label}: ${text.length > 4000 ? text.slice(0, 4000) + "\n...[truncated]" : text}`,
      );
    }
    prompt.push("");
  }

  if (prompt.length === 0) return lastUserText;
  prompt.push(`User: ${lastUserText}`);
  return prompt.join("\n");
}

export function buildSdkMessage(context: Context, isFirstTurn: boolean): string | SDKUserMessage {
  const { content } = lastUserContent(context);
  const images = extractImages(content);
  const text = buildPrompt(context, isFirstTurn) || "(see attached image)";
  return images.length > 0 ? { text, images } : text;
}

export function hasCursorHistory(context: Context): boolean {
  return (context.messages ?? []).some(
    (message) =>
      message.role === "assistant" && (message as AssistantMessage).provider === PROVIDER,
  );
}
