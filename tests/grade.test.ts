import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gradeTrial } from "../src/grade.js";
import type { EvalCase, Trace } from "../src/types.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

const trace = (agentText: string): Trace => ({
  agentText,
  completed: true,
  invocationEvidence: null,
  invoked: false,
  usage: null,
});

const triggerCase = (mustNotMatch: readonly string[]): EvalCase =>
  ({
    assert: { must_not_match: mustNotMatch },
    id: "case",
    mode: "trigger",
    prompt: "prompt",
  }) as EvalCase;

describe("must_not_match diagnostics", () => {
  it("reports what matched and the text around it, not just the pattern", () => {
    // Without the surrounding clause a reader cannot tell a real violation ("this is overkill")
    // from a correct answer that merely contains the banned word ("not overkill here") - the defect
    // class where a trap fires on correct output, which is invisible when only the pattern is shown.
    const checks = gradeTrial(
      triggerCase([String.raw`\boverkill\b`]),
      "solo",
      trace("Effect is not overkill here; adopt it for this codebase."),
      "/tmp",
    );

    const check = checks.find((candidate) => candidate.name === "must_not_match");
    expect(check?.pass).toBe(false);
    expect(check?.detail).toContain('matched "overkill"');
    expect(check?.detail).toContain("not overkill here");
  });

  it("collapses whitespace so a multi-line hit stays one readable line", () => {
    const checks = gradeTrial(
      triggerCase(["banned"]),
      "solo",
      trace("prose\n\n   banned\n\ttoken   here"),
      "/tmp",
    );

    expect(checks.find((candidate) => candidate.name === "must_not_match")?.detail).toContain(
      "prose banned token here",
    );
  });

  it("reports the bare pattern when the rule passes", () => {
    const checks = gradeTrial(triggerCase(["nope"]), "solo", trace("clean answer"), "/tmp");

    const check = checks.find((candidate) => candidate.name === "must_not_match");
    expect(check?.pass).toBe(true);
    expect(check?.detail).toBe("nope");
  });
});

describe("seeded skills are never graded as model output", () => {
  const generationCase = (mustNotMatch: readonly string[]): EvalCase =>
    ({
      assert: { must_not_match: mustNotMatch },
      id: "case",
      mode: "generation",
      prompt: "prompt",
    }) as EvalCase;

  it("excludes a staged skill from the graded text", () => {
    // Staged skills are COPIED into the workspace (codex cannot see a symlinked SKILL.md), so
    // walkFiles finds them. Observed live: a Tailwind case banning "tailwind.config" matched the
    // skill's own sentence saying configuration does NOT live there - the trap fired on skillval's
    // input, not the model's output, and reported a failure the model never earned.
    const workspace = mkdtempSync(join(tmpdir(), "skillval-grade-"));
    directories.push(workspace);
    const staged = join(workspace, ".claude/skills/standards-css");
    mkdirSync(staged, { recursive: true });
    writeFileSync(
      join(staged, "SKILL.md"),
      "Configuration lives in CSS, not `tailwind.config.js`.\n",
    );
    writeFileSync(join(workspace, "index.css"), '@import "tailwindcss";\n');

    const banned = gradeTrial(
      generationCase([String.raw`tailwind\.config`]),
      "solo",
      trace(""),
      workspace,
      [staged],
    );
    expect(banned.find((check) => check.name === "must_not_match")?.pass).toBe(true);

    // Without the exclusion the same workspace fails, which is the bug this pins.
    const unfiltered = gradeTrial(
      generationCase([String.raw`tailwind\.config`]),
      "solo",
      trace(""),
      workspace,
      [],
    );
    expect(unfiltered.find((check) => check.name === "must_not_match")?.pass).toBe(false);
  });
});
