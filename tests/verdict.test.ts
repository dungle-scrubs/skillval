import { describe, expect, it } from "vitest";
import { groupVerdict, VERDICT_TEXT } from "../src/verdict.js";

describe("groupVerdict", () => {
  it("flags interference when the skill works alone but the loadout breaks it", () => {
    expect(groupVerdict(true, false, true, true)).toBe("interference");
    expect(groupVerdict(true, false, false, true)).toBe("interference");
    // Interference holds even for a pure trigger case (peers not meaningful).
    expect(groupVerdict(true, false, true, false)).toBe("interference");
  });

  it("is load-bearing when the loadout passes only with the skill", () => {
    expect(groupVerdict(true, true, false, true)).toBe("load-bearing");
    expect(groupVerdict(false, true, false, true)).toBe("load-bearing");
  });

  it("is redundant when the loadout passes with or without the skill", () => {
    expect(groupVerdict(true, true, true, true)).toBe("redundant");
  });

  it("is prune when the skill fails alone but the rest of the loadout carries the case", () => {
    expect(groupVerdict(false, false, true, true)).toBe("prune");
    // Even when the group arm passes: solo fail means the skill is not itself needed.
    expect(groupVerdict(false, true, true, true)).toBe("prune");
  });

  it("is inconclusive when nothing passes", () => {
    expect(groupVerdict(false, false, false, true)).toBe("inconclusive");
  });

  it("is inconclusive for a non-interference case when peers cannot be graded", () => {
    // A pure trigger-only case: solo and group pass, peers passes vacuously; not redundant.
    expect(groupVerdict(true, true, true, false)).toBe("inconclusive");
    expect(groupVerdict(false, true, false, false)).toBe("inconclusive");
  });

  it("has plain-language text for every verdict", () => {
    for (const verdict of Object.keys(VERDICT_TEXT)) {
      expect(VERDICT_TEXT[verdict as keyof typeof VERDICT_TEXT]).toMatch(/\w/);
    }
  });
});
