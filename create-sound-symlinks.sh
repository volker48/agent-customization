#!/bin/bash
set -eo pipefail

# Create symlinks from pi-agent event names to opencode and claude code event names.
# This allows all three agents to share a single set of sound files using the
# pi-agent naming convention (snake_case) as the canonical source.

SOUNDS_DIR="${HOME}/Documents/sounds"

# Helper: create a symlink from $2 -> $1 inside SOUNDS_DIR, with safety checks.
create_link() {
	local pi_event="$1"
	local target_event="$2"

	local pi_dir="${SOUNDS_DIR}/${pi_event}"
	local target_link="${SOUNDS_DIR}/${target_event}"

	if [[ -d "$pi_dir" ]]; then
		if [[ -e "$target_link" ]]; then
			if [[ -L "$target_link" ]]; then
				local current_target
				current_target=$(readlink "$target_link")
				if [[ "$current_target" == "$pi_event" ]]; then
					echo "  ✓ Already linked: ${target_event} -> ${pi_event}"
				else
					echo "  ⚠ Warning: ${target_link} exists but points to ${current_target}"
					echo "    Run: rm '${target_link}' && ln -s '${pi_event}' '${target_link}'"
				fi
			else
				echo "  ⚠ Warning: ${target_link} exists as a regular directory (not a symlink)"
				echo "    Skipping to avoid data loss. Manual intervention required."
			fi
		else
			ln -s "$pi_event" "$target_link"
			echo "  ✓ Created symlink: ${target_event} -> ${pi_event}"
		fi
	else
		echo "  ⊘ Skipped: ${pi_event} directory not found"
	fi
}

# --------------------------------------------------------------------------
# Mappings: "pi_event:target_event"
# --------------------------------------------------------------------------

# Pi -> OpenCode
declare -a OPENCODE_PAIRS=(
	"session_start:session.created"
	"session_compact:session.compacted"
	"agent_end:session.idle"
	"tool_call:tool.execute.before"
	"tool_result:tool.execute.after"
	"input:tui.prompt.append"
	"user_bash:tui.command.execute"
)

# Pi -> Claude Code
declare -a CLAUDE_PAIRS=(
	"session_start:SessionStart"
	"session_shutdown:SessionEnd"
	"input:UserPromptSubmit"
	"agent_end:Stop"
	"tool_call:PreToolUse"
	"tool_result:PostToolUse"
	"session_compact:PreCompact"
)

# --------------------------------------------------------------------------

echo "Creating symlinks for sound notifications..."
echo "Sounds directory: ${SOUNDS_DIR}"

echo ""
echo "── OpenCode symlinks ──"
for pair in "${OPENCODE_PAIRS[@]}"; do
	create_link "${pair%%:*}" "${pair##*:}"
done

echo ""
echo "── Claude Code symlinks ──"
for pair in "${CLAUDE_PAIRS[@]}"; do
	create_link "${pair%%:*}" "${pair##*:}"
done

echo ""
echo "Done! OpenCode and Claude Code can now use your existing pi-agent sound files."
echo ""
echo "Note: The following events have no cross-agent equivalent and need their own folders"
echo "if you want sounds for them:"
echo ""
echo "  Pi-only (no OpenCode or Claude Code equivalent):"
echo "    session_switch, session_fork, session_tree"
echo "    agent_start, turn_start, turn_end, model_select"
echo ""
echo "  Claude Code-only (no Pi equivalent):"
echo "    SubagentStart, SubagentStop, Notification"
