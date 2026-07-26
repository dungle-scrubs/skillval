import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  seedInstruction as seedClaudeInstruction,
  seedSkills as seedClaudeSkills,
} from "../src/executors/claude.js";
import {
  seedInstruction as seedCodexInstruction,
  seedSkills as seedCodexSkills,
} from "../src/executors/codex.js";
import { piSkillArgs, seedInstruction as seedPiInstruction } from "../src/executors/pi.js";

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
  it("stages every seeded skill into the skills root, contents linked to the real files", () => {
    const workspace = makeDir();
    const skillA = makeDir();
    const skillB = makeDir();
    writeFileSync(join(skillA, "SKILL.md"), "# alpha\n");
    writeFileSync(join(skillB, "SKILL.md"), "# beta\n");

    seedSkills(workspace, [
      { directory: skillA, name: "alpha" },
      { directory: skillB, name: "beta" },
    ]);

    // The seeded entry is a staged directory, not a link to the skill itself: linking the skill
    // wholesale would carry its eval definition into the arm being graded.
    const root = join(workspace, skillsSubdir);
    expect(lstatSync(join(root, "alpha")).isDirectory()).toBe(true);
    expect(readlinkSync(join(root, "alpha", "SKILL.md"))).toBe(join(skillA, "SKILL.md"));
    expect(readlinkSync(join(root, "beta", "SKILL.md"))).toBe(join(skillB, "SKILL.md"));
  });

  it("never carries the eval definition into a seeded arm", () => {
    const workspace = makeDir();
    const skill = makeDir();
    writeFileSync(join(skill, "SKILL.md"), "# skill\n");
    writeFileSync(join(skill, "skillval.yml"), "cases: [{ assert: { must_match: ['answer'] } }]\n");

    seedSkills(workspace, [{ directory: skill, name: "alpha" }]);

    expect(readdirSync(join(workspace, skillsSubdir, "alpha"))).toEqual(["SKILL.md"]);
  });

  it("seeds nothing for an empty list (the baseline arm)", () => {
    const workspace = makeDir();

    seedSkills(workspace, []);

    expect(existsSync(join(workspace, skillsSubdir))).toBe(false);
  });
});

describe.each([
  ["codex", seedCodexInstruction],
  ["pi", seedPiInstruction],
  ["claude", seedClaudeInstruction],
])("%s seedInstruction", (_name, seedInstruction) => {
  it("writes the resolved content under the filename the runner resolved", () => {
    const workspace = makeDir();

    seedInstruction(workspace, {
      content: "- Keep answers concise.\n",
      filename: "AGENTS.md",
    });

    expect(readFileSync(join(workspace, "AGENTS.md"), "utf8")).toBe("- Keep answers concise.\n");
  });

  it("honours a CLAUDE.md filename without translating it", () => {
    const workspace = makeDir();

    seedInstruction(workspace, { content: "- Be terse.\n", filename: "CLAUDE.md" });

    expect(readFileSync(join(workspace, "CLAUDE.md"), "utf8")).toBe("- Be terse.\n");
    expect(existsSync(join(workspace, "AGENTS.md"))).toBe(false);
  });

  it("seeds nothing for a skill-target trial", () => {
    const workspace = makeDir();

    seedInstruction(workspace, undefined);

    expect(existsSync(join(workspace, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(workspace, "CLAUDE.md"))).toBe(false);
  });
});

describe("piSkillArgs", () => {
  it("hides globals and emits a repeatable --skill for each seeded skill", () => {
    expect(
      piSkillArgs([
        { directory: "/skills/alpha", name: "alpha" },
        { directory: "/skills/beta", name: "beta" },
      ]),
    ).toEqual(["--no-skills", "--skill", "/skills/alpha", "--skill", "/skills/beta"]);
  });

  it("hides all skills with --no-skills for the empty (baseline) arm", () => {
    expect(piSkillArgs([])).toEqual(["--no-skills"]);
  });
});
