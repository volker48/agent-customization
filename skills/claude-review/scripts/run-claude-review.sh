#!/bin/bash
set -euo pipefail

CLAUDE_BIN="${PI_CLAUDE_REVIEW_BIN:-claude}"
REVIEW_TOOLS="Bash,Read,Glob,Grep,LSP,WebFetch,WebSearch,Skill"
LEVEL="medium"

usage() {
	cat <<'USAGE'
Usage: run-claude-review.sh [low|medium|high|max] [review context...]

Runs an independent Claude Code review in headless mode from the current directory.
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
printf -v PROMPT '%s\n' \
	"Perform an independent code review of the current repository changes." \
	"Review level: ${LEVEL}" \
	"" \
	"Review contract:" \
	"- Inspect the working tree, index, and branch changes with git. Determine the appropriate merge base when the branch contains commits not present upstream." \
	"- Focus on correctness, security, integration regressions, edge cases, and missing tests. Do not report purely stylistic preferences." \
	"- Return concise, actionable findings ordered by severity. Include file and line references when available. If there are no findings, say so explicitly." \
	"- Do not modify files, create tasks, spawn agents, or start remote or orchestration workflows."
if [[ -n "${CONTEXT}" ]]; then
	printf -v PROMPT '%s\nReview context from the caller:\n%s' "${PROMPT}" "${CONTEXT}"
fi

echo "Running Claude review (${LEVEL})..." >&2

exec "${CLAUDE_BIN}" \
	--permission-mode auto \
	--effort "${LEVEL}" \
	--tools "${REVIEW_TOOLS}" \
	--allowed-tools "${REVIEW_TOOLS}" \
	-p "${PROMPT}"
