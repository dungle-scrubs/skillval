import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CaseFileError, parseCaseFile, readCaseFile } from "../src/case-file.js";

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

  it("parses suite-level and per-case fixtures", () => {
    const source = `
skill: fixtures
class: capability
fixture:
  path: fixtures/base
cases:
  - id: default
    mode: generation
    prompt: use the suite fixture
  - id: override
    mode: generation
    prompt: use my own fixture
    fixture:
      setup: ["git init -q"]
`;

    const parsed = parseCaseFile(source);

    expect(parsed.fixture).toEqual({ path: "fixtures/base" });
    expect(parsed.cases[0]?.fixture).toBeUndefined();
    expect(parsed.cases[1]?.fixture).toEqual({ setup: ["git init -q"] });
  });

  it("rejects a fixture with neither path nor setup", () => {
    const source = `
skill: fixtures
class: capability
cases:
  - id: empty-fixture
    mode: generation
    prompt: test
    fixture: {}
`;

    expect(() => parseCaseFile(source)).toThrow(CaseFileError);
    expect(() => parseCaseFile(source)).toThrow(/fixture/);
  });
});

describe("fixture path validation", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects a case fixture path that does not exist, naming the case id", () => {
    const path = writeSuite(`
skill: fixtures
class: capability
cases:
  - id: missing-fixture
    mode: generation
    prompt: test
    fixture:
      path: fixtures/absent
`);

    expect(() => readCaseFile(path)).toThrow(
      'case "missing-fixture" fixture path "fixtures/absent" does not exist',
    );
  });

  it("rejects a fixture path that is a file, not a directory", () => {
    const path = writeSuite(`
skill: fixtures
class: capability
fixture:
  path: fixtures/plain.txt
cases: []
`);
    const skillDirectory = join(path, "..");
    mkdirSync(join(skillDirectory, "fixtures"));
    writeFileSync(join(skillDirectory, "fixtures", "plain.txt"), "not a directory");

    expect(() => readCaseFile(path)).toThrow(
      'suite fixture path "fixtures/plain.txt" is not a directory',
    );
  });

  it("rejects a fixture directory containing a symlink", () => {
    const path = writeSuite(`
skill: fixtures
class: capability
cases:
  - id: linked
    mode: generation
    prompt: test
    fixture:
      path: fixtures/repo
`);
    const repo = join(path, "..", "fixtures", "repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "real.txt"), "content");
    symlinkSync(join(repo, "real.txt"), join(repo, "alias"));

    expect(() => readCaseFile(path)).toThrow(
      'case "linked" fixture path "fixtures/repo" contains unsupported symlink "alias"',
    );
  });

  it("accepts a fixture path that exists as a directory", () => {
    const path = writeSuite(`
skill: fixtures
class: capability
cases:
  - id: present
    mode: generation
    prompt: test
    fixture:
      path: fixtures/repo
`);
    mkdirSync(join(path, "..", "fixtures", "repo"), { recursive: true });

    expect(readCaseFile(path).cases[0]?.fixture).toEqual({ path: "fixtures/repo" });
  });

  function writeSuite(source: string): string {
    const skillDirectory = mkdtempSync(join(tmpdir(), "skillval-case-file-test-"));
    directories.push(skillDirectory);
    const path = join(skillDirectory, "skillval.yml");
    writeFileSync(path, source);
    return path;
  }
});
