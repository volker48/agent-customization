# Pi Remote Client

This directory contains the Swift package used by the Pi remote-control iOS client
and a small iOS app target. Xcode.app is required for Apple SDKs, but these commands
run entirely from a terminal; do not open Xcode.

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
`project.yml` is the source of truth.

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
those distribution requirements exist. The local development target intentionally has
no AppIcon asset; add one before distributing through TestFlight or the App Store.

## Dependency caveat

The pinned `iroh-ffi` 1.0.0 prebuilt framework can emit Xcode 26 linker warnings
because some object files report iOS/macOS 26.5 build floors while this package
declares iOS 17.5 and macOS 14.5. The final app currently reports a 17.5 minimum,
but test it on the minimum supported OS before shipping. The dependency-side fix is
to rebuild the xcframework with the dependency's `cargo make swift-xcframework`
task if older-OS support is required.
