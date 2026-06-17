import { describe, expect, it } from "vitest";

import type { Envelope } from "../pi-extensions/remote/protocol.js";
import {
  acceptConnection,
  acceptStream,
  bindEndpoint,
  closeEndpoint,
  connectEndpoint,
  finishSending,
  openStream,
  receiveEnvelopes,
  sendEnvelope,
} from "../pi-extensions/remote/iroh-transport.js";

describe("remote iroh transport", () => {
  it("round-trips an envelope over pi/remote/1 between two endpoints", async () => {
    const server = await bindEndpoint();
    const client = await bindEndpoint();
    const frame: Envelope = {
      sessionId: "session-1",
      type: "event",
      payload: { text: "hello iroh" },
    };

    try {
      const echo = (async () => {
        const connection = await acceptConnection(server);
        const stream = await acceptStream(connection);
        const [received] = await receiveEnvelopes(stream);
        await sendEnvelope(stream, received);
        await finishSending(stream);
        return received;
      })();

      const connection = await connectEndpoint(client, server.addr());
      const stream = await openStream(connection);
      await sendEnvelope(stream, frame);
      await finishSending(stream);
      const [response] = await receiveEnvelopes(stream);

      expect(response).toEqual(frame);
      await expect(echo).resolves.toEqual(frame);
    } finally {
      await closeEndpoint(client);
      await closeEndpoint(server);
    }
  }, 30_000);
});
