import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EVAL_DEFINITION_FILE, stageSkill } from "../src/executors/seed.js";
import { skillContentHash } from "../src/utils.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { force: true, recursive: true });
});

function skillDir(): string {
  const d = mkdtempSync(join(tmpdir(), "skillval-seed-"));
  dirs.push(d);
  writeFileSync(join(d, "SKILL.md"), "# the skill\n");
  writeFileSync(
    join(d, EVAL_DEFINITION_FILE),
    "skill: x\ncases:\n  - id: c\n    assert:\n      must_match: ['the answer']\n",
  );
  return d;
}

describe("stageSkill", () => {
  it("hides the eval definition from the arm being graded", () => {
    const source = skillDir();
    const parent = mkdtempSync(join(tmpdir(), "skillval-ws-"));
    dirs.push(parent);

    const staged = stageSkill(parent, "x", source);
    const visible = readdirSync(staged);

    // The answer key must not be reachable: only the target-present arm is seeded, so a leak here
    // is asymmetric and inflates load-bearing verdicts.
    expect(visible).toContain("SKILL.md");
    expect(visible).not.toContain(EVAL_DEFINITION_FILE);
    expect(readFileSync(join(staged, "SKILL.md"), "utf8")).toContain("the skill");
  });

  it("still exposes on-demand references the skill loads itself", () => {
    const source = skillDir();
    writeFileSync(join(source, "reference.md"), "detail\n");
    const parent = mkdtempSync(join(tmpdir(), "skillval-ws-"));
    dirs.push(parent);

    expect(readdirSync(stageSkill(parent, "x", source))).toContain("reference.md");
  });
});

describe("skillContentHash", () => {
  it("ignores the eval definition, so editing a case cannot bust unrelated arms", () => {
    const source = skillDir();
    const before = skillContentHash(source);

    writeFileSync(join(source, EVAL_DEFINITION_FILE), "skill: x\ncases: []\n");
    expect(skillContentHash(source)).toBe(before);

    writeFileSync(join(source, "SKILL.md"), "# changed\n");
    expect(skillContentHash(source)).not.toBe(before);
  });
});
