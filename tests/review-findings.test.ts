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
import {
  SKILLS_ROOT as claudeSkillsRoot,
  seedSkills as seedClaudeSkills,
} from "../src/executors/claude.js";
import { SKILLS_ROOT as codexSkillsRoot } from "../src/executors/codex.js";
import { parsePiTrace, SKILLS_ROOT as piSkillsRoot } from "../src/executors/pi.js";
import { stageSkill, withoutInvocationOptOut } from "../src/executors/seed.js";
import { ExecutorInfraError } from "../src/executors/spawn.js";
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

describe("finding 5: a staging failure is infrastructure, not a verdict", () => {
  it("raises a typed infra error when the skill directory cannot be read", () => {
    // cpSync/readdir can fail on permissions, ENOSPC, dangling links or special files - all before
    // the model runs. Copy staging introduced far more of these than symlinking did, and an
    // ordinary Error becomes a cached `run` FAIL that votes against the skill.
    let thrown: unknown;
    try {
      stageSkill(makeDir(), "s", join(tmpdir(), "skillval-no-such-skill-dir-xyz"));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ExecutorInfraError);
    expect((thrown as ExecutorInfraError).kind).toBe("staging-failed");
  });

  it("raises it for a dangling symlink inside the skill, which copy cannot resolve", () => {
    const source = makeDir();
    writeFileSync(join(source, "SKILL.md"), "# s\n");
    symlinkSync(join(tmpdir(), "skillval-missing-target-xyz"), join(source, "broken.md"));

    let thrown: unknown;
    try {
      stageSkill(makeDir(), "s", source);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ExecutorInfraError);
  });
});

describe("finding 6: only the executor's own staging root may be touched", () => {
  it("reports the root each executor actually stages into", () => {
    // The runner both EXCLUDES and DELETES staged paths. Using every known root means a codex run
    // deletes model output at .claude/skills/<name> before grading it - the create-skill case
    // authors skills under exactly that path.
    expect(claudeSkillsRoot).toBe(".claude/skills");
    expect(codexSkillsRoot).toBe(".agents/skills");
    expect(piSkillsRoot).toBe(".skillval-skills");
    expect(new Set([claudeSkillsRoot, codexSkillsRoot, piSkillsRoot]).size).toBe(3);
  });
});

describe("finding 4b: pi's agent_end is not by itself a completed turn", () => {
  const trace = (assistant: Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({
      messages: [{ content: [{ text: "hi", type: "text" }], role: "assistant", ...assistant }],
      type: "agent_end",
      ...extra,
    });

  it("treats a successful stopReason as completed", () => {
    // Verified against a live pi trace: assistant messages carry stopReason, "stop" on success.
    expect(parsePiTrace(trace({ stopReason: "stop" }), "s").completed).toBe(true);
  });

  it("does not treat an aborted or errored turn as completed", () => {
    for (const reason of ["aborted", "cancelled", "error", "refusal"]) {
      expect(parsePiTrace(trace({ stopReason: reason }), "s").completed).toBe(false);
    }
  });

  it("does not treat a turn pi intends to retry as completed", () => {
    expect(parsePiTrace(trace({ stopReason: "stop" }, { willRetry: true }), "s").completed).toBe(
      false,
    );
  });

  it("keeps grading an unfamiliar stopReason, rather than inventing an infra failure", () => {
    // Deny-list, not allow-list: a reason this code has never seen must behave as it always did.
    expect(parsePiTrace(trace({ stopReason: "length" }), "s").completed).toBe(true);
    expect(parsePiTrace(trace({}), "s").completed).toBe(true);
  });
});
