# Fusion bundle: handing curated files to the panel

The Fusion panel and judge models have **no filesystem access** by design — they
see only the prompt string. When a task needs real code as evidence (e.g. "does
this refactor plan cohere?"), the calling model explores the repo, then writes a
**manifest** naming the exact files to bundle. A human runs
`/fusion --manifest <path>`, which reads the manifest, materializes those files
into the prompt verbatim, and hands it to the panel.

The calling model cannot invoke `/fusion` itself (Pi commands are user-only), so
the model's job ends at writing the manifest and telling the user to run it.

## Manifest schema

Write JSON to a throwaway path (e.g. under the OS temp dir):

```json
{
  "files": ["src/data/**/*.ts", "!**/*.test.ts", "docs/adr/0003-schema.md"],
  "question": "Does this plan for the data-layer refactor sound coherent?",
  "root": "/abs/path/to/repo"
}
```

- `files` (required): array of paths relative to `root`. Supports `*`/`**`
  globs and `!pattern` excludes. Default-ignored dirs (`node_modules`, `dist`,
  `.git`, `build`, …) are pruned automatically, and paths ignored by
  `.gitignore` are dropped from glob matches so secrets/artifacts (e.g. `.env`)
  can't leak to the panel. 1 MB per-file cap. Absolute paths and paths that
  escape `root` (via `..`) are rejected; a literal file that is git-ignored is
  rejected with an error rather than silently bundled.
- `question` (optional): the framing/plan text. May instead be supplied on the
  command line; command-line text wins over the manifest field.
- `root` (optional): base directory for resolving `files`. Defaults to the
  session working directory.

## Workflow

1. Explore the codebase with normal tools; decide which files the panel needs.
2. Write the manifest to a temp file. Keep the file list tight — the panel pays
   for every byte, and curation is the whole point of this step.
3. Tell the user to run `/fusion --manifest <path> [extra question text]`.

The command reports how many files/KB it bundled before running the panel.
