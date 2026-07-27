import { describe, expect, it } from "vitest";
import { gradeTrial } from "../src/grade.js";
import type { EvalCase, Trace } from "../src/types.js";

const trace = (agentText: string): Trace => ({
  agentText,
  completed: true,
  invocationEvidence: null,
  invoked: false,
  usage: null,
});

const triggerCase = (mustNotMatch: readonly string[]): EvalCase =>
  ({
    assert: { must_not_match: mustNotMatch },
    id: "case",
    mode: "trigger",
    prompt: "prompt",
  }) as EvalCase;

describe("must_not_match diagnostics", () => {
  it("reports what matched and the text around it, not just the pattern", () => {
    // Without the surrounding clause a reader cannot tell a real violation ("this is overkill")
    // from a correct answer that merely contains the banned word ("not overkill here") - the defect
    // class where a trap fires on correct output, which is invisible when only the pattern is shown.
    const checks = gradeTrial(
      triggerCase([String.raw`\boverkill\b`]),
      "solo",
      trace("Effect is not overkill here; adopt it for this codebase."),
      "/tmp",
    );

    const check = checks.find((candidate) => candidate.name === "must_not_match");
    expect(check?.pass).toBe(false);
    expect(check?.detail).toContain('matched "overkill"');
    expect(check?.detail).toContain("not overkill here");
  });

  it("collapses whitespace so a multi-line hit stays one readable line", () => {
    const checks = gradeTrial(
      triggerCase(["banned"]),
      "solo",
      trace("prose\n\n   banned\n\ttoken   here"),
      "/tmp",
    );

    expect(checks.find((candidate) => candidate.name === "must_not_match")?.detail).toContain(
      "prose banned token here",
    );
  });

  it("reports the bare pattern when the rule passes", () => {
    const checks = gradeTrial(triggerCase(["nope"]), "solo", trace("clean answer"), "/tmp");

    const check = checks.find((candidate) => candidate.name === "must_not_match");
    expect(check?.pass).toBe(true);
    expect(check?.detail).toBe("nope");
  });
});
