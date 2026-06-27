import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { protocolFixtures, type ProtocolFixture } from "../scripts/generate-ios-remote-fixtures.js";

describe("iOS remote protocol fixtures", () => {
  it("stay generated from the TypeScript wire protocol", () => {
    const fixtures = JSON.parse(
      readFileSync(
        "ios-remote-client/Tests/PiRemoteClientTests/Fixtures/protocol-fixtures.json",
        "utf8",
      ),
    ) as ProtocolFixture[];

    expect(fixtures).toEqual(protocolFixtures());
  });
});
