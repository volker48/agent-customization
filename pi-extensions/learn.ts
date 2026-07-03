import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const PI_EXTENSION_AUTHORING_STANDARDS = [
  "Follow the Pi coding-agent extension authoring standards exactly:",
  "",
  "Artifact contract:",
  "- Create ONE reusable Pi coding-agent extension, not a loose note or generic write-up.",
  "- Keep implementation in TypeScript. Do not add Python.",
  "- Put extension code under pi-extensions/ using the existing repository conventions.",
  "- Prefer small exported helpers for prompt builders, parsers, or pure logic so tests " +
    "can cover them.",
  "- Add or update Vitest tests under tests/ for the behavior you introduce.",
  "- If the extension needs a non-trivial helper module, put it under " +
    "pi-extensions/<extension-name>/ or pi-extensions/lib/ and import it with .js " +
    "extension specifiers.",
  "",
  "Command and UX contract:",
  "- Register a Pi slash command with pi.registerCommand when the learned workflow " +
    "should be user-invoked.",
  "- The command description must be short, concrete, and action-oriented.",
  "- Validate command args and show ctx.ui.notify(...) errors for invalid usage.",
  "- For long-running work, use ctx.ui.setStatus/setWidget with a cancellable " +
    "AbortController when practical.",
  "- Prefer pi.sendUserMessage(...) when the command should ask Pi to continue with " +
    "a normal agent turn.",
  "- Prefer pi.sendMessage(...) for structured extension output that should not trigger a turn.",
  "",
  "Source-gathering contract:",
  "- Use the existing Pi tools and repo context. Do not invent commands, flags, files, " +
    "APIs, or package names.",
  "- Treat local paths, URLs, pasted notes, and prior conversation references as " +
    "sources to inspect.",
  "- Treat prose after a source as requirements that shape the extension; do not fetch " +
    "the first URL/path and ignore the rest.",
  "- If scope is ambiguous, make a reasonable, explicit choice and proceed.",
  "",
  "Quality bar:",
  "- Keep the extension focused on one repeatable capability.",
  "- Preserve user constraints and security expectations.",
  "- Include exact verification steps and tests.",
  "- Follow the existing TypeScript style, package scripts, and imports already used in this repo.",
  "- Do not modify unrelated files or revert user changes.",
].join("\n");

function normalizedRequest(userRequest: string): string {
  const request = userRequest.trim();
  if (request) {
    return request;
  }

  return (
    "the workflow we just went through in this conversation — review the steps taken " +
    "and distill them into a reusable Pi coding-agent extension"
  );
}

export function buildLearnPrompt(userRequest: string): string {
  const request = normalizedRequest(userRequest);

  return [
    "[/learn] The user wants you to build a reusable Pi coding-agent extension from " +
      "the request below, and save it.",
    "",
    "THE REQUEST:",
    request,
    "",
    "The request is open-ended and may mix two kinds of content, in any order: " +
      "SOURCES to gather (directories, file paths, URLs, what we just did, pasted " +
      "notes) AND REQUIREMENTS that shape the extension (what to focus on, what to " +
      "leave out, scope, naming, UX, safety, and the angle to take). Treat EVERY " +
      "part of the request as load-bearing.",
    "",
    "In particular, prose that comes after a path or link is NOT incidental. " +
      "A request like `https://api.example.com/docs focus on auth, skip deprecated " +
      "endpoints` means: gather the URL AND honor `focus on auth, skip deprecated " +
      "endpoints` as implementation requirements. Never fetch the first source and " +
      "ignore the rest.",
    "",
    "Do this:",
    "1. Gather every source the user named using the tools and context you already " +
      "have: read local files/directories, search the repo, fetch URLs when web " +
      "access is available, inspect this conversation if they referred to what just " +
      "happened, and use pasted text as-is.",
    "2. Apply every requirement, focus, and constraint in the request to the extension " +
      "you author. These govern what the extension covers and emphasizes, not just " +
      "which sources you read.",
    "3. Build ONE focused Pi coding-agent extension in TypeScript. Save the code in " +
      "the repo and add/update tests for it.",
    "4. When done, summarize the extension name, command name if any, files changed, " +
      "and the verification you ran.",
    "",
    PI_EXTENSION_AUTHORING_STANDARDS,
  ].join("\n");
}

export default function learnExtension(pi: ExtensionAPI) {
  pi.registerCommand("learn", {
    description: "Build a reusable Pi extension from docs, code, or this chat",
    handler: async (args, ctx) => {
      const prompt = buildLearnPrompt(args);
      pi.sendUserMessage(prompt);
      ctx.ui.notify(
        args.trim()
          ? "Learning a Pi extension from what you described…"
          : "Learning a Pi extension from this conversation…",
        "info",
      );
    },
  });
}
