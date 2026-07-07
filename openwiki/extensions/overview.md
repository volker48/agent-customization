# Extensions and companion workflows

## Pi extension inventory

### Web search and fetch

- `pi-extensions/exa-search.ts` registers `exa_search`, backed by `pi-extensions/lib/exa-search-core.ts`. It requires Exa API access through environment configuration (README names `EXA_API_KEY`).
- `pi-extensions/webfetch.ts` registers `webfetch`, backed by `pi-extensions/lib/webfetch-core.ts`. It fetches HTTP(S) text-like content, handles GitHub links directly, converts HTML to markdown, supports fragments, has probe/smart modes, filters unsafe headers, blocks private hosts unless explicitly overridden, and truncates output.

Fusion reuses these cores through restricted inner tools; see [Fusion inner tools](../fusion/inner-tools.md).

### Claude review Pi extension

`pi-extensions/claude-review/index.ts` registers a Pi command that delegates current-diff review to the `claude` CLI. The review subprocess is intentionally read-only by tool allowlist:

```text
Bash,Read,Glob,Grep,LSP,WebFetch,WebSearch,Skill
```

Key behavior:

- Supports review levels parsed in `args.ts` (`low`, `medium`, `high`, `max` per `CONTEXT.md`).
- Wait mode runs after `ctx.waitForIdle()` and times out after 20 minutes.
- Background mode creates jobs through `jobs.ts`/`claude-bg.ts`.
- Review output is rendered through a custom Claude review message (`render.ts`).
- Auto-fix only sends a Pi user message when the marked review result reports findings; missing/no findings produce notifications instead.

Relevant tests: `tests/claude-review.test.ts`.

### RTK integration

`pi-extensions/rtk.ts` intercepts Pi `bash` tool calls and invokes `rtk rewrite <command>` before execution. It stores the original/rewritten command by tool call id so the later tool result can include rewrite metadata.

Configuration:

- Flag: `--rtk-bin` via `pi.registerFlag`.
- Env fallback: `PI_RTK_BIN`.
- Debug env: `PI_RTK_DEBUG`.
- Rewrite timeout: 2 seconds.

Relevant tests: `tests/rtk.test.ts`, `tests/rtk.e2e.test.ts`, and `scripts/verify-rtk-extension.mjs`.

### Autoname

`pi-extensions/autoname.ts` names Pi sessions for later retrieval. It reads transcript content, calls a configured model, enforces a short title contract, and falls back to another model if needed.

Defaults from source:

- `PI_AUTONAME_MODEL` or `openai-codex/gpt-5.5`.
- `PI_AUTONAME_FALLBACK_MODEL` or `anthropic/claude-haiku-4-5`.
- Optional prompt override from `PI_AUTONAME_PROMPT_FILE`.
- Max title length 60 characters.

Relevant tests: `tests/autoname.test.ts`.

### Learn

`pi-extensions/learn.ts` registers `/learn`, which turns a user request or the current conversation into a prompt asking Pi to create one reusable agent skill. The prompt follows the Hermes-style stable behavior: gather open-ended sources, honor trailing requirements after paths/URLs, and save one `SKILL.md` under `skills/<skill-name>/` with optional `scripts/`, `templates/`, or `references/` support files instead of creating another Pi extension.

Relevant tests: `tests/learn.test.ts`.

### Sound notifications

Sound notification support spans all harnesses:

- Pi: `pi-extensions/sound-notifications.ts` registers event handlers for Pi events and plays random files from `~/Documents/sounds/<event>/`.
- Claude Code: `claude-hooks/hooks.json` maps hook events to `claude-hooks/play-sound.py`.
- OpenCode: `opencode-plugins/sound-notifications.ts` exports an OpenCode plugin with hook handlers.

`README.md` documents canonical event-folder names, cooldown env vars, and `create-sound-symlinks.sh`, which symlinks Claude/OpenCode event names to Pi event directories.

## Claude Code plugin: Pi companion

`plugins/pi/` is a Claude Code plugin that lets Claude delegate work to Pi.

User-facing command templates live in `plugins/pi/commands/` and call:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" <command>
```

`plugins/pi/scripts/pi-companion.mjs` dispatches:

- `setup`
- `implement --wait|--background [--model provider/model]`
- `review --wait [--model provider/model] [--target ref]`
- `continue --wait [job-id|latest]`
- `status`
- `result [job-id|latest]`
- `cancel [job-id|latest]`
- `session-cleanup`

Job state is in `plugins/pi/scripts/lib/jobs.mjs`. Default data dir is `~/.local/state/claude-pi-companion`, with per-workspace hashed directories, JSON job records, JSONL logs, lock files, and stale-job detection when worker processes die.

Recent history hardened this area: job status sets, pid helpers, stale worker handling, locked review updates, review outcome derivation, and background cancellation tests were all touched in the latest commits.

Relevant tests: `tests/claude-pi-*.test.ts` and `tests/helpers/process.ts`.

## Skills and prompts

- `skills/fusion/SKILL.md` teaches agents to curate code bundles for `/fusion --file` because Fusion inner models cannot read the filesystem.
- `skills/claude-review/SKILL.md` supports Claude review workflows.
- `prompts/large-coding-task.md` and `prompts/reflect.md` are shipped via the Pi package.

## Change guidance

- For Pi extensions, prefer small exported pure helpers so tests can cover parsing, prompt building, and formatting without full Pi runtime.
- For Claude/Pi companion changes, test both foreground and background modes when state transitions or cancellation are involved.
- Do not mix harness terms: Pi extensions, Claude Code hooks/commands, OpenCode plugins.
- Never document or depend on live secret values. Only describe required env var names and placeholder setup.
