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
  handoff/             # Session handoff command (/handoff)

pi-themes/             # Pi agent color themes
  obsec-dark.json
  obsec-light.json

create-sound-symlinks.sh  # Creates symlinks so all agents share one set of sound files
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

| Concept | Pi (snake_case) | OpenCode (dot.notation) | Claude Code (PascalCase) |
|---|---|---|---|
| Session created | `session_start` | `session.created` | `SessionStart` |
| Session ended | `session_shutdown` | — | `SessionEnd` |
| Agent finished | `agent_end` | `session.idle` | `Stop` |
| Before tool runs | `tool_call` | `tool.execute.before` | `PreToolUse` |
| After tool runs | `tool_result` | `tool.execute.after` | `PostToolUse` |
| User input | `input` | `tui.prompt.append` | `UserPromptSubmit` |
| Compaction | `session_compact` | `session.compacted` | `PreCompact` |
| User shell cmd | `user_bash` | `tui.command.execute` | — |

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

| Variable | Default | Description |
|---|---|---|
| `SOUNDS_BASE` (Claude Code only) | `~/Documents/sounds` | Base directory for sound folders |
| `SOUND_MIN_INTERVAL_MS` | `250` | Minimum milliseconds between sounds (cooldown) |
| `SOUND_DEBUG` | `0` | Set to `1` to print debug logs to stderr |

## Other Extensions

### Pi: Exa Search (`pi-extensions/exa-search.ts`)

Registers an `exa_search` tool that queries the [Exa](https://exa.ai) search API. Returns ranked links with URLs, metadata, and text snippets. Requires `EXA_API_KEY` in your environment.

### Pi: Web Fetch (`pi-extensions/webfetch.ts`)

Registers a `webfetch` tool for fetching web pages directly. Supports markdown conversion, probing, and smart fallback strategies.

### Pi: Handoff (`pi-extensions/handoff/`)

Adds a `/handoff <goal>` command that generates a session context summary, opens it in your editor for review, then creates a new Pi session pre-filled with the handoff document.

### Pi: Themes (`pi-themes/`)

Two color themes for the Pi TUI: **obsec-dark** and **obsec-light**.

## Development

```bash
pnpm install
pnpm typecheck     # TypeScript type checking
pnpm lint          # Linting with oxlint
pnpm format        # Format with oxfmt
pnpm test          # Run tests with vitest
```

Requires Node.js ≥ 22.

## License

[MIT](LICENSE) — Marcus McCurdy
