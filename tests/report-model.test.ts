import { describe, expect, it } from "vitest";
import { cardEvidence, skillCaseAction, skillCaseReason } from "../src/report-model.js";
import type { ArmResult, CaseResult, Check, RuntimeArm } from "../src/types.js";

function armOf(
  arm: RuntimeArm,
  pass: boolean,
  checks: readonly Check[] = [],
  infrastructure?: boolean,
): ArmResult {
  return {
    arm,
    cached: false,
    ...(infrastructure === undefined ? {} : { infrastructure }),
    pass,
    trials: [{ checks, pass, usage: null }],
  };
}

function caseOf(partial: Partial<CaseResult> & Pick<CaseResult, "arms">): CaseResult {
  return {
    id: "case",
    inconclusive: false,
    noop: false,
    pass: true,
    rule: undefined,
    ...partial,
  };
}

const termsIn = (result: CaseResult): string[] =>
  skillCaseReason(result)
    .filter((segment) => segment.kind === "term")
    .map((segment) => (segment.kind === "term" ? segment.term : ""));

describe("skillCaseAction", () => {
  it("maps solo-mode outcomes", () => {
    expect(skillCaseAction(caseOf({ arms: [], inconclusive: true, pass: false }))).toBe("rerun");
    expect(skillCaseAction(caseOf({ arms: [], pass: false }))).toBe("investigate");
    expect(skillCaseAction(caseOf({ arms: [], noop: true }))).toBe("prune-candidate");
    expect(skillCaseAction(caseOf({ arms: [armOf("solo", true), armOf("baseline", false)] }))).toBe(
      "keep",
    );
    expect(skillCaseAction(caseOf({ arms: [armOf("solo", true)] }))).toBe("ok");
  });

  it("does not call an infra baseline a load-bearing comparison", () => {
    const result = caseOf({
      arms: [armOf("solo", true), armOf("baseline", false, [], true)],
    });
    expect(skillCaseAction(result)).toBe("ok");
  });

  it("maps group verdicts, deliberately diverging from instructionAction", () => {
    const group = (
      verdict: "inconclusive" | "interference" | "load-bearing" | "prune" | "redundant",
    ) => caseOf({ arms: [], loadout: { name: "l", verdict } });
    expect(skillCaseAction(group("load-bearing"))).toBe("keep");
    // A skill's no-op is a prune CANDIDATE to verify cross-model, never a delete.
    expect(skillCaseAction(group("prune"))).toBe("prune-candidate");
    expect(skillCaseAction(group("redundant"))).toBe("review");
    expect(skillCaseAction(group("interference"))).toBe("review");
    expect(skillCaseAction(group("inconclusive"))).toBe("investigate");
    expect(
      skillCaseAction(
        caseOf({ arms: [], inconclusive: true, loadout: { name: "l", verdict: "inconclusive" } }),
      ),
    ).toBe("rerun");
  });
});

describe("skillCaseReason", () => {
  it("teaches the prune chain through baseline and no-op terms", () => {
    const result = caseOf({ arms: [armOf("solo", true), armOf("baseline", true)], noop: true });
    expect(termsIn(result)).toEqual(["baseline", "no-op"]);
  });

  it("names both arms when solo fails while baseline passes", () => {
    const result = caseOf({ arms: [], noop: true, pass: false });
    expect(termsIn(result)).toEqual(expect.arrayContaining(["solo", "baseline"]));
  });

  it("does not blame a passing group arm for an inconclusive verdict", () => {
    const result = caseOf({
      arms: [armOf("group", true)],
      loadout: { name: "l", verdict: "inconclusive" },
    });
    const sentence = skillCaseReason(result)
      .map((segment) => segment.text ?? "")
      .join("");
    expect(sentence).toContain("did not form a conclusive pattern");
    expect(sentence).not.toContain("failed its checks");
  });
});

describe("cardEvidence", () => {
  it("points at the deciding arm's failing checks", () => {
    const failing: Check = { detail: "pattern | got: text", name: "must_match", pass: false };
    const result = caseOf({
      arms: [armOf("solo", false, [failing]), armOf("baseline", true)],
      pass: false,
    });
    expect(cardEvidence(result)).toEqual([failing]);
  });

  it("spans every arm for a group-inconclusive verdict", () => {
    // The group arm passed; the cause is the infra solo arm - its check must surface.
    const infraCheck: Check = {
      detail: "agent output exceeded the capture limit",
      name: "infrastructure",
      pass: false,
    };
    const result = caseOf({
      arms: [
        armOf("solo", false, [infraCheck], true),
        armOf("group", true, [{ detail: "matched", name: "must_match", pass: true }]),
        armOf("peers", true),
      ],
      loadout: { name: "l", verdict: "inconclusive" },
    });
    expect(cardEvidence(result)).toEqual([infraCheck]);
  });
});
