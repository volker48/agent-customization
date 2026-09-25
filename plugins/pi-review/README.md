# Pi Review for Codex

Ask Codex: **“Use Pi Review to review my current changes.”** Codex prepares a review brief,
starts independent Pi reviewers, and verifies and reconciles their findings.

Defaults: `opencode/muse-spark-1.3-contributor-free` and `opencode/gemini-3.8-flash`.
Copy `config.example.json` to `~/.pi/agent/codex-review.json` to customize the panel,
per-model thinking, and deadline. Config also supports `PI_CODING_AGENT_DIR`,
`PI_REVIEW_CONFIG`, and `--config`. Repeated `--model provider/id` replaces the panel for one run.

## Requirements

- Node 22.18+ (native TypeScript execution).
- Pi on PATH, with RPC `agent_settled` support (verified with installed Pi 0.85.0).
- Models and authentication configured in Pi. Use `PI_REVIEW_BIN` for another executable.

There are no runtime dependencies to install. The runner uses Pi's documented RPC interface
because it reuses the installed CLI without coupling the plugin to a separate SDK install.
The local SDK documentation was the starting point; the installed SDK import currently fails
on a missing `@earendil-works/pi-server` dependency, whereas the bundled CLI works.

## Direct use

From this plugin directory:

```sh
node scripts/review.ts --list-models
node scripts/review.ts --cwd /path/to/repo --prompt-file /path/to/brief.md --output /path/to/new-review
node --test tests/*.test.ts
```

The brief should include intent, repository policy, scope, actual diff, changed paths, and
verification evidence. Reviewers can read source but cannot run git or tests. For untracked
files, include their contents or paths explicitly. Each run starts fresh Pi sessions and
writes the brief plus numbered reviewer results and combined `results.json` to a new output
directory. Keep output outside the repository. Files use owner-only permissions; they may
contain source code. Delete them when no longer needed.

Results include final review text, final-turn usage as reported by Pi (not total session
cost), provider/model identity, and explicit error status. Partial failure preserves successful
results and exits 1. Timeouts include startup and automatic retries. SIGINT/SIGTERM cancels
reviewer processes. No sessions are saved by Pi and no persistent daemon is started.

The read/grep/find/ls allowlist prevents tool-based edits; it does not sandbox filesystem
reads. Extensions, skills, templates, and automatic context loading are disabled. Credentials,
catalogs, and models.json still come from Pi. Extension-only providers are not loaded.

## Development checks

Use an existing TypeScript, oxlint, and oxfmt toolchain; no build is needed. Type-check with
`tsc --noEmit --strict --skipLibCheck --target ES2023 --module NodeNext --allowImportingTsExtensions --typeRoots /path/to/node_modules/@types scripts/review.ts tests/review.test.ts`.
Run the plugin-creator manifest validator and skill-creator quick validator after editing.

## Source and local updates

The canonical source lives in this repository at `plugins/pi-review`. The personal
marketplace discovers it through `~/plugins/pi-review`, a symlink to this directory.
Edit the repository files, run the development checks above, and reinstall to refresh
Codex's cached copy. User configuration stays in `~/.pi/agent/codex-review.json`.

Use the plugin-creator skill's update workflow: validate the personal marketplace name,
run its `update_plugin_cachebuster.py` helper against this plugin directory, then run
`codex plugin add pi-review@personal`. Start a new Codex task to pick up the update.
