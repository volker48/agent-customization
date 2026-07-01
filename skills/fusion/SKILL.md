---
name: fusion
description: Bundle curated repository files into a self-contained prompt and hand it to the multi-model Fusion panel for a second opinion (e.g. "does this refactor plan cohere?", "is this design sound?"). Use when a Fusion panel needs real code as evidence, since the panel and judge have no filesystem access.
---

# Fusion bundle

The Fusion panel and judge models see only the prompt string — they have **no
filesystem access**. To ask them about real code, curate the exact files that
matter and materialize their bytes into the prompt. You select the files; the
bundle script reads them deterministically (you never retype file contents).

You cannot invoke `/fusion` yourself (Pi commands are user-only). Your job ends
at producing the bundle path and telling the user the command to run.

## Workflow

1. Explore the repo with your normal tools and decide which files the panel
   needs. Keep the list tight — the panel pays for every byte, and curation is
   the whole point.
2. Run the bundle script from this skill directory, passing the framing question
   and the files/globs to include:

   ```bash
   ./scripts/bundle.sh \
     --question "Does this plan for the data-layer refactor cohere?" \
     "src/data/**/*.ts" "!**/*.test.ts" "docs/adr/0003-schema.md"
   ```

   It prints the path of a temp file containing the finished panel prompt
   (question + line-numbered files) and reports how many files / KB it bundled.
3. Tell the user to run the Fusion panel on it:

   ```text
   /fusion --file <printed-path>
   ```

## File selection

- Paths and globs are relative to the current project (`--root <dir>` to
  override). `*`/`**` globs and `!pattern` excludes are supported.
- `node_modules`, `dist`, `.git`, `build`, and similar dirs are pruned
  automatically. Files ignored by `.gitignore` are dropped from glob matches so
  secrets/artifacts (e.g. `.env`) can't leak to the panel; a git-ignored file
  named explicitly is rejected with an error rather than silently bundled.
- Absolute paths and paths escaping the root (`..`) are rejected. 1 MB per-file
  cap; oversized files abort with an error naming them.
