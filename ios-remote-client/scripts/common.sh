#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC2034
PROJECT="$ROOT_DIR/PiRemoteClient.xcodeproj"
PROJECT_SPEC="$ROOT_DIR/project.yml"
# shellcheck disable=SC2034
SCHEME="PiRemoteClientApp"
# shellcheck disable=SC2034
BUILD_DIR="${IOS_REMOTE_BUILD_DIR:-$ROOT_DIR/build}"
LOCAL_CONFIG="$ROOT_DIR/Local.xcconfig"

fail() {
	printf 'error: %s\n' "$*" >&2
	exit 1
}

require_command() {
	command -v "$1" >/dev/null 2>&1 || fail "'$1' is required. See $ROOT_DIR/README.md."
}

select_xcode() {
	local developer_dir="${DEVELOPER_DIR:-}"
	if [[ -z "$developer_dir" && -d /Applications/Xcode.app/Contents/Developer ]]; then
		developer_dir=/Applications/Xcode.app/Contents/Developer
	fi
	[[ -n "$developer_dir" ]] || fail \
		"Xcode.app is required; set DEVELOPER_DIR to its Developer directory."
	[[ -x "$developer_dir/usr/bin/xcodebuild" ]] || fail "Invalid DEVELOPER_DIR: $developer_dir"
	export DEVELOPER_DIR="$developer_dir"
}

require_xcodegen() {
	require_command xcodegen
	xcodegen --version >/dev/null
}

generate_project() {
	require_xcodegen
	xcodegen generate --spec "$PROJECT_SPEC" --project "$ROOT_DIR"
}

signing_args() {
	local team_id="${DEVELOPMENT_TEAM:-${TEAM_ID:-}}"
	if [[ -f "$LOCAL_CONFIG" ]]; then
		printf '%s\n' -xcconfig "$LOCAL_CONFIG"
	fi
	if [[ -n "$team_id" ]]; then
		printf '%s\n' DEVELOPMENT_TEAM="$team_id"
	fi
}

select_xcode
cd "$ROOT_DIR"
