#!/bin/bash
set -euo pipefail

# Thin wrapper that runs the typed Fusion bundle CLI against the current project.
# Locates the CLI and tsx relative to this script so it works regardless of the
# working directory the calling agent is in.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
CLI="${REPO_ROOT}/pi-extensions/fusion/bundle-cli.ts"
TSX="${REPO_ROOT}/node_modules/.bin/tsx"

if [[ ! -f "${CLI}" ]]; then
	echo "bundle CLI not found at ${CLI}" >&2
	exit 1
fi

if [[ -x "${TSX}" ]]; then
	exec "${TSX}" "${CLI}" "$@"
fi

exec npx tsx "${CLI}" "$@"
