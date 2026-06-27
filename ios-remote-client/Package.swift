// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "PiRemoteClient",
  platforms: [
    .iOS("17.5"),
    .macOS("14.5"),
  ],
  products: [
    .library(name: "PiRemoteClient", targets: ["PiRemoteClient"]),
    .executable(name: "pi-remote-client-tests", targets: ["PiRemoteClientTests"]),
  ],
  targets: [
    .target(name: "PiRemoteClient"),
    .executableTarget(
      name: "PiRemoteClientTests",
      dependencies: ["PiRemoteClient"],
      path: "Tests/PiRemoteClientTests",
      resources: [.process("Fixtures")]
    ),
  ]
)
