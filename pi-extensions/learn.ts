import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SKILL_AUTHORING_STANDARDS = [
  "Follow the repository skill-authoring standards exactly:",
  "",
  "Artifact contract:",
  "- Create ONE reusable agent skill, not a Pi extension, plugin, hook, or generic note.",
  "- Save the skill as a SKILL.md file under skills/<skill-name>/ using the " +
    "existing repository skill layout.",
  "- Use lowercase-hyphenated skill names. Keep the skill focused on one " +
    "repeatable capability.",
  "- Start SKILL.md with YAML frontmatter containing at least name and " + "description.",
  "- Make the description action-oriented and specific so the agent can decide " +
    "when to use the skill.",
  "- If the skill needs scripts, templates, or reference material, place them " +
    "under scripts/, templates/, or references/ inside that skill directory and " +
    "reference them by relative path from SKILL.md.",
  "- Do not create or modify pi-extensions/ unless the user explicitly asks for " +
    "a Pi extension instead of a skill.",
  "",
  "Skill body contract:",
  "- Explain when to use the skill, prerequisites, workflow/procedure, pitfalls, " +
    "and verification.",
  "- Prefer exact commands, file paths, URLs, config keys, and API names that " +
    "appear in the gathered sources. Do not invent flags, commands, package " +
    "names, or APIs.",
  "- Frame instructions through the tools available to the agent, rather than as " +
    "human-only prose.",
  "- Keep the main SKILL.md concise and scannable; put bulky source extracts, " +
    "long examples, or generated assets in references/ or templates/.",
  "",
  "Source-gathering contract:",
  "- Use the existing tools and repo context. Do not invent commands, flags, " +
    "files, APIs, or package names.",
  "- Treat local paths, URLs, pasted notes, and prior conversation references as " +
    "sources to inspect.",
  "- Treat prose after a source as requirements that shape the skill; do not " +
    "fetch the first URL/path and ignore the rest.",
  "- If scope is ambiguous, make a reasonable, explicit choice and proceed.",
  "",
  "Quality bar:",
  "- Preserve user constraints and security expectations.",
  "- Add or update tests only if you add executable helper code for the skill.",
  "- Include exact verification steps and checks in the final response.",
  "- Follow the existing Markdown style and skill directory conventions in this repo.",
  "- Do not modify unrelated files or revert user changes.",
].join("\n");

export const PI_EXTENSION_AUTHORING_STANDARDS = SKILL_AUTHORING_STANDARDS;

function normalizedRequest(userRequest: string): string {
  const request = userRequest.trim();
  if (request) {
    return request;
  }

  return (
    "the workflow we just went through in this conversation — review the steps taken " +
    "and distill them into a reusable agent skill"
  );
}

export function buildLearnPrompt(userRequest: string): string {
  const request = normalizedRequest(userRequest);

  return [
    "[/learn] The user wants you to learn a reusable agent skill from " +
      "the request below, and save it.",
    "",
    "THE REQUEST:",
    request,
    "",
    "The request is open-ended and may mix two kinds of content, in any order: " +
      "SOURCES to gather (directories, file paths, URLs, what we just did, pasted " +
      "notes) AND REQUIREMENTS that shape the skill (what to focus on, what to " +
      "leave out, scope, naming, UX, safety, and the angle to take). Treat EVERY " +
      "part of the request as load-bearing.",
    "",
    "In particular, prose that comes after a path or link is NOT incidental. " +
      "A request like `https://api.example.com/docs focus on auth, skip deprecated " +
      "endpoints` means: gather the URL AND honor `focus on auth, skip deprecated " +
      "endpoints` as authoring requirements. Never fetch the first source and " +
      "ignore the rest.",
    "",
    "Do this:",
    "1. Gather every source the user named using the tools and context you already " +
      "have: read local files/directories, search the repo, fetch URLs when web " +
      "access is available, inspect this conversation if they referred to what just " +
      "happened, and use pasted text as-is.",
    "2. Apply every requirement, focus, and constraint in the request to the skill " +
      "you author. These govern what the SKILL.md covers and emphasizes, not just " +
      "which sources you read.",
    "3. Author ONE focused SKILL.md under skills/<skill-name>/ in this repo. " +
      "If useful, add supporting scripts, templates, or references inside that skill directory.",
    "4. When done, summarize the skill name, category or directory, files changed, " +
      "and the verification you ran.",
    "",
    SKILL_AUTHORING_STANDARDS,
  ].join("\n");
}

export default function learnExtension(pi: ExtensionAPI) {
  pi.registerCommand("learn", {
    description: "Learn a reusable skill from docs, code, or this chat",
    handler: async (args, ctx) => {
      const prompt = buildLearnPrompt(args);
      pi.sendUserMessage(prompt);
      ctx.ui.notify(
        args.trim()
          ? "Learning a skill from what you described…"
          : "Learning a skill from this conversation…",
        "info",
      );
    },
  });
}
