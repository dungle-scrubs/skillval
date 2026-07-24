import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync } from "node:fs";
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
