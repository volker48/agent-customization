---
name: lol-wut
description: "Rewrite the agent's last message in simplified English using the Big Three standards (ASD-STE100, Caterpillar Technical English, Plain English): short active sentences, plain words, one term per concept, no jargon, and no dropped meaning. Use when the user asks to simplify, rephrase, or 'lol-wut' the previous response."
disable-model-invocation: true
---

# lol-wut

Rephrase the agent's most recent message in simplified English. Keep ALL the
meaning and nuance — simplify the language, never the content.

## Procedure

1. Read the agent's last message.
2. Flag every: jargon and buzzword, sentence over ~20 words, passive voice,
   hedging/filler ("it should be noted that"), and repeated synonyms.
3. Rewrite those spots:

   - **One idea per sentence.** Aim for ~20 words or fewer.
   - **Active voice.** "The pump moves the oil," not "The oil is moved by the pump."
   - **Plain, common words.** Swap jargon for everyday terms.
   - **One term = one thing.** Pick one word per concept; don't hop synonyms.
   - **Cut filler.** Drop hedging and empty words.
   - **Define on first use.** Spell out acronyms; define technical terms once.
   - **Stay concrete.** Prefer the specific number, name, or step.

4. Check the rewrite still holds every fact, number, and instruction.

## Examples

- "The aforementioned methodology leverages a multifaceted approach to optimize throughput." →
  "This method uses several steps to get more work done."
- "It should be noted that the system is currently unable to function in the absence of electrical power." →
  "The system needs power to work."

## Gotchas

- Don't talk down (baby talk) or strip technical accuracy for brevity.
- Don't change facts, numbers, or instructions.
- Don't just compress — clarity, not word count.
