#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="${SCRIPT_DIR}/MY_AGENTS.md"
TARGETS=(
	"${HOME}/.codex/AGENTS.md"
	"${HOME}/.claude/CLAUDE.md"
	"${HOME}/.pi/agent/AGENTS.md"
)

for target in "${TARGETS[@]}"; do
	mkdir -p "$(dirname -- "$target")"

	if [[ -e "$target" || -L "$target" ]]; then
		if [[ "$(readlink "$target" 2>/dev/null || true)" == "$SOURCE" ]]; then
			echo "Already linked: $target"
			continue
		fi
		echo "Refusing to replace existing path: $target" >&2
		exit 1
	fi

	ln -s "$SOURCE" "$target"
	echo "Linked: $target -> $SOURCE"
done
