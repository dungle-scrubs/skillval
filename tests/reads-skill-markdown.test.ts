import { describe, expect, it } from "vitest";
import { readsSkillMarkdown } from "../src/utils.js";

describe("readsSkillMarkdown", () => {
  it("matches the skill as a whole path segment after a slash", () => {
    expect(readsSkillMarkdown("cat .agents/skills/orient/SKILL.md", "orient")).toBe(true);
    expect(readsSkillMarkdown('read "/home/u/skills/orient/SKILL.md"', "orient")).toBe(true);
  });

  it("matches a relative read at the start of a path or after a space", () => {
    expect(readsSkillMarkdown("cat orient/SKILL.md", "orient")).toBe(true);
    expect(readsSkillMarkdown("cd skills && cat orient/SKILL.md", "orient")).toBe(true);
    expect(readsSkillMarkdown("orient/SKILL.md", "orient")).toBe(true);
  });

  it("does not match a peer whose name merely contains the target name", () => {
    expect(readsSkillMarkdown("cat .agents/skills/commit-orient/SKILL.md", "orient")).toBe(false);
    expect(readsSkillMarkdown("cat orient-extra/SKILL.md", "orient")).toBe(false);
  });

  it("does not match unrelated commands", () => {
    expect(readsSkillMarkdown("ls -la", "orient")).toBe(false);
    expect(readsSkillMarkdown("cat orient/other.md", "orient")).toBe(false);
  });

  it("treats regex metacharacters in a skill name literally", () => {
    expect(readsSkillMarkdown("cat skills/a.b/SKILL.md", "a.b")).toBe(true);
    expect(readsSkillMarkdown("cat skills/axb/SKILL.md", "a.b")).toBe(false);
  });
});
