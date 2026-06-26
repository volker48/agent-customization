import { once } from "node:events";

import { createPairingCode, defaultRemoteRoot } from "./authorization.js";
import { startRemoteDaemon } from "./daemon.js";

const daemon = await startRemoteDaemon({
  remoteRoot: process.env.PI_REMOTE_ROOT ?? defaultRemoteRoot(),
  pairingCode: process.env.PI_REMOTE_PAIRING_CODE ?? createPairingCode(),
});

process.once("SIGTERM", () => {
  void daemon.close().finally(() => process.exit(0));
});
process.once("SIGINT", () => {
  void daemon.close().finally(() => process.exit(0));
});

await once(process, "beforeExit");
