#!/bin/bash
set -euo pipefail

# shellcheck disable=SC1091
source "$(dirname "$0")/common.sh"

if (($# > 1)); then
	fail "Usage: ${0##*/} [device-udid]"
fi

generate_project

require_command xcrun

team_id="${DEVELOPMENT_TEAM:-${TEAM_ID:-}}"
if [[ -n "$team_id" && ! "$team_id" =~ ^[A-Z0-9]{10}$ ]]; then
	fail "DEVELOPMENT_TEAM must be a 10-character Apple Developer Team ID."
fi
if [[ -z "$team_id" && ! -f "$LOCAL_CONFIG" ]]; then
	fail "Set DEVELOPMENT_TEAM (or TEAM_ID), or create Local.xcconfig from Local.xcconfig.example."
fi

device_id="${1:-${DEVICE_UDID:-}}"
if [[ -z "$device_id" ]]; then
	xcrun devicectl list devices
	fail "Pass a device UDID as the first argument or set DEVICE_UDID."
fi

archive_path="$BUILD_DIR/PiRemoteClientApp.xcarchive"
rm -rf "$archive_path"

signing=()
while IFS= read -r argument; do
	signing+=("$argument")
done < <(signing_args)

xcodebuild \
	-project "$PROJECT" \
	-scheme "$SCHEME" \
	-configuration Release \
	-destination 'generic/platform=iOS' \
	-derivedDataPath "$BUILD_DIR/device" \
	-archivePath "$archive_path" \
	-allowProvisioningUpdates \
	-allowProvisioningDeviceRegistration \
	"${signing[@]}" \
	archive

app_path="$archive_path/Products/Applications/PiRemoteClientApp.app"
[[ -d "$app_path" ]] || fail "Archived app not found at $app_path"
xcrun devicectl device install app --device "$device_id" "$app_path"
