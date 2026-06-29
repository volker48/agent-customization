#!/bin/bash
set -euo pipefail

CLAUDE_BIN="${PI_CLAUDE_REVIEW_BIN:-claude}"
REVIEW_TOOLS="Bash,Read,Glob,Grep,LSP,WebFetch,WebSearch,Skill"
LEVEL="medium"

usage() {
	cat <<'USAGE'
Usage: run-claude-review.sh [low|medium|high|max] [review context...]

Runs Claude Code's /code-review command in headless mode from the current directory.
Set PI_CLAUDE_REVIEW_BIN to override the claude binary.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
	usage
	exit 0
fi

case "${1:-}" in
low | medium | high | max)
	LEVEL="$1"
	shift
	;;
ultra)
	echo "Review level 'ultra' is not supported in headless Claude review runs" >&2
	exit 2
	;;
esac

CONTEXT="$*"
PROMPT="/code-review ${LEVEL}"
if [[ -n "${CONTEXT}" ]]; then
	PROMPT="${PROMPT} ${CONTEXT}"
fi

exec "${CLAUDE_BIN}" \
	--permission-mode auto \
	--allowed-tools "${REVIEW_TOOLS}" \
	-p "${PROMPT}"
