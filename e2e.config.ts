import { mobile } from "@e2e-dev/mobile";
import type { E2EConfig } from "e2e";

export default {
  tests: "tests/ios/**/*.e2e.ts",
  targets: [
    {
      name: "ios",
      engine: mobile({ platform: "ios", device: process.env.IOS_E2E_DEVICE ?? "iPhone 17 Pro" }),
      app: {
        bundleId: "works.earendil.pi-remote-client",
        appPath:
          "ios-remote-client/build/simulator/Build/Products/Debug-iphonesimulator/PiRemoteClientApp.app",
      },
    },
  ],
  workers: 1,
  retries: 0,
  timeout: 120_000,
  launchTimeout: 180_000,
  assertionTimeout: 15_000,
  trace: "off",
} satisfies E2EConfig;
