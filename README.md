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
  prolong.ts           # PRO-LONG active-branch programmatic memory
  headlong/            # Persistent workspace actor and wake-after-exit supervisor
  fusion/              # Multi-model Fusion panel and judge command

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

### Pi: PRO-LONG programmatic memory (`pi-extensions/prolong.ts`)

Exposes the current Pi session's complete persisted active branch as private, ephemeral JSONL so
the model can recover earlier evidence with ordinary `grep`, `read`, Python, Node, or `jq`
after that evidence leaves active context. Pi's session tree remains canonical; the extension does
not summarize entries, add embeddings, mutate provider-bound history, or replace native
compaction.

PRO-LONG is opt-in. Enable a new session with `--prolong` or `PI_PROLONG=1`, or use branch-local
commands:

```text
/prolong on       Enable, persist state, and synchronize the projection
/prolong off      Disable, persist state, and remove the derived directory
/prolong status   Report path, entries, bytes, sync mode, and elapsed time
/prolong refresh  Force an integrity-checked atomic rebuild
```

The projection lives at `$XDG_RUNTIME_DIR/pi-prolong/<session-id>/active-branch.jsonl`; when
`XDG_RUNTIME_DIR` is unavailable, the extension uses an owner-private directory under the OS
temporary directory. Directories are mode `0700`, the idle log is mode `0400`, normal forward
progress appends only the new suffix, and divergence or detected mutation triggers an atomic
rebuild. The directory is removed on disable and session shutdown. Secure cleanup is anchored
through Linux procfs directory descriptors; if procfs is unavailable, cleanup fails closed rather
than falling back to recursive pathname removal.

The log can duplicate any source code, terminal output, credentials, or other sensitive material
already persisted in the Pi session. Enable it only when long-horizon recall justifies that
short-lived duplicate. "Complete" is relative to Pi-persisted active-branch entries; it excludes
provider-hidden reasoning and data Pi never stored.

Run focused tests and the model-free ARM64-safe benchmark with:

```bash
pnpm test:prolong
pnpm verify:prolong -- --benchmark-only
```

The full RPC proof requires an authenticated model and checks manual compaction, omission of the
random nonce from the compaction summary, a recorded `read` call against the exact log path, exact
nonce recovery, and cleanup:

```bash
pnpm verify:prolong -- --model provider/model --keep-session
```

### Pi: Headlong persistent workspace actor (`pi-extensions/headlong/`)

Headlong keeps one persistent actor per filesystem-canonical workspace while leaving Pi's session
tree/JSONL as the canonical conversation trajectory. It stores versioned operational state and an
operational JSONL event log under `$PI_HEADLONG_STATE_ROOT/<actor-id>/` (default:
`$XDG_STATE_HOME/pi-headlong/<actor-id>/`, with `~/.local/state/pi-headlong` as the fallback).
Directories are owner-private, state transitions use fsync plus atomic rename, and operational event
append failures are reported as degraded health without undoing an already committed actor state.
Event sequence allocation reads only a bounded log tail, and its cross-process append lock uses PID
plus process-start identity rather than elapsed wall time alone.

A process-identity-aware directory lease enforces one writer. The supervisor remains the primary
owner while its RPC child is recorded as a same-token delegate. The parent must atomically reclaim a
dead delegate before reading or mutating post-child state. Stale takeover requires an expired grace
period and negative liveness evidence for both primary and delegate. Missing or malformed owner
metadata fails closed for operator recovery. Release first moves the owned lease to a unique
tombstone, revalidates the moved token, and only then deletes it, so an old process cannot remove a
replacement owner's lease.

Control the actor inside Pi:

```text
/headlong start    Create the actor and wake immediately
/headlong resume   Resume a paused or blocked actor
/headlong pause    Reversible kill switch
/headlong status   Show status, wake time, failures, and exact state path
/headlong stop     Terminal kill switch
```

Each unattended wake must call exactly one of `headlong_checkpoint`, `headlong_sleep`,
`headlong_complete`, or `headlong_blocked`. Settling without a transition, exceeding a turn budget,
tripping the independent wall-clock watchdog, or losing the lease fails closed. Meaningful
interactive input becomes one serialized immediate wake and resets idle backoff. A `stopped` or
cleanly `completed` actor is terminal. A durable completion followed by an unclean RPC stream or
nonzero child exit becomes `completed-unverified`, which preserves the finished work but requires
operator review rather than being reported as ordinary success.

