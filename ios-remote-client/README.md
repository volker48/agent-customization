# Pi Remote Client

A native iOS app for watching and steering Pi sessions running on your laptop over
`pi/remote/1` (see `REMOTE_CONTROL_PRD.md` and GitHub issue #16). Xcode.app is
required for Apple SDKs, but these commands run entirely from a terminal; do not
open Xcode.

## Layout

- `Sources/PiRemoteClient/` — UI-free Swift package: wire protocol, iroh transport,
  `RemoteClient`, `SessionStore`, transcript projection (tool frames fold into one row
  per `toolCallId`), and Markdown block splitting. Unit-tested on macOS.
- `App/` — the SwiftUI app (iOS 26): pairing (QR scan or paste + six-digit code),
  session list, chat view with Markdown, collapsible tool rows, send/steer and Stop,
  Context Capsule sheet, and settings. `scripts/render-app-icon.swift` regenerates
  the app icon.

## Install on your iPhone

No App Store or TestFlight is needed; this is a local development install.

1. In Xcode Settings → Accounts, sign in with your Apple ID once. A free account
   gives you a Personal Team; a paid Developer Program membership also works.
2. Create `Local.xcconfig` from `Local.xcconfig.example` with your Team ID
   (`defaults read com.apple.dt.Xcode IDEProvisioningTeamByIdentifier` prints it) and,
   for a Personal Team, a bundle ID that is unique to you.
3. On the iPhone, enable Settings → Privacy & Security → Developer Mode.
4. Connect the phone by cable (or on the same network once paired) and run
   `./scripts/install-device.sh <device-udid>`.
5. The first launch may be blocked until you trust your developer certificate in
   Settings → General → VPN & Device Management.

Personal Team builds expire after 7 days; rerun `install-device.sh` to refresh (the
app keeps its identity and pairing). Paid-account builds last a year.

## One-time setup

1. Install Xcode from Apple and accept its license/components:

   ```bash
   sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
   sudo xcodebuild -license accept
   sudo xcodebuild -runFirstLaunch
   ```

   The repository scripts also set `DEVELOPER_DIR` explicitly, so they remain
   deterministic if you cannot change the global selection.

2. Install XcodeGen:

   ```bash
   brew install xcodegen
   ```

3. Check the toolchain:

   ```bash
   ./scripts/doctor.sh
   ```

The scripts select `/Applications/Xcode.app/Contents/Developer` automatically. Set
`DEVELOPER_DIR` when Xcode is installed elsewhere. The generated
`PiRemoteClient.xcodeproj` and `App/Info.plist` are disposable and ignored by git;
`project.yml` is the source of truth. The app's Re-pair toolbar action clears a saved
ticket when the daemon identity or allowlist changes.

For a signed device build, copy `Local.xcconfig.example` to `Local.xcconfig` and set
your Apple Developer Team ID, or export `DEVELOPMENT_TEAM` for one command. The
certificate and provisioning profile stay in Xcode's keychain-managed state; no
signing secrets belong in this repository. Enable Developer Mode on the iPhone
in Settings → Privacy & Security → Developer Mode before installing a development
build. Apple account/provisioning setup is the one-time exception to the headless
workflow: add the Apple Developer account in
Xcode Settings → Accounts and create or download the Apple Development
certificate/profile once. After that,
`install-device.sh` does not open Xcode.

## Headless commands

Run from this directory:

```bash
./scripts/test.sh                 # Swift format check and package test executable
./scripts/generate-project.sh     # Regenerate the disposable Xcode project
./scripts/build-simulator.sh      # Unsigned iOS Simulator build
./scripts/install-device.sh UDID  # Archive, sign, and install on a connected iPhone
```

`install-device.sh` uses `xcodebuild archive` with automatic provisioning and then
`xcrun devicectl device install app`. It requires a paired device and an Apple
Development signing identity. List device UDIDs with:

```bash
DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}" \
  xcrun devicectl list devices
```

iOS has no Mac-style notarization step. App Store/TestFlight export is intentionally
not part of this local device workflow; add that as a separate export pipeline when
those distribution requirements exist. 
See <https://scottwillsey.com/building-and-shipping-mac-and-ios-apps-without-ever-opening-xcode/> for more info.

## Dependency caveat

The pinned `iroh-ffi` 1.0.0 prebuilt framework can emit Xcode 26 linker warnings
because some object files report iOS/macOS 26.5 build floors while the package
declares iOS 17.5 / macOS 14.5 and the app targets iOS 26.0. The dependency-side fix is
to rebuild the xcframework with the dependency's `cargo make swift-xcframework`
task if older-OS support is required.
