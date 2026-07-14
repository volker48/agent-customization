#!/bin/bash
set -euo pipefail

# shellcheck disable=SC1091
source "$(dirname "$0")/common.sh"
generate_project

xcodebuild \
	-project "$PROJECT" \
	-scheme "$SCHEME" \
	-configuration Debug \
	-destination 'generic/platform=iOS Simulator' \
	-derivedDataPath "$BUILD_DIR/simulator" \
	CODE_SIGNING_ALLOWED=NO \
	build
