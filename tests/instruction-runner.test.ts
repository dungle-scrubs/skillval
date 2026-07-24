import { describe, expect, it } from "vitest";
import { createNaInstructionFinding, instructionAction, routeRunTargets } from "../src/runner.js";
import type { EvalCase } from "../src/types.js";

const evalCase: EvalCase = {
  id: "concise-output",
  mode: "generation",
  prompt: "Answer briefly.",
  rule: "concise",
  rule_text: "Keep answers concise.",
};

describe("instruction reporting", () => {
  it("maps verdicts to remediation actions", () => {
    expect(instructionAction("load-bearing")).toBe("keep");
    expect(instructionAction("redundant")).toBe("delete");
    expect(instructionAction("prune")).toBe("delete");
    expect(instructionAction("interference")).toBe("review");
    expect(instructionAction("inconclusive")).toBe("investigate");
    expect(instructionAction("n/a")).toBe("investigate");
  });

  it("creates an n/a finding with no trial evidence", () => {
    expect(createNaInstructionFinding(evalCase, "codex")).toEqual({
      action: "investigate",
      arms: [],
      caseId: "concise-output",
      file: "",
      naReason: "rule is not in a file codex reads ambiently",
      rule: "concise",
      span: "Keep answers concise.",
      verdict: "n/a",
    });
  });
});

describe("run target routing", () => {
  it("routes colon IDs to instructions and other arguments to skills", () => {
    expect(routeRunTargets(["myapp:.", "standards-typescript", "myapp:packages/api"])).toEqual({
      requestedInstructions: ["myapp:.", "myapp:packages/api"],
      requestedSkills: ["standards-typescript"],
    });
  });

  it("keeps both selections empty when no positional arguments are given", () => {
    expect(routeRunTargets([])).toEqual({
      requestedInstructions: [],
      requestedSkills: [],
    });
  });
});
