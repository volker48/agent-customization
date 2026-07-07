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

skills/                # Agent Skills shared by Pi and compatible agents
  claude-review/       # Claude Code /code-review workflow

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

Registers a `webfetch` tool for fetching web pages directly. Supports markdown conversion,
probing, smart fallback strategies, and direct GitHub repository/blob links. Agents can pass
GitHub repo roots (for README source markdown) or GitHub `blob` file URLs without converting
them to raw URLs first.

HTML-to-markdown conversion depends on runtime packages in this repository. Use the
extension from this checkout (or distribute it as a pi package); copying only
`pi-extensions/webfetch.ts` elsewhere will not copy those dependencies.

### Pi: RTK (`pi-extensions/rtk.ts`)

Intercepts `bash` tool calls and delegates command rewriting to `rtk rewrite <command>`. Only rewrites when RTK returns a different non-empty command. Supports `PI_RTK_BIN` or Pi's `--rtk-bin` flag for binary overrides.

### Pi: Fusion (`pi-extensions/fusion/`)

Adds a `/fusion` command that runs a configured multi-model panel, judges the panel
responses, and sends a synthesis prompt back to the active model. The judge uses
binary question decomposition inspired by the BinEval framework: see
[“Ask, Don’t Judge: Systematic Evaluation via Binary Decomposition”][bineval]
(arXiv:2606.27226).

[bineval]: https://arxiv.org/abs/2606.27226

### CLI: pr-watch (`pi-extensions/pr-watch/`)

Watches a GitHub pull request through `gh`, waits for terminal checks and bot
reviews, and distills bot review threads into compact findings. It provides
`pr-watch status`, `pr-watch findings`, and `pr-watch wait`.

Exit codes are: `0` settled clean, `1` settled with unresolved findings, `2`
checks failed, `3` pending or timed out, and `4` usage or `gh` error.

```bash
# Run from a background shell/tool (for example, Claude Code run_in_background).
pr-watch wait 63 --repo volker48/agent-customization --timeout 1800 --interval 30
```

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
