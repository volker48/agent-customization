---
name: lol-wut
description: >-
  Rewrite the agent's last assistant response in simplified English, inspired
  by shared principles from ASD-STE100, Caterpillar Technical English, and
  plain-language guidance. Short clear sentences, prefer active voice, plain
  words, one consistent term per concept, no unnecessary jargon. Keep paths,
  URLs, code, commands, identifiers, citations, and exact quotes unchanged.
  Preserve negation, modality, conditions, warnings, and qualifiers. Use when
  the user asks to simplify, rephrase, or 'lol-wut' the previous response.
disable-model-invocation: true
---

# lol-wut

Rephrase the most recent assistant response in simplified English. Keep the
meaning — simplify the language, never the content. NOTE: this skill is
inspired by the principles of the above systems; it does not perform formal
conformance checking against any of them.

When the user invokes this skill, the source text is the last assistant
response before this invocation. If no previous assistant response exists,
say so briefly instead of guessing.

## Procedure

1. Read the source assistant response.
2. Identify jargon, long sentences, passive voice, filler, ambiguity, and
   repeated synonyms.
3. Rewrite quietly. Do the analysis in your head, and output only the rewrite.
4. Confirm the rewrite preserves meaning, formatting, and literal content.

## Rules

- **One idea per sentence.** ~20 words is a soft target, not a hard limit.
- **Prefer active voice** when the source names the actor. Do not invent an
  actor to remove passive voice.
- **Remove unnecessary jargon.** Keep necessary technical terms; explain them
  when useful.
- **One consistent term per concept**, and do not use one term for different
  concepts.
- **Cut filler** ("it should be noted that"). Do not omit necessary words
  merely to shorten a sentence.
- **Expand an acronym only if its expansion is established** in the message or
  conversation. Otherwise keep it unchanged; do not guess.
- **Keep literal content unchanged:** file paths, URLs, code, commands,
  identifiers, citations, and exact quotations. Preserve the force and scope
  of negation, modality, conditions, warnings, and qualifiers.
- **Keep clear text unchanged.** If the response is already clear and follows
  these rules, return it as-is.
- **Preserve structure:** Markdown, code blocks, inline code, links, list
  order and numbering, tables, and warning labels (WARNING, CAUTION, IMPORTANT).
- **Do not resolve ambiguity by guessing.** If two meanings are plausible,
  keep the ambiguous term or note the ambiguity; do not silently pick one.
- **When splitting a sentence**, keep each condition attached to every action
  it controls (unless, only if, all/any/none, must/should/may).

## Examples

- "The aforementioned methodology leverages a multifaceted approach to
  optimize throughput." →
  "This method uses several approaches to improve the rate at which work is
  completed."
- "It should be noted that the system is currently unable to function in the
  absence of electrical power." → "The system currently cannot work without
  electrical power."
- "If the service is currently unavailable, it is recommended that you should
  retry `curl -fsS https://api.example.com/health` after 30 seconds." →
  "If the service is currently unavailable, you should retry
  `curl -fsS https://api.example.com/health` after 30 seconds."

## Gotchas

- Don't talk down or strip technical accuracy for brevity.
- Don't change facts, numbers, instructions, or literal technical content.
- Don't drop negation, warnings, conditions, or time/safety qualifiers.
- Don't just compress — clarity, not word count. Note: the user-only guarantee
  of `disable-model-invocation` applies to clients that support it (e.g.
  Claude Code, Pi); some clients ignore it and may still surface the skill.
