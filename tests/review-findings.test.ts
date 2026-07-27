/**
 * Runtime reproductions for the findings of the 2026-07-27 independent review.
 *
 * Each test here first FAILED against the code as merged, which is what proved the finding was
 * real rather than a static-analysis guess. They stay as regression pins.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seedSkills as seedClaudeSkills } from "../src/executors/claude.js";
import { withoutInvocationOptOut } from "../src/executors/seed.js";
import { pathContains, skillContentHash } from "../src/utils.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});
const makeDir = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "skillval-review-"));
  directories.push(directory);
  return directory;
};

describe("finding 8: the invocation opt-out must be read as YAML, not matched as text", () => {
  it("strips the opt-out however its boolean is spelled", () => {
    // Nothing here compiles case-insensitively, and YAML accepts True/TRUE as booleans. A
    // capitalised value left the flag in place, so Claude kept withholding the skill and the arm
    // stayed unfalsifiable - the exact failure the strip exists to prevent, silently.
    for (const value of ["true", "True", "TRUE"]) {
      const source = `---\nname: s\ndisable-model-invocation: ${value}\n---\n\nbody\n`;
      expect(withoutInvocationOptOut(source).changed).toBe(true);
    }
  });

  it("strips it when a trailing comment follows the value", () => {
    const source = "---\nname: s\ndisable-model-invocation: true # manual only\n---\n\nbody\n";
    expect(withoutInvocationOptOut(source).changed).toBe(true);
  });

  it("leaves a false value alone", () => {
    const source = "---\nname: s\ndisable-model-invocation: false\n---\n\nbody\n";
    expect(withoutInvocationOptOut(source).changed).toBe(false);
  });

  it("never edits an occurrence in the body", () => {
    // Column-zero inside a fenced example is documentation, not frontmatter; rewriting it changes
    // what the skill teaches.
    const source = "---\nname: s\n---\n\n```yaml\ndisable-model-invocation: true\n```\n";
    expect(withoutInvocationOptOut(source).changed).toBe(false);
  });
});

describe("finding 2: staging and cache identity must agree on what a skill contains", () => {
  it("never stages what the content hash ignores", () => {
    // skillContentHash skips .git and node_modules; stageSkill copied them. Content the model can
    // see but the cache key cannot is a stale-verdict bug, and an unbounded node_modules also makes
    // every trial a large recursive copy.
    const source = makeDir();
    writeFileSync(join(source, "SKILL.md"), "# s\n");
    const before = skillContentHash(source);

    mkdirSync(join(source, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(source, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
    mkdirSync(join(source, ".git"), { recursive: true });
    writeFileSync(join(source, ".git", "HEAD"), "ref: refs/heads/main\n");
    expect(skillContentHash(source)).toBe(before);

    const workspace = makeDir();
    seedClaudeSkills(workspace, [{ directory: source, name: "s" }]);
    const staged = join(workspace, ".claude/skills/s");
    expect(existsSync(join(staged, "node_modules"))).toBe(false);
    expect(existsSync(join(staged, ".git"))).toBe(false);
  });

  it("stages a symlinked child as real content, which the hash also counts", () => {
    const source = makeDir();
    const external = makeDir();
    writeFileSync(join(source, "SKILL.md"), "# s\n");
    writeFileSync(join(external, "shared.md"), "# shared\n");
    symlinkSync(join(external, "shared.md"), join(source, "shared.md"));

    const workspace = makeDir();
    seedClaudeSkills(workspace, [{ directory: source, name: "s" }]);
    expect(existsSync(join(workspace, ".claude/skills/s", "shared.md"))).toBe(true);
  });
});

describe("finding 7: staged-path containment must not be POSIX-only", () => {
  it("recognises a Windows-shaped staged path as containing its child", () => {
    // `file.startsWith(seeded + "/")` never matches a backslash path, so on Windows every staged
    // file stays in the graded text and the v20 grading leak returns silently.
    const seeded = String.raw`C:\tmp\ws\.claude\skills\s`;
    expect(pathContains(seeded, String.raw`C:\tmp\ws\.claude\skills\s\SKILL.md`)).toBe(true);
    expect(pathContains(seeded, String.raw`C:\tmp\ws\.claude\skills\s-other\SKILL.md`)).toBe(false);
  });

  it("still works for POSIX paths and rejects a lookalike sibling", () => {
    const seeded = "/tmp/ws/.claude/skills/s";
    expect(pathContains(seeded, "/tmp/ws/.claude/skills/s/SKILL.md")).toBe(true);
    expect(pathContains(seeded, "/tmp/ws/.claude/skills/s-other/SKILL.md")).toBe(false);
    expect(pathContains(seeded, seeded)).toBe(false);
  });
});