Once canonical state commits a transition, runtime wake state, timers, and tools are reconciled even
if the operational event append fails. Tools remain disabled until that turn settles; only then is
the interactive tool set restored and any next wake scheduled. Pause, stop, and budget watchdogs
abort the turn and retain unattended restrictions through settlement cleanup.

The extension can self-wake **only while its Pi host remains alive**. For wake-after-exit, run the
external supervisor from an installed package:

```bash
pi-headlong --workspace /absolute/path/to/workspace
```

From this checkout, the equivalent is:

```bash
pnpm exec tsx pi-extensions/headlong/cli.ts --workspace /absolute/path/to/workspace
```

Use `--once` for one due-wake attempt, `--poll-seconds N` for loop polling, and
`--timeout-seconds N` for the per-wake host budget. Stop the supervisor with `SIGINT` or `SIGTERM`
before manual recovery. It resumes the exact stored Pi session, explicitly loads Headlong and
PRO-LONG, preserves repository context files while excluding arbitrary project extensions, and
accepts a wake only after a matching durable transition, RPC settlement, a complete stream, and a
clean zero-status exit. One-shot failures, missing state, exhausted loops, and unverified terminal
outcomes return a nonzero process exit status. Wake-after-exit supervision requires POSIX
process-group containment and therefore fails closed before spawning an RPC child on Windows.

**Headlong does not provide a filesystem sandbox.** The default unattended tool set contains only
the four Headlong control tools, so absolute-path access, `..` traversal, home expansion, `/proc`
access, and symlink escapes are unavailable through model-facing filesystem tools. To grant host
filesystem tools, the operator must pass `--allow-unsandboxed-host-tools` (or set the equivalent
extension option). The supervisor prints a prominent warning and forwards the opt-in to the child.
`PI_HEADLONG_TOOLS` can then select only from `read,grep,find,ls,edit,write`; it still cannot add
`bash`, networking, messaging, release, deployment, or arbitrary extension tools.

Use the unsandboxed flag only when the entire supervisor already runs inside an operator-controlled
container or equivalent boundary. Mount the workspace read/write, mount only required session and
PRO-LONG data read-only, keep Headlong's state inaccessible to model-facing tools, and use dedicated
credentials. Without that external boundary, the allowed filesystem tools can access absolute paths
and follow filesystem links according to Pi's normal host semantics.

If state, lease metadata, or an ownership/symlink boundary is unsafe, Headlong refuses to guess.
Stop the supervisor, preserve or move aside the actor directory reported by `/headlong status`,
restart Pi, and use `/headlong start` for fresh state against the current canonical session. See
[`ADR-0010`](docs/adr/0010-headlong-persistent-workspace-actor.md) for invariants and trust
boundaries.

Verification:

```bash
pnpm test:headlong
pnpm verify:headlong
```

### Pi: RTK (`pi-extensions/rtk.ts`)

Intercepts `bash` tool calls and delegates command rewriting to `rtk rewrite <command>`. Only rewrites when RTK returns a different non-empty command. Supports `PI_RTK_BIN` or Pi's `--rtk-bin` flag for binary overrides.

### Pi: Fusion (`pi-extensions/fusion/`)

Adds a `/fusion` command that runs a configured multi-model panel, judges the panel
responses, and sends a synthesis prompt back to the active model. The judge uses
binary question decomposition inspired by the BinEval framework: see
[“Ask, Don’t Judge: Systematic Evaluation via Binary Decomposition”][bineval]
(arXiv:2606.27226).

[bineval]: https://arxiv.org/abs/2606.27226

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
pnpm test:prolong  # Focused PRO-LONG storage and extension tests
pnpm verify:prolong -- --benchmark-only # Model-free active-branch benchmark
pnpm test:headlong # Focused Headlong state, lease, extension, and supervisor tests
pnpm verify:headlong # Real pinned-Pi 0.84.2 model-free integration proof
pnpm test:rtk      # Fast RTK extension regression tests
pnpm test:rtk:e2e  # Opt-in real RTK integration tests
pnpm verify:rtk    # Standalone Pi CLI verification using --session and --extension
```

Requires Node.js ≥ 22.

## License

[MIT](LICENSE) — Marcus McCurdy
