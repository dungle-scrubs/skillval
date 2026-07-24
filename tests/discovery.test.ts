import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverProjects,
  discoverSkills,
  discoveryReport,
  isExcluded,
  selectSkills,
} from "../src/discovery.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("skill discovery", () => {
  it("models missing, invalid, and ready skills as distinct states", () => {
    const root = createRoot();
    createSkill(root, "missing");
    createSkill(root, "invalid", "not: valid");
    createSkill(
      root,
      "ready",
      "skill: ready\nclass: capability\ncases:\n  - id: works\n    mode: trigger\n    prompt: test\n",
    );

    const discovery = discoverSkills([root]);

    expect(discovery.skills.map((skill) => skill.status)).toEqual(["invalid", "missing", "ready"]);
    expect(selectSkills(discovery, [])).toHaveLength(1);
    expect(selectSkills(discovery, ["ready"])[0]?.evals.cases[0]?.id).toBe("works");
    expect(() => selectSkills(discovery, ["invalid"])).toThrow("skillval.yml");
    expect(() => selectSkills(discovery, ["missing"])).toThrow("has no skillval.yml");
  });

  it("keeps parsed evaluation contents out of the discovery report", () => {
    const root = createRoot();
    createSkill(
      root,
      "ready",
      "skill: ready\nclass: capability\ncases:\n  - id: secret\n    mode: trigger\n    prompt: private prompt\n",
    );

    const report = discoveryReport(discoverSkills([root]));

    expect(JSON.stringify(report)).not.toContain("private prompt");
    expect(report.skills[0]).toMatchObject({ status: "ready" });
  });
});

describe("project discovery", () => {
  it("finds nested instruction targets and project-scoped skills while skipping vendor trees", () => {
    const root = createRoot();
    const projectBase = basename(root);
    createInstructionTarget(root, "AGENTS.md");
    createInstructionTarget(join(root, "packages/api"), "CLAUDE.md");
    createSkill(join(root, ".claude/skills"), "foo", normalSkillCaseFile("foo"));
    createInstructionTarget(join(root, "node_modules/dependency"), "AGENTS.md");
    createInstructionTarget(join(root, ".git/hooks"), "CLAUDE.md");

    const discovery = discoverProjects([root]);

    expect(discovery.instructions.map((instruction) => instruction.id)).toEqual([
      `${projectBase}:.`,
      `${projectBase}:packages/api`,
    ]);
    expect(discovery.instructions.map((instruction) => instruction.status)).toEqual([
      "ready",
      "ready",
    ]);
    expect(discovery.skills).toHaveLength(1);
    expect(discovery.skills[0]).toMatchObject({ name: "foo", status: "ready" });
  });

  it("reports instruction case files with a forbidden skill or a skill target as invalid", () => {
    const root = createRoot();
    createInstructionTarget(
      join(root, "with-skill"),
      "AGENTS.md",
      "target: instructions\nskill: forbidden\nclass: capability\ncases: []\n",
    );
    createInstructionTarget(
      join(root, "skill-target"),
      "CLAUDE.md",
      normalSkillCaseFile("plain-skill"),
    );

    const discovery = discoverProjects([root]);

    expect(discovery.instructions).toHaveLength(2);
    expect(discovery.instructions[0]).toMatchObject({
      status: "invalid",
      validationError: expect.stringContaining('target must be "instructions"'),
    });
    expect(discovery.instructions[1]).toMatchObject({
      status: "invalid",
      validationError: expect.stringContaining('must not declare "skill"'),
    });
  });
});

describe("exclusion", () => {
  it("matches names by literal and by glob, treating regex metacharacters literally", () => {
    expect(isExcluded("impeccable", ["impeccable"])).toBe(true);
    expect(isExcluded("impeccable", ["imp*"])).toBe(true);
    expect(isExcluded("impeccable", ["im?eccable"])).toBe(true);
    expect(isExcluded("vendor-lint", ["vendor-*"])).toBe(true);
    expect(isExcluded("mine", ["impeccable", "vendor-*"])).toBe(false);
    // A dot is literal, not a regex wildcard: "aXb" must not match the pattern "a.b".
    expect(isExcluded("aXb", ["a.b"])).toBe(false);
    expect(isExcluded("a.b", ["a.b"])).toBe(true);
  });

  it("omits excluded skills from root discovery entirely", () => {
    const root = createRoot();
    createSkill(root, "mine", "skill: mine\nclass: capability\ncases: []\n");
    createSkill(root, "impeccable", "skill: impeccable\nclass: capability\ncases: []\n");

    const discovery = discoverSkills([root], ["impeccable"]);

    expect(discovery.skills.map((skill) => skill.name)).toEqual(["mine"]);
  });

  it("omits excluded project-scoped skills while leaving instruction targets intact", () => {
    const root = createRoot();
    const projectBase = basename(root);
    createInstructionTarget(root, "AGENTS.md");
    createSkill(join(root, ".claude/skills"), "mine", normalSkillCaseFile("mine"));
    createSkill(join(root, ".claude/skills"), "vendor-x", normalSkillCaseFile("vendor-x"));

    const discovery = discoverProjects([root], ["vendor-*"]);

    expect(discovery.skills.map((skill) => skill.name)).toEqual(["mine"]);
    expect(discovery.instructions.map((instruction) => instruction.id)).toEqual([
      `${projectBase}:.`,
    ]);
  });
});

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "skillval-discovery-test-"));
  directories.push(root);
  return root;
}

function createSkill(root: string, name: string, caseFile?: string): void {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "SKILL.md"), `# ${name}\n`);
  if (caseFile !== undefined) writeFileSync(join(directory, "skillval.yml"), caseFile);
}

function createInstructionTarget(
  directory: string,
  instructionFile: "AGENTS.md" | "CLAUDE.md",
  caseFile = "target: instructions\nclass: preference\ncases: []\n",
): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, instructionFile), "# Instructions\n");
  writeFileSync(join(directory, "skillval.yml"), caseFile);
}

function normalSkillCaseFile(name: string): string {
  return `skill: ${name}\nclass: capability\ncases: []\n`;
}
