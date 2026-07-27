import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EVAL_DEFINITION_FILE,
  stageSkill,
  withoutInvocationOptOut,
} from "../src/executors/seed.js";
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

    const staged = stageSkill(parent, "x", source).target;
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

    expect(readdirSync(stageSkill(parent, "x", source).target)).toContain("reference.md");
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

describe("withoutInvocationOptOut", () => {
  it("drops the opt-out so a user-invoked skill can reach the model", () => {
    // Verified live: with this key Claude Code withholds the skill entirely - no listing, no Skill
    // tool call, body never in context - which makes a seeded arm identical to its own baseline and
    // every case on the skill unfalsifiable.
    const source = [
      "---",
      "name: restructure",
      'description: "Plan a reorganization."',
      "disable-model-invocation: true",
      "allowed-tools: Read, Write",
      "---",
      "",
      "# Restructure",
    ].join("\n");

    const staged = withoutInvocationOptOut(source);
    expect(staged.changed).toBe(true);
    expect(staged.text).not.toContain("disable-model-invocation");
    expect(staged.text).toContain("name: restructure");
    expect(staged.text).toContain("allowed-tools: Read, Write");
    expect(staged.text).toContain("# Restructure");
  });

  it("leaves a skill without the opt-out byte-identical", () => {
    const source = '---\nname: plain\ndescription: "d"\n---\n\n# Plain\n';
    const staged = withoutInvocationOptOut(source);
    expect(staged.changed).toBe(false);
    expect(staged.text).toBe(source);
  });

  it("ignores a false value and a mention in prose", () => {
    const flagged = "---\nname: s\ndisable-model-invocation: false\n---\n\nbody\n";
    expect(withoutInvocationOptOut(flagged).changed).toBe(false);

    // Anchored to line start, so a mention inside prose is left alone.
    const prose = "---\nname: s\n---\n\nSet disable-model-invocation: true to hide a skill.\n";
    expect(withoutInvocationOptOut(prose).changed).toBe(false);
  });
});
