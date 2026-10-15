import { describe, expect, it } from "vitest";
import {
  applyMeaningfulEvent,
  computeIdleDelayMs,
  nextIdleBackoff,
} from "../pi-extensions/headlong/policy.js";

describe("Headlong wake policy", () => {
  it("dwells, grows exponentially to the cap, and resets immediately on meaningful work", () => {
    const config = { baseMs: 1_000, factor: 2, capMs: 4_000, hold: 2 };
    let state = { backoffLevel: 0, ticksAtLevel: 0, consecutiveFailures: 3 };
    const delays: number[] = [];

    for (let index = 0; index < 10; index += 1) {
      state = { ...state, ...nextIdleBackoff(state, config) };
      delays.push(computeIdleDelayMs(state.backoffLevel, config));
    }

    expect(delays).toEqual([0, 1_000, 1_000, 2_000, 2_000, 4_000, 4_000, 4_000, 4_000, 4_000]);
    expect(applyMeaningfulEvent(state)).toMatchObject({
      backoffLevel: 0,
      ticksAtLevel: 0,
      consecutiveFailures: 0,
    });
  });
});
