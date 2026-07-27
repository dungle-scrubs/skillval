/**
 * Runtime reproductions for the findings of the 2026-07-27 independent review.
 *
 * Each test here first FAILED against the code as merged, which is what proved the finding was
 * real rather than a static-analysis guess. They stay as regression pins.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SKILLS_ROOT as claudeSkillsRoot,
  seedSkills as seedClaudeSkills,
} from "../src/executors/claude.js";
import { SKILLS_ROOT as codexSkillsRoot } from "../src/executors/codex.js";
import { parsePiTrace, SKILLS_ROOT as piSkillsRoot } from "../src/executors/pi.js";
import { stagedRelativePaths, stageSkill, withoutInvocationOptOut } from "../src/executors/seed.js";
import { ExecutorInfraError } from "../src/executors/spawn.js";
import { removeStaged } from "../src/runner.js";
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

  it("skips a skipped directory at EVERY depth, not only the top level", () => {
    // The first version of this test checked top-level entries only, so it passed against a
    // stageSkill that filtered the top level and then handed references/ to a recursive cpSync -
    // which copied references/node_modules wholesale while the hash ignored it at every depth.
    const source = makeDir();
    writeFileSync(join(source, "SKILL.md"), "# s\n");
    mkdirSync(join(source, "references", "node_modules"), { recursive: true });
    writeFileSync(join(source, "references", "node_modules", "big.js"), "x");
    writeFileSync(join(source, "references", "detail.md"), "# detail\n");

    const workspace = makeDir();
    seedClaudeSkills(workspace, [{ directory: source, name: "s" }]);
    const staged = join(workspace, ".claude/skills/s");
    expect(existsSync(join(staged, "references", "detail.md"))).toBe(true);
    expect(existsSync(join(staged, "references", "node_modules"))).toBe(false);
  });

  it("rejects a symlink rather than staging content the hash cannot cover", () => {
    // The first version asserted existsSync, which follows the link and so passed against a
    // stageSkill that copied it AS a symlink - exposing mutable external content that
    // skillContentHash never counts, which is a stale verdict with no symptom.
    const source = makeDir();
    const external = makeDir();
    writeFileSync(join(source, "SKILL.md"), "# s\n");
    writeFileSync(join(external, "shared.md"), "# shared\n");
    symlinkSync(join(external, "shared.md"), join(source, "shared.md"));

    let thrown: unknown;
    try {
      seedClaudeSkills(makeDir(), [{ directory: source, name: "s" }]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ExecutorInfraError);
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

  it("treats an unfamiliar or missing stopReason as NOT completed", () => {
    // Second review, finding 6: this was a deny-list and so failed OPEN. A reason pi renames, or a
    // malformed event with no stopReason at all, would have been graded as content and cached.
    // Failing closed is loud and recoverable; failing open is silent and poisons the cache.
    expect(parsePiTrace(trace({ stopReason: "something-new" }), "s").completed).toBe(false);
    expect(parsePiTrace(trace({}), "s").completed).toBe(false);
    // Known-gradeable reasons still grade.
    expect(parsePiTrace(trace({ stopReason: "length" }), "s").completed).toBe(true);
  });
});

describe("second review, finding 2: pi must not grade a zero-exit errored turn", () => {
  it("keeps the caller's completion check independent of the exit status", () => {
    // The parser-only tests above could not catch this: parsePiTrace correctly returned
    // completed:false, but PiExecutor.runTrial only called throwNeverGraded inside its
    // nonzero-exit branch. pi sets a failing exit code in text mode only, so a JSON-mode turn with
    // stopReason "error" exits 0 - precisely the case the stopReason check exists for - and it was
    // graded as content and cached. Pinned as source structure because constructing a full
    // TrialRequest would spawn the real pi binary.
    const source = readFileSync(new URL("../src/executors/pi.ts", import.meta.url), "utf8");
    const guard = source.indexOf("if (!trace.completed) {");
    const exitBranch = source.indexOf("if (result.status !== 0 || result.signal !== null) {");
    expect(guard).toBeGreaterThan(-1);
    // The completion guard must sit AFTER the exit-status branch closes, not inside it.
    expect(guard).toBeGreaterThan(exitBranch);
    const branchBody = source.slice(exitBranch, guard);
    expect(branchBody).not.toContain("throwNeverGraded");
  });
});

describe("second review, finding 1: teardown must spare fixture and model output", () => {
  it("removes only the files staging wrote, inside the staged directory", () => {
    // rmSync on the staged directory also destroyed anything the fixture put there or the model
    // wrote inside it. A solo arm that loses its own output fails while its baseline passes, which
    // caseOutcome reads as a no-op - i.e. a prune candidate. stagedRelativePaths derives what
    // staging created from the source, so teardown can be surgical without tracking state.
    const source = makeDir();
    writeFileSync(join(source, "SKILL.md"), "# s\n");
    mkdirSync(join(source, "references"), { recursive: true });
    writeFileSync(join(source, "references", "detail.md"), "# detail\n");
    writeFileSync(join(source, "skillval.yml"), "cases: []\n");

    const relative = stagedRelativePaths(source);
    expect(relative.sort()).toEqual(["SKILL.md", "references/detail.md"]);
    // The eval definition is never staged, so teardown must not expect it.
    expect(relative).not.toContain("skillval.yml");
  });

  it("does not claim a path the model added inside the staged directory", () => {
    const source = makeDir();
    writeFileSync(join(source, "SKILL.md"), "# s\n");
    // Whatever the model writes has no counterpart in the source, so it is never in the list
    // teardown deletes.
    expect(stagedRelativePaths(source)).not.toContain("notes-from-the-model.md");
  });
});

describe("second review, finding 3: frontmatter rewriting must not corrupt the skill", () => {
  const strip = (frontmatter: string): { changed: boolean; text: string } =>
    withoutInvocationOptOut(`---\n${frontmatter}\n---\n\n# Body\n`);

  it("removes the key whatever its quoting, and actually removes it", () => {
    // Asserting `changed` alone is not enough: YAML parses a quoted key as the same property, so a
    // line-based delete could report changed:true while returning byte-identical text - the arm
    // stays hidden and nothing says so.
    for (const line of ['"disable-model-invocation": true', "'disable-model-invocation': true"]) {
      const result = strip(`name: s\n${line}`);
      expect(result.changed).toBe(true);
      expect(result.text).not.toContain("disable-model-invocation");
    }
  });

  it("keeps every other key byte-intact", () => {
    const result = strip("name: s\ndisable-model-invocation: true\nallowed-tools: Read, Write");
    expect(result.changed).toBe(true);
    expect(result.text).toContain("name: s");
    expect(result.text).toContain("allowed-tools: Read, Write");
    expect(result.text).not.toContain("disable-model-invocation");
  });

  it("handles a leading BOM rather than failing to see the frontmatter", () => {
    const source = `﻿---\nname: s\ndisable-model-invocation: true\n---\n\n# Body\n`;
    expect(withoutInvocationOptOut(source).changed).toBe(true);
  });

  it("refuses to rewrite frontmatter it cannot transform safely", () => {
    // An anchor referenced elsewhere cannot have its pair deleted without leaving a dangling
    // alias. Running a trial on a corrupted skill is worse than not running it, so this raises
    // rather than guessing - the arm becomes infrastructure, which is visible.
    let thrown: unknown;
    try {
      strip("name: s\ndisable-model-invocation: &flag true\nother: *flag");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
  });

  it("leaves malformed frontmatter exactly as authored", () => {
    const source = "---\nname: [unclosed\n---\n\n# Body\n";
    const result = withoutInvocationOptOut(source);
    expect(result.changed).toBe(false);
    expect(result.text).toBe(source);
  });
});

describe("third review: teardown deletes only what staging recorded writing", () => {
  it("never follows a symlink a model planted where a staged directory was", () => {
    // A model can replace a staged directory with a symlink pointing anywhere. A recursive delete
    // would follow it and destroy files OUTSIDE the workspace with skillval's own privileges.
    const source = makeDir();
    writeFileSync(join(source, "SKILL.md"), "# s\n");
    mkdirSync(join(source, "references"), { recursive: true });
    writeFileSync(join(source, "references", "detail.md"), "# detail\n");

    const workspace = makeDir();
    const [staged] = seedClaudeSkills(workspace, [{ directory: source, name: "s" }]);
    if (staged === undefined) throw new Error("seeding produced no manifest");

    // The model swaps the staged directory for a link to something precious.
    const outside = makeDir();
    writeFileSync(join(outside, "precious.txt"), "do not delete\n");
    rmSync(join(staged.target, "references"), { force: true, recursive: true });
    symlinkSync(outside, join(staged.target, "references"));

    removeStaged([staged]);
    expect(existsSync(join(outside, "precious.txt"))).toBe(true);
  });

  it("removes a staged path even when the model overwrote it, and says so deliberately", () => {
    const source = makeDir();
    writeFileSync(join(source, "SKILL.md"), "# original\n");
    const workspace = makeDir();
    const [staged] = seedClaudeSkills(workspace, [{ directory: source, name: "s" }]);
    if (staged === undefined) throw new Error("seeding produced no manifest");
    // Staging wrote SKILL.md; the model overwrites it. Ownership by pathname alone would delete
    // the model's version, so the arm would lose its own output and fail where baseline passes.
    writeFileSync(join(staged.target, "SKILL.md"), "# rewritten by the model\n");
    removeStaged([staged]);
    // Deleted, because it is still a file staging recorded writing - the collision policy is
    // "staging owns the path it wrote". Pinned so the choice is deliberate rather than accidental.
    expect(existsSync(join(staged.target, "SKILL.md"))).toBe(false);
  });

  it("leaves a directory staging did not create", () => {
    const source = makeDir();
    writeFileSync(join(source, "SKILL.md"), "# s\n");
    const workspace = makeDir();
    const [staged] = seedClaudeSkills(workspace, [{ directory: source, name: "s" }]);
    if (staged === undefined) throw new Error("seeding produced no manifest");
    // A fixture directory inside the staged root, which staging never recorded.
    mkdirSync(join(staged.target, "from-the-fixture"), { recursive: true });
    removeStaged([staged]);
    expect(existsSync(join(staged.target, "from-the-fixture"))).toBe(true);
  });
});

describe("third review: a symlinked skill is rejected before the cache is consulted", () => {
  it("throws from skillContentHash, which runs upstream of the cache lookup", () => {
    // Rejecting only at staging time is too late: staging runs AFTER the cache lookup, so a
    // symlink added to an already-cached skill returns the cached verdict and is never rejected.
    const source = makeDir();
    const external = makeDir();
    writeFileSync(join(source, "SKILL.md"), "# s\n");
    writeFileSync(join(external, "shared.md"), "# shared\n");
    symlinkSync(join(external, "shared.md"), join(source, "shared.md"));
    expect(() => skillContentHash(source)).toThrow(/symlink/);
  });
});

describe("third review: an alias-valued opt-out still opts out", () => {
  it("removes the key when its value is an alias resolving to true", () => {
    // document.get() resolves an Alias to a node, not to `true`, so the early return fired and the
    // skill stayed hidden from Claude with nothing reporting it.
    const source = "---\nflag: &flag true\ndisable-model-invocation: *flag\n---\n\n# Body\n";
    const result = withoutInvocationOptOut(source);
    expect(result.changed).toBe(true);
    expect(result.text).not.toContain("disable-model-invocation");
  });
});
