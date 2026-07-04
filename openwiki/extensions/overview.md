# Extensions Overview

All Pi extensions besides Fusion and Remote Control. Each is a TypeScript file in `pi-extensions/` with a default-export function receiving Pi's `ExtensionAPI`.

## Sound Notifications

Three parallel implementations for Claude Code, OpenCode, and Pi. All share a single convention: sounds live in `~/Documents/sounds/<event_name>/` with one or more audio files per folder. A random file is played each time the event fires.

### Pi (`pi-extensions/sound-notifications.ts`)

- Scans `~/Documents/sounds/<event>/` on load for each supported event
- Registers `pi.on(<event>, ...)` handlers for events with at least one sound file
- Picks a random file, enforces a cooldown (default 250 ms via `SOUND_MIN_INTERVAL_MS`), spawns `afplay` detached
- Events: `session_start`, `session_shutdown`, `session_switch`, `session_fork`, `session_compact`, `session_tree`, `agent_start`, `agent_end`, `turn_start`, `turn_end`, `tool_call`, `tool_result`, `model_select`, `input`, `user_bash`

### Claude Code (`claude-hooks/`)

- **`hooks.json`** — Declares hook event→command mappings. Merge into `~/.claude/settings.json`
- **`play-sound.py`** — Reads `hook_event_name` from stdin JSON, plays random file from matching folder
- Supports `SOUNDS_BASE` for custom base directory
- Events: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `Stop`, `PreToolUse`, `PostToolUse`, `SubagentStart`, `SubagentStop`, `PreCompact`, `Notification`

### OpenCode (`opencode-plugins/sound-notifications.ts`)

- Exports `SoundNotifications` plugin receiving OpenCode client
- Returns hooks object mapping event names to handlers
- Events: `session.created`, `session.compacted`, `session.idle`, `session.error`, `tool.execute.before/after`, `tui.prompt.append`, `tui.command.execute`, `file.edited`, `permission.asked`, and more

### Cross-Agent Sound Sharing (`create-sound-symlinks.sh`)

Pi's snake_case names are canonical. The script creates symlinks from OpenCode (dot.notation) and Claude Code (PascalCase) event names to the Pi folders:

```
~/Documents/sounds/SessionStart     → session_start
~/Documents/sounds/Stop             → agent_end
~/Documents/sounds/session.created  → session_start
```

Safe to re-run — skips existing correct symlinks, warns about conflicts.

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `SOUNDS_BASE` (Claude Code only) | `~/Documents/sounds` | Base directory |
| `SOUND_MIN_INTERVAL_MS` | `250` | Cooldown between sounds |
| `SOUND_DEBUG` | `0` | Set to `1` for debug logs |

## Exa Search (`pi-extensions/exa-search.ts`)

