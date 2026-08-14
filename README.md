# Agent Customization

Extensions, hooks, plugins, and themes for AI coding agents — currently supporting [Claude Code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview), [OpenCode](https://opencode.ai), and the [Pi agent](https://github.com/badlogic/pi-mono).

## Repository Structure

```
claude-hooks/          # Claude Code hooks (Python)
  hooks.json           # Hook event → command mappings (merge into ~/.claude/settings.json)
  play-sound.py        # Sound player invoked by hooks

opencode-plugins/      # OpenCode plugins (TypeScript)
  sound-notifications.ts

pi-extensions/         # Pi agent extensions (TypeScript)
  sound-notifications.ts
  exa-search.ts        # Exa web search tool
  webfetch.ts          # Generic web fetch tool
  rtk.ts               # RTK bash rewrite hook
  fusion/              # Multi-model Fusion panel and judge command
  cursor/              # Cursor subscription models as a pi provider (SDK + CLI bridge)

pi-subagents/          # Package-owned prompt overrides for selected pi-subagents roles
  agents/              # Customized prompts published through the Pi package manifest

skills/                # Agent Skills shared by Pi and compatible agents
  claude-review/       # Claude Code /code-review workflow

pi-themes/             # Pi agent color themes
  obsec-dark.json
  obsec-light.json

create-sound-symlinks.sh # Shares sound files across harness event names
```

## Sound Notifications

All three agent harnesses can play audio feedback when events fire (tool calls, session start, prompt submission, etc.). They share a single convention: sounds live in **`~/Documents/sounds/<event_name>/`**, with one or more audio files (`.mp3`, `.aiff`, `.wav`, `.m4a`) per folder. A random file from the matching folder is played each time the event fires.

### How It Works Per Agent

#### Claude Code — `claude-hooks/`

Claude Code uses a [hooks](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/hooks) system. The two files work together:

- **`hooks.json`** — Declares which hook events should trigger the sound script. Every supported event (`SessionStart`, `Stop`, `PreToolUse`, `PostToolUse`, `Notification`, etc.) maps to the same command, run asynchronously so it never blocks the agent. Merge this into your `~/.claude/settings.json`.
- **`play-sound.py`** — A Python script invoked by each hook. Claude Code pipes a JSON payload to stdin that includes `hook_event_name`. The script reads that name, looks for `~/Documents/sounds/<hook_event_name>/`, picks a random audio file, and spawns `afplay` in a detached process.

The script also enforces a **cooldown** (default 250 ms via a timestamp written to `/tmp/claude-sound-last-play`) to prevent sound spam from rapid-fire events.

**Installation:**

```bash
# Copy the script into Claude Code's hooks directory
mkdir -p ~/.claude/hooks
cp claude-hooks/play-sound.py ~/.claude/hooks/play-sound.py
chmod +x ~/.claude/hooks/play-sound.py

# Merge hooks.json into your ~/.claude/settings.json (add the "hooks" key)
```

Claude Code event names used as folder names: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `Stop`, `PreToolUse`, `PostToolUse`, `SubagentStart`, `SubagentStop`, `PreCompact`, `Notification`.

#### Pi Agent — `pi-extensions/sound-notifications.ts`

Pi uses a TypeScript extension API. The extension:

1. Enumerates a list of supported event names (e.g. `session_start`, `agent_end`, `tool_call`, `input`).
2. On load, scans `~/Documents/sounds/<event>/` for each event to build a file map.
3. Registers an `pi.on(<event>, ...)` handler for every event that has at least one sound file.
4. The handler picks a random file, enforces the cooldown, and spawns `afplay` detached.

**Installation:** Copy or symlink `pi-extensions/sound-notifications.ts` into your Pi extensions directory (typically `~/.pi/agent/extensions/`).

Pi event names used as folder names: `session_start`, `session_shutdown`, `session_switch`, `session_fork`, `session_compact`, `session_tree`, `agent_start`, `agent_end`, `turn_start`, `turn_end`, `tool_call`, `tool_result`, `model_select`, `input`, `user_bash`.

#### OpenCode — `opencode-plugins/sound-notifications.ts`

OpenCode uses a plugin system with a similar pattern to Pi. The plugin:

1. Exports a `SoundNotifications` plugin that receives an OpenCode client.
2. Scans `~/Documents/sounds/<event>/` for each supported event on load.
3. Returns a hooks object mapping event names to handler functions.
4. Each handler picks a random file, enforces the cooldown, and spawns `afplay` detached.

**Installation:** Copy `opencode-plugins/sound-notifications.ts` into `.opencode/plugins/` in your project or home directory.

OpenCode event names used as folder names: `session.created`, `session.compacted`, `session.idle`, `session.error`, `tool.execute.before`, `tool.execute.after`, `tui.prompt.append`, `tui.command.execute`, `file.edited`, `permission.asked`, and [many more](opencode-plugins/sound-notifications.ts).

### Sharing Sounds Across Agents with `create-sound-symlinks.sh`

Each agent harness has its own event naming convention:

| Concept          | Pi (snake_case)    | OpenCode (dot.notation) | Claude Code (PascalCase) |
| ---------------- | ------------------ | ----------------------- | ------------------------ |
| Session created  | `session_start`    | `session.created`       | `SessionStart`           |
| Session ended    | `session_shutdown` | —                       | `SessionEnd`             |
| Agent finished   | `agent_end`        | `session.idle`          | `Stop`                   |
| Before tool runs | `tool_call`        | `tool.execute.before`   | `PreToolUse`             |
| After tool runs  | `tool_result`      | `tool.execute.after`    | `PostToolUse`            |
| User input       | `input`            | `tui.prompt.append`     | `UserPromptSubmit`       |
| Compaction       | `session_compact`  | `session.compacted`     | `PreCompact`             |
| User shell cmd   | `user_bash`        | `tui.command.execute`   | —                        |

Rather than duplicating sound files into separate folders for each convention, the **`create-sound-symlinks.sh`** script creates symlinks from both OpenCode and Claude Code event names to the corresponding Pi event directories:

```bash
# Run once after creating your Pi sound folders
./create-sound-symlinks.sh
```

This creates symlinks like:

```
# OpenCode
~/Documents/sounds/session.created     →  session_start
~/Documents/sounds/session.idle        →  agent_end
~/Documents/sounds/tool.execute.before →  tool_call
...

# Claude Code
~/Documents/sounds/SessionStart        →  session_start
~/Documents/sounds/Stop                →  agent_end
~/Documents/sounds/PreToolUse          →  tool_call
~/Documents/sounds/PostToolUse         →  tool_result
~/Documents/sounds/UserPromptSubmit    →  input
~/Documents/sounds/SessionEnd          →  session_shutdown
~/Documents/sounds/PreCompact          →  session_compact
```

The script is safe to re-run — it skips existing correct symlinks and warns about conflicts.

Some events are agent-specific and have no cross-agent equivalent:

- **Pi-only:** `session_switch`, `session_fork`, `session_tree`, `agent_start`, `turn_start`, `turn_end`, `model_select`
- **Claude Code-only:** `SubagentStart`, `SubagentStop`, `Notification`

If you want sounds for those, create their folders manually.

### Setup from Scratch

```bash
# 1. Create sound directories (Pi naming convention as the canonical source)
mkdir -p ~/Documents/sounds/{session_start,session_shutdown,agent_start,agent_end,tool_call,tool_result,input,user_bash,session_compact,turn_start,turn_end}

# 2. Drop audio files into any folders you want sounds for
#    e.g. cp ~/Downloads/ding.mp3 ~/Documents/sounds/agent_end/

# 3. Create OpenCode and Claude Code symlinks so they share the same files
./create-sound-symlinks.sh

# 4. (Optional) Create folders for agent-specific events that have no Pi equivalent
#    e.g. mkdir -p ~/Documents/sounds/{SubagentStart,SubagentStop,Notification}

# 5. Install the extensions/hooks for your agent(s) of choice (see above)
```

### Environment Variables

All three implementations support:

| Variable                         | Default              | Description                                    |
| -------------------------------- | -------------------- | ---------------------------------------------- |
| `SOUNDS_BASE` (Claude Code only) | `~/Documents/sounds` | Base directory for sound folders               |
| `SOUND_MIN_INTERVAL_MS`          | `250`                | Minimum milliseconds between sounds (cooldown) |
| `SOUND_DEBUG`                    | `0`                  | Set to `1` to print debug logs to stderr       |

## Other Extensions

### Pi: Exa Search (`pi-extensions/exa-search.ts`)

Registers an `exa_search` tool that queries the [Exa](https://exa.ai) search API. Returns ranked links with URLs, metadata, and text snippets. Requires `EXA_API_KEY` in your environment.

### Pi: Web Fetch (`pi-extensions/webfetch.ts`)

Registers a `webfetch` tool for fetching web pages directly. Supports markdown conversion,
probing, smart fallback strategies, and direct GitHub/GitLab repository/blob links. Agents can
pass GitHub or GitLab repo roots (for README source markdown) or blob file URLs without
converting them to raw URLs first.

HTML-to-markdown conversion depends on runtime packages in this repository. Use the
extension from this checkout (or distribute it as a pi package); copying only
`pi-extensions/webfetch.ts` elsewhere will not copy those dependencies.

### Pi: Subagent definitions (`pi-subagents/`)

Publishes package-owned prompt overrides for the `context-builder`, `researcher`, and
`reviewer` roles while keeping local model, thinking, and tool selection in
`~/.pi/agent/settings.json`. Unmodified roles continue to use the bundled definitions. The
local web-tool mapping replaces `web_search` with `exa_search` and collapses
`fetch_content`/`get_search_content` into `webfetch`.

The installed `agent-customization` Pi package exposes these definitions through
`pi.subagents.agents`; no user-scope symlinks are required. See
[`pi-subagents/README.md`](pi-subagents/README.md) for provenance and update guidance.

### Pi: RTK (`pi-extensions/rtk.ts`)

Intercepts `bash` tool calls and delegates command rewriting to `rtk rewrite <command>`. Only rewrites when RTK returns a different non-empty command. Supports `PI_RTK_BIN` or Pi's `--rtk-bin` flag for binary overrides.

### Pi: Fusion (`pi-extensions/fusion/`)

Adds a `/fusion` command that runs a configured multi-model panel, judges the panel
responses, and sends a synthesis prompt back to the active model. The judge uses
binary question decomposition inspired by the BinEval framework: see
[“Ask, Don’t Judge: Systematic Evaluation via Binary Decomposition”][bineval]
(arXiv:2606.27226).

[bineval]: https://arxiv.org/abs/2606.27226

### Pi: Cursor bridge (`pi-extensions/cursor/`)

Use the models available in your Cursor subscription as a pi model provider. Cursor
exposes no raw model-inference API, so this extension bridges at the agent level:
each pi turn drives a Cursor agent run. The **Cursor agent does the file/shell work
with its own harness** — pi's built-in tools are bypassed while a `cursor/*` model
is active. Completed Cursor tool activity is shown as non-executable success/error
cards in the pi transcript; those cards are observational and never cause pi to run
the tool a second time. Assistant text and thinking are buffered until the Cursor
run finishes so the final response appears after its tool cards.

**Setup:**

```bash
pnpm install   # installs @cursor/sdk (SDK transport dependency)
```

Then pick one authentication method:

| Transport      | Auth                                                                                      | Notes                                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| SDK (primary)  | `export CURSOR_API_KEY=...` from [Dashboard → API Keys](https://cursor.com/dashboard/api) | Adds thinking content, direct image attachments, current-turn token usage, and conversation resume across pi restarts |
| CLI (fallback) | `cursor-agent login` (browser OAuth, same login as the Cursor app)                        | Used automatically when `CURSOR_API_KEY` is unset; print mode suppresses thinking and direct image attachments        |

Both transports bill identically: runs draw from your plan's normal usage pools at
the same rates as IDE usage (SDK runs appear under the "SDK" tag in the team usage
dashboard). `composer-2.5` draws from the generous first-party pool and is the
frugal default.

**Usage:**

```bash
pi --model cursor/composer-2.5      # start on a Cursor model
pi                                  # or switch later with /model (Ctrl+L)
```

Inside pi, select any `cursor/*` model from the `/model` picker — the catalog is
discovered from your account at startup (`Cursor.models.list()` or
`cursor-agent models`). Chat as usual; multi-turn context is preserved by resuming
the same underlying Cursor conversation.

**Commands:**

- `/cursor-status` — show the active transport and authentication state
- `/cursor-reset` — drop the bridged Cursor conversation (next message starts
  fresh). Use after rewinding/forking pi history, which the Cursor side cannot see

**Environment variables:**

| Variable              | Default        | Description                                                                                                            |
| --------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `CURSOR_API_KEY`      | unset          | User API key; enables the SDK transport                                                                                |
| `PI_CURSOR_TRANSPORT` | auto           | Force `sdk` or `cli`                                                                                                   |
| `CURSOR_AGENT_BIN`    | `cursor-agent` | CLI binary name/path override (CLI transport)                                                                          |
| `PI_CURSOR_NO_FORCE`  | unset          | Set to `1` to omit `--force` from CLI runs (shell/write tools will then fail — approvals are impossible in print mode) |

**Limitations:** direct image attachments require the SDK transport. With CLI
transport, include a workspace image path in the prompt so Cursor can read it with
its own tools; pi image blocks cannot be forwarded directly. Cursor controls its
own automatic reasoning, so pi's thinking-level selector preserves native TUI
styling but does not change Cursor's reasoning effort. Cursor does not expose a
reliable current/maximum context-window measurement: SDK usage is aggregate token
volume for the current agent turn, while pi's context percentage is estimated from
the visible bridged transcript so internal Cursor model calls cannot drive it above
100%. Cache read/write volume is folded into prompt input because pi's single-request
cache-miss heuristic is incompatible with Cursor's multi-request agent turns. Usage
numbers require the SDK transport; subscription cost remains
`$0` in pi because the SDK does not expose synchronous per-run billing cost.

There is no pi tool execution while bridged. Because assistant output is buffered
to preserve transcript ordering, it does not appear token-by-token during the
Cursor run. The bridged Cursor conversation can diverge if you edit pi history
mid-session — recover with `/cursor-reset`.

### CLI: babysit

The former `crates/pr-watch/` CLI now lives in the standalone
[`babysit`](https://github.com/volker48/babysit) project. Use that repository for
PR/MR watcher development, GitLab CI, releases, and installation docs.

### Skill: Claude Review (`skills/claude-review/`)

Adds a shared Agent Skill for running Claude Code's `/code-review` from the target
repository. Agents can load it automatically for independent review workflows, and humans
can invoke it with `/skill:claude-review` or the bundled `scripts/run-claude-review.sh`
helper. This does not replace the Pi `/claude-review` extension command.

### Pi: Themes (`pi-themes/`)

Two color themes for the Pi TUI: **obsec-dark** and **obsec-light**.

## Development

```bash
pnpm install
pnpm typecheck     # TypeScript type checking
pnpm lint          # Linting with oxlint
pnpm format        # Format with oxfmt
pnpm test          # Run tests with vitest
pnpm test:rtk      # Fast RTK extension regression tests
pnpm test:rtk:e2e  # Opt-in real RTK integration tests
pnpm verify:rtk    # Standalone Pi CLI verification using --session and --extension
```

Requires Node.js ≥ 22.

## License

[MIT](LICENSE) — Marcus McCurdy
