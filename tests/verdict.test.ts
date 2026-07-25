import { describe, expect, it } from "vitest";
import { armState, groupVerdict, VERDICT_TEXT } from "../src/verdict.js";

describe("groupVerdict", () => {
  it("flags interference when the skill works alone but the loadout breaks it", () => {
    // Peers pass without the target, so adding the target is what breaks the case: real interference.
    expect(groupVerdict("pass", "fail", "pass", true)).toBe("interference");
    // Interference holds even for a pure trigger case (peers not meaningful): solo-vs-group still
    // isolates the target's effect.
    expect(groupVerdict("pass", "fail", "pass", false)).toBe("interference");
    expect(groupVerdict("pass", "fail", "fail", false)).toBe("interference");
  });

  it("does not blame the target when the peers arm also fails the case", () => {
    // solo passes, group fails, but peers (loadout minus target) is meaningful and also fails: the
    // loadout breaks the case without the target, so this is not the target's interference.
    expect(groupVerdict("pass", "fail", "fail", true)).toBe("inconclusive");
  });

  it("is load-bearing when the loadout passes only with the skill", () => {
    expect(groupVerdict("pass", "pass", "fail", true)).toBe("load-bearing");
    expect(groupVerdict("fail", "pass", "fail", true)).toBe("load-bearing");
  });

  it("is redundant when the loadout passes with or without the skill", () => {
    expect(groupVerdict("pass", "pass", "pass", true)).toBe("redundant");
  });

  it("is prune when the skill fails alone but the rest of the loadout carries the case", () => {
    expect(groupVerdict("fail", "fail", "pass", true)).toBe("prune");
    // Even when the group arm passes: solo fail means the skill is not itself needed.
    expect(groupVerdict("fail", "pass", "pass", true)).toBe("prune");
  });

  it("is inconclusive when nothing passes", () => {
    expect(groupVerdict("fail", "fail", "fail", true)).toBe("inconclusive");
  });

  it("is inconclusive for a non-interference case when peers cannot be graded", () => {
    // A pure trigger-only case: solo and group pass, peers passes vacuously; not redundant.
    expect(groupVerdict("pass", "pass", "pass", false)).toBe("inconclusive");
    expect(groupVerdict("fail", "pass", "fail", false)).toBe("inconclusive");
  });

  it("is inconclusive when any consulted arm was never graded", () => {
    // An infra arm is evidence of nothing: no combination of graded arms around it may claim a
    // verdict, even one that would otherwise be decidable without the infra arm.
    expect(groupVerdict("infra", "pass", "fail", true)).toBe("inconclusive");
    expect(groupVerdict("pass", "infra", "pass", true)).toBe("inconclusive");
    expect(groupVerdict("pass", "fail", "infra", true)).toBe("inconclusive");
    expect(groupVerdict("fail", "pass", "infra", true)).toBe("inconclusive");
  });

  it("ignores an infra peers arm when peers is not consulted", () => {
    // Peers is vacuous for a pure trigger-only case, so an infra peers arm must not block the
    // solo-vs-group interference comparison.
    expect(groupVerdict("pass", "fail", "infra", false)).toBe("interference");
    expect(groupVerdict("pass", "pass", "infra", false)).toBe("inconclusive");
  });

  it("has plain-language text for every verdict", () => {
    for (const verdict of Object.keys(VERDICT_TEXT)) {
      expect(VERDICT_TEXT[verdict as keyof typeof VERDICT_TEXT]).toMatch(/\w/);
    }
  });
});

describe("armState", () => {
  it("maps a graded arm to its pass or fail", () => {
    expect(armState({ pass: true })).toBe("pass");
    expect(armState({ pass: false })).toBe("fail");
  });

  it("maps an ungraded arm to infra regardless of its nominal pass", () => {
    expect(armState({ infrastructure: true, pass: false })).toBe("infra");
  });
});
