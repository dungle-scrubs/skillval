import { describe, expect, it } from "vitest";
import { caseGraderLabels, caseRung, computeCoverage } from "../src/coverage.js";
import type { ReadyDiscoveredSkill } from "../src/discovery.js";
import type { EvalCase } from "../src/types.js";

const triggerCase = (id: string, shouldTrigger = true): EvalCase => ({
  id,
  mode: "trigger",
  prompt: "p",
  should_trigger: shouldTrigger,
});

const regexCase = (id: string): EvalCase => ({
  arms: ["solo", "baseline"],
  id,
  mode: "generation",
  prompt: "p",
  assert: { must_match: ["x"] },
});

const executionCase = (id: string): EvalCase => ({
  arms: ["solo", "baseline"],
  id,
  mode: "generation",
  prompt: "p",
  assert: { command_exit: { command: "true" }, must_match: ["x"] },
});

function skill(name: string, root: string, cases: EvalCase[]): ReadyDiscoveredSkill {
  return {
    caseCount: cases.length,
    class: "capability",
    evals: { cases, class: "capability", skill: name },
    hasSkillval: true,
    name,
    root,
    skillDirectory: `${root}/${name}`,
    status: "ready",
    validationError: undefined,
  };
}

describe("caseRung", () => {
  it("classifies by the strongest grader present", () => {
    expect(caseRung(triggerCase("t"))).toBe("trigger");
    // A case with no grader at all checks only trace completeness - it is evidence of nothing
    // and must not be presented as trigger coverage.
    expect(caseRung({ id: "bare", mode: "trigger", prompt: "p" })).toBe("ungraded");
    expect(caseRung(regexCase("r"))).toBe("regex");
    // Execution outranks a regex on the same case.
    expect(caseRung(executionCase("x"))).toBe("execution");
  });

  it("treats the registered graders (tsc) and json_schema as execution", () => {
    expect(
      caseRung({ assert: { graders: ["tsc"] }, id: "g", mode: "generation", prompt: "p" }),
    ).toBe("execution");
    expect(
      caseRung({
        assert: { json_schema: { file: "out.json", schema: true } },
        id: "j",
        mode: "generation",
        prompt: "p",
      }),
    ).toBe("execution");
  });
});

describe("caseGraderLabels", () => {
  it("lists every grader in ladder order with counts", () => {
    const labels = caseGraderLabels({
      assert: {
        command_exit: { command: "true" },
        graders: ["tsc"],
        must_match: ["a", "b"],
        must_not_match: ["c"],
      },
      id: "all",
      mode: "generation",
      prompt: "p",
      should_trigger: true,
    });
    expect(labels).toEqual([
      "should_trigger: true",
      "must_match x2",
      "must_not_match",
      "command_exit",
      "tsc",
    ]);
  });
});

describe("computeCoverage", () => {
  const report = computeCoverage([
    skill("strong", "/roots/alpha", [executionCase("x"), triggerCase("neg", false)]),
    skill("weak", "/roots/alpha", [triggerCase("t"), triggerCase("neg", false)]),
    skill("mixed", "/roots/beta", [regexCase("r"), triggerCase("t")]),
  ]);

  it("aggregates totals and rung counts", () => {
    expect(report.skillCount).toBe(3);
    expect(report.caseCount).toBe(6);
    expect(report.counts).toEqual({ execution: 1, regex: 1, trigger: 4, ungraded: 0 });
  });

  it("groups by root and sorts skills weakest-coverage-first", () => {
    expect(report.groups.map((group) => group.label)).toEqual(["alpha", "beta"]);
    const alpha = report.groups[0];
    // weak (0% behavioral) sorts before strong (50%).
    expect(alpha?.skills.map((member) => member.name)).toEqual(["weak", "strong"]);
  });

  it("surfaces the gap lists as unambiguous refs", () => {
    expect(report.skillsWithoutBehavioralCases).toEqual([{ name: "weak", root: "/roots/alpha" }]);
    // mixed has no should_trigger: false case.
    expect(report.skillsWithoutNegativeTrigger).toEqual([{ name: "mixed", root: "/roots/beta" }]);
    expect(report.skillsWithBaselineComparison).toBe(2);
  });

  it("carries discovery diagnostics instead of silently narrowing the universe", () => {
    const partial = computeCoverage(
      [
        skill("ok", "/roots/alpha", [triggerCase("t")]),
        {
          caseCount: 0,
          class: "invalid",
          hasSkillval: true,
          name: "broken",
          root: "/roots/alpha",
          skillDirectory: "/roots/alpha/broken",
          status: "invalid",
          validationError: "bad yaml",
        },
      ],
      ["/roots/gone"],
    );
    expect(partial.skillCount).toBe(1);
    expect(partial.missingRoots).toEqual(["/roots/gone"]);
    expect(partial.skipped).toEqual([
      { name: "broken", root: "/roots/alpha", status: "invalid", validationError: "bad yaml" },
    ]);
  });

  it("requires both arms for a baseline comparison", () => {
    const oneArmed = computeCoverage([
      skill("baseline-only", "/roots/alpha", [
        {
          arms: ["baseline"],
          assert: { must_match: ["x"] },
          id: "b",
          mode: "generation",
          prompt: "p",
        },
      ]),
    ]);
    expect(oneArmed.skillsWithBaselineComparison).toBe(0);
  });
});
