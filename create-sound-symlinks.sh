#!/bin/bash
set -eo pipefail

# Create symlinks from pi-agent event names to opencode event names
# This allows the opencode sound plugin to use existing pi-agent sound files

SOUNDS_DIR="${HOME}/Documents/sounds"

# Array of "pi_event:opencode_event" pairs
declare -a EVENT_PAIRS=(
	"session_start:session.created"
	"session_compact:session.compacted"
	"agent_end:session.idle"
	"tool_call:tool.execute.before"
	"tool_result:tool.execute.after"
	"input:tui.prompt.append"
	"user_bash:tui.command.execute"
)

echo "Creating symlinks for sound notifications..."
echo "Sounds directory: ${SOUNDS_DIR}"
echo ""

for pair in "${EVENT_PAIRS[@]}"; do
	pi_event="${pair%%:*}"
	opencode_event="${pair##*:}"

	pi_dir="${SOUNDS_DIR}/${pi_event}"
	opencode_link="${SOUNDS_DIR}/${opencode_event}"

	if [[ -d "$pi_dir" ]]; then
		if [[ -e "$opencode_link" ]]; then
			if [[ -L "$opencode_link" ]]; then
				current_target=$(readlink "$opencode_link")
				if [[ "$current_target" == "$pi_event" ]]; then
					echo "✓ Already linked: ${opencode_event} -> ${pi_event}"
				else
					echo "⚠ Warning: ${opencode_link} exists but points to ${current_target}"
					echo "  Run: rm '${opencode_link}' && ln -s '${pi_event}' '${opencode_link}'"
				fi
			else
				echo "⚠ Warning: ${opencode_link} exists as a regular directory (not a symlink)"
				echo "  Skipping to avoid data loss. Manual intervention required."
			fi
		else
			ln -s "$pi_event" "$opencode_link"
			echo "✓ Created symlink: ${opencode_event} -> ${pi_event}"
		fi
	else
		echo "⊘ Skipped: ${pi_event} directory not found"
	fi
done

echo ""
echo "Done! The opencode sound plugin can now use your existing pi-agent sound files."
echo ""
echo "Note: These pi-agent events have no direct opencode equivalent and were skipped:"
echo "  - session_shutdown"
echo "  - session_switch"
echo "  - session_fork"
echo "  - session_tree"
echo "  - agent_start"
echo "  - turn_start"
echo "  - turn_end"
echo "  - model_select"
