import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverSkills, discoveryReport, selectSkills } from "../src/discovery.js";

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

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "skillval-discovery-test-"));
  directories.push(root);
  return root;
}

function createSkill(root: string, name: string, caseFile?: string): void {
  const directory = join(root, name);
  mkdirSync(directory);
  writeFileSync(join(directory, "SKILL.md"), `# ${name}\n`);
  if (caseFile !== undefined) writeFileSync(join(directory, "skillval.yml"), caseFile);
}
