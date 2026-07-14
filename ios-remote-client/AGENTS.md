# Pi Remote Client development

Keep iOS work headless. Xcode.app must be installed for Apple SDKs, but do not open
its GUI or commit generated `PiRemoteClient.xcodeproj` files.

## Commands

Run from `ios-remote-client/`:

```bash
./scripts/doctor.sh
./scripts/test.sh
./scripts/build-simulator.sh
./scripts/install-device.sh <device-udid>
```

`project.yml` is the committed XcodeGen source. `scripts/build-simulator.sh` performs
an unsigned simulator build for fast checks. `scripts/install-device.sh` performs a
signed Release archive and installs the app with `devicectl`; set `DEVELOPMENT_TEAM`
or create `Local.xcconfig` from `Local.xcconfig.example` first.

The package's `swift run pi-remote-client-tests` path remains the fastest unit-test
loop. Keep protocol fixtures generated from the TypeScript implementation and run
the root fixture test when changing the wire format.