Registers an `exa_search` tool that queries the [Exa](https://exa.ai) search API. Requires `EXA_API_KEY`.

Parameters: `query` (required), `numResults` (optional), `type` (optional search type), `textMaxCharacters` (optional). Calls `executeWebSearch()` from `lib/exa-search-core.ts`.

## Web Fetch (`pi-extensions/webfetch.ts`)

Registers a `webfetch` tool for fetching web pages without JS rendering. Features:
- Markdown conversion (via `@mozilla/readability`, `linkedom`, `turndown`)
- GitHub repo/blob URL handling (converts to raw markdown)
- Probe mode and smart fallback strategy
- Output truncation to lines/bytes, with full output saved to temp file

Calls `executeWebfetch()` from `lib/webfetch-core.ts`. The implementation is shared with Fusion's inner `webfetch` tool (see [Inner Tools](../fusion/inner-tools.md)).

## RTK (`pi-extensions/rtk.ts`)

Intercepts `bash` tool calls and delegates command rewriting to `rtk rewrite <command>`. RTK (Rust Token Killer) is an external CLI proxy that produces terser equivalents of shell commands to cut token cost.

- Registers a `--rtk-bin` flag and reads `PI_RTK_BIN` env var (default: `rtk`)
- On `tool_call` events for the `bash` tool, runs `rtk rewrite <command>` with a 2-second timeout
- Only swaps the command if RTK returns a different non-empty string
- Stores rewrites in a per-session map for audit
- Debug logging via `PI_RTK_DEBUG=1`

## Autoname (`pi-extensions/autoname.ts`)

Auto-titles Pi sessions by feeding the transcript to a small LLM so sessions are retrievable later.

- Default model: `openai-codex/gpt-5.5` (override via `PI_AUTONAME_MODEL`)
- Fallback model: `anthropic/claude-haiku-4-5` (override via `PI_AUTONAME_FALLBACK_MODEL`)
- Max transcript length: 30,000 chars; max output tokens: 80; max name length: 60 chars
- Custom prompt file via `PI_AUTONAME_PROMPT_FILE`
- Names must be 3–8 words, concrete, searchable, no "Session" prefix

## Claude Review (`pi-extensions/claude-review/`)

A Pi extension that delegates current-diff review to Claude Code's `/code-review`:

- **`index.ts`** — Registers the `/claude-review` command. Waits for Pi to be idle, then spawns `claude --permission-mode auto --allowed-tools "Bash,Read,Glob,Grep,LSP,WebFetch,WebSearch,Skill" -p "/code-review <level> <context>"`
- **`args.ts`** — Parses review level (`low`/`medium`/`high`/`max`), `--no-fix` flag, and context message
- **`render.ts`** — Custom message rendering for review results

### Review Levels

| Level | Use case |
|---|---|
| `low` | Fastest check, quick smoke reviews |
| `medium` | Default for normal code changes |
| `high` | Bug fixes, security-sensitive code, cross-file changes |
| `max` | Substantial or high-risk changes |

### Auto-Fix vs Review-Only

- **Auto-fix** (default): Pi receives Claude's review and immediately acts on actionable findings via `pi.sendUserMessage(buildAutoFixPrompt(details))`
- **Review-only** (`--no-fix`): Pi surfaces findings without starting implementation

The review subprocess is **read-only by policy**: the allowed tools exclude `Edit`, `Write`, `NotebookEdit`, `TodoWrite`, `Agent`, `Task*`, `Cron*`, `RemoteTrigger`, and `Workflow`. Timeout: 20 minutes.

### Claude Review Skill (`skills/claude-review/`)

A shared Agent Skill version of the workflow, usable by any compatible agent:
- [`skills/claude-review/SKILL.md`](../../skills/claude-review/SKILL.md) — Skill description and instructions
- [`skills/claude-review/scripts/run-claude-review.sh`](../../skills/claude-review/scripts/run-claude-review.sh) — Shell wrapper

## Themes (`pi-themes/`)

Two color themes for the Pi TUI:
- **`obsec-dark.json`** — Dark theme
- **`obsec-light.json`** — Light theme

## Prompts (`prompts/`)

Reusable prompt templates:
- **`large-coding-task.md`** — Template for large multi-step coding tasks
- **`reflect.md`** — Short reflection prompt

## Source Map

- [`pi-extensions/sound-notifications.ts`](../../pi-extensions/sound-notifications.ts) — Pi sound extension
- [`claude-hooks/hooks.json`](../../claude-hooks/hooks.json) — Claude Code hook mappings
- [`claude-hooks/play-sound.py`](../../claude-hooks/play-sound.py) — Claude Code sound script
- [`opencode-plugins/sound-notifications.ts`](../../opencode-plugins/sound-notifications.ts) — OpenCode sound plugin
- [`create-sound-symlinks.sh`](../../create-sound-symlinks.sh) — Cross-agent symlink script
- [`pi-extensions/exa-search.ts`](../../pi-extensions/exa-search.ts) — Exa search extension
- [`pi-extensions/webfetch.ts`](../../pi-extensions/webfetch.ts) — Web fetch extension
- [`pi-extensions/rtk.ts`](../../pi-extensions/rtk.ts) — RTK interceptor extension
- [`pi-extensions/autoname.ts`](../../pi-extensions/autoname.ts) — Session auto-naming extension
- [`pi-extensions/claude-review/index.ts`](../../pi-extensions/claude-review/index.ts) — Claude review extension
- [`pi-extensions/claude-review/args.ts`](../../pi-extensions/claude-review/args.ts) — Review argument parsing
- [`pi-extensions/claude-review/render.ts`](../../pi-extensions/claude-review/render.ts) — Review result rendering
- [`skills/claude-review/SKILL.md`](../../skills/claude-review/SKILL.md) — Claude review skill
- [`pi-themes/obsec-dark.json`](../../pi-themes/obsec-dark.json) — Dark theme
- [`pi-themes/obsec-light.json`](../../pi-themes/obsec-light.json) — Light theme
- [`prompts/large-coding-task.md`](../../prompts/large-coding-task.md) — Large coding task prompt
- [`prompts/reflect.md`](../../prompts/reflect.md) — Reflection prompt
