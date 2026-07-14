#!/bin/bash
set -euo pipefail

# shellcheck disable=SC1091
source "$(dirname "$0")/common.sh"
require_xcodegen
require_command swift
require_command xcrun

printf 'Developer directory: %s\n' "$DEVELOPER_DIR"
xcodebuild -version
xcodebuild -checkFirstLaunchStatus
xcodegen --version
printf 'Swift: '
swift --version | head -1
printf 'iOS SDK: '
xcrun --sdk iphoneos --show-sdk-version
printf 'iOS Simulator SDK: '
xcrun --sdk iphonesimulator --show-sdk-version
printf '\nAvailable simulator runtimes:\n'
xcrun simctl list runtimes
