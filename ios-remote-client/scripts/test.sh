#!/bin/bash
set -euo pipefail

# shellcheck disable=SC1091
source "$(dirname "$0")/common.sh"

swift format lint --strict --recursive --configuration "$ROOT_DIR/.swift-format" \
	"$ROOT_DIR/Sources" "$ROOT_DIR/Tests" "$ROOT_DIR/Package.swift" "$ROOT_DIR/App"
swift run pi-remote-client-tests
