import { describe, expect, it } from "vitest";
import { clampedTrialCount, hasMajority, shouldEscalate } from "../src/vote.js";

function trials(...passes: readonly boolean[]): readonly { readonly pass: boolean }[] {
  return passes.map((pass) => ({ pass }));
}

describe("majority voting", () => {
  it("clamps configured trials to 1 through 5", () => {
    expect(clampedTrialCount(undefined)).toBe(1);
    expect(clampedTrialCount(-2)).toBe(1);
    expect(clampedTrialCount(3)).toBe(3);
    expect(clampedTrialCount(9)).toBe(5);
  });

  it("requires a strict majority", () => {
    expect(hasMajority(trials(true))).toBe(true);
    expect(hasMajority(trials(true, false))).toBe(false);
    expect(hasMajority(trials(true, true, false))).toBe(true);
    expect(hasMajority(trials(false, false, true))).toBe(false);
  });

  it("escalates disagreement until five trials", () => {
    expect(shouldEscalate(trials(true))).toBe(false);
    expect(shouldEscalate(trials(true, false))).toBe(true);
    expect(shouldEscalate(trials(true, false, true, true))).toBe(true);
    expect(shouldEscalate(trials(true, false, true, true, true))).toBe(false);
  });
});
