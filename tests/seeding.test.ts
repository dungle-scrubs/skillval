import { existsSync, lstatSync, mkdtempSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seedSkills as seedClaudeSkills } from "../src/executors/claude.js";
import { seedSkills as seedCodexSkills } from "../src/executors/codex.js";
import { piSkillArgs } from "../src/executors/pi.js";

const directories: string[] = [];
const makeDir = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "skillval-seed-"));
  directories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe.each([
  ["codex", seedCodexSkills, ".agents/skills"],
  ["claude", seedClaudeSkills, ".claude/skills"],
])("%s seedSkills", (_name, seedSkills, skillsSubdir) => {
  it("symlinks every seeded skill into the skills root", () => {
    const workspace = makeDir();
    const skillA = makeDir();
    const skillB = makeDir();

    seedSkills(workspace, [
      { directory: skillA, name: "alpha" },
      { directory: skillB, name: "beta" },
    ]);

    const root = join(workspace, skillsSubdir);
    expect(lstatSync(join(root, "alpha")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(root, "alpha"))).toBe(skillA);
    expect(readlinkSync(join(root, "beta"))).toBe(skillB);
  });

  it("seeds nothing for an empty list (the baseline arm)", () => {
    const workspace = makeDir();

    seedSkills(workspace, []);

    expect(existsSync(join(workspace, skillsSubdir))).toBe(false);
  });
});

describe("piSkillArgs", () => {
  it("emits a repeatable --skill for each seeded skill", () => {
    expect(
      piSkillArgs([
        { directory: "/skills/alpha", name: "alpha" },
        { directory: "/skills/beta", name: "beta" },
      ]),
    ).toEqual(["--skill", "/skills/alpha", "--skill", "/skills/beta"]);
  });

  it("hides skills with --no-skills for the empty (baseline) arm", () => {
    expect(piSkillArgs([])).toEqual(["--no-skills"]);
  });
});
