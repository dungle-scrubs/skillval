import { describe, expect, it } from "vitest";
import { CaseFileError, parseCaseFile } from "../src/case-file.js";

const validCaseFile = `
skill: standards-typescript
class: preference
cases:
  - id: enum-question
    mode: generation
    type: preference
    rule: enums-as-const
    should_trigger: true
    arms: [skill, baseline]
    prompt: Should I use an enum?
    assert:
      must_match: ["as const"]
      must_not_match: ["\\\\benum\\\\s"]
      graders: [tsc]
    trials: 3
`;

describe("case-file parsing", () => {
  it("parses the complete case shape", () => {
    const parsed = parseCaseFile(
      validCaseFile,
      "/tmp/standards-typescript/skillval.yml",
      "standards-typescript",
    );

    expect(parsed.class).toBe("preference");
    expect(parsed.skill).toBe("standards-typescript");
    expect(parsed.cases).toHaveLength(1);
    expect(parsed.cases[0]).toMatchObject({
      arms: ["skill", "baseline"],
      id: "enum-question",
      mode: "generation",
      rule: "enums-as-const",
      should_trigger: true,
      trials: 3,
      type: "preference",
    });
  });

  it("reports a mismatched declared skill", () => {
    expect(() => parseCaseFile(validCaseFile, "skillval.yml", "different-skill")).toThrow(
      'declares skill "standards-typescript", expected "different-skill"',
    );
  });

  it("reports duplicate case identifiers", () => {
    const source = `
skill: duplicate
class: capability
cases:
  - id: same
    mode: trigger
    prompt: one
  - id: same
    mode: generation
    prompt: two
`;

    expect(() => parseCaseFile(source)).toThrow('case id "same" is duplicated');
  });

  it("reports invalid regular expressions", () => {
    const source = `
skill: regex
class: capability
cases:
  - id: broken
    mode: trigger
    prompt: test
    assert:
      must_match: ["["]
`;

    expect(() => parseCaseFile(source)).toThrow(CaseFileError);
    expect(() => parseCaseFile(source)).toThrow("invalid must_match regex");
  });

  it("rejects trial counts outside 1 through 5", () => {
    const source = `
skill: trials
class: capability
cases:
  - id: too-many
    mode: trigger
    prompt: test
    trials: 6
`;

    expect(() => parseCaseFile(source)).toThrow("trials must be an integer from 1 through 5");
  });

  it("rejects unsupported grader names instead of silently ignoring them", () => {
    const source = `
skill: graders
class: capability
cases:
  - id: unknown
    mode: generation
    prompt: test
    assert:
      graders: [typescript]
`;

    expect(() => parseCaseFile(source)).toThrow(/graders.*allowed values/i);
  });

  it("rejects graders used with an unsupported case mode", () => {
    const source = `
skill: graders
class: capability
cases:
  - id: wrong-mode
    mode: trigger
    prompt: test
    assert:
      graders: [tsc]
`;

    expect(() => parseCaseFile(source)).toThrow('grader "tsc" does not support trigger mode');
  });

  it("rejects whitespace-only identifiers consistently with the published schema", () => {
    const source = `
skill: " "
class: capability
cases: []
`;

    expect(() => parseCaseFile(source)).toThrow(/skill.*pattern/i);
  });
});
