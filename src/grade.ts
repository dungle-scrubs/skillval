/** Composes trace, trigger, regex, and registered deterministic checks for one trial. */
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { runGraders } from "./graders.js";
import type { Check, EvalCase, RuntimeArm, Trace } from "./types.js";
import { pathContains, walkFiles } from "./utils.js";

// The arms that seed the target skill, so should_trigger can be graded on them.
const TARGET_PRESENT_ARMS = new Set<RuntimeArm>(["solo", "group"]);

const INJECTED_FILES = new Set(["package.json", "tsconfig.json"]);
// How much text to show either side of a banned match, so a reader can tell a violation from a
// correct answer that merely contains the word. Wide enough for a clause, short enough for a log.
const MATCH_CONTEXT_CHARS = 90;

// Renders a must_not_match hit as the matched text plus its surrounding clause.
function matchContext(text: string, match: RegExpExecArray): string {
  const start = Math.max(0, match.index - MATCH_CONTEXT_CHARS);
  const end = Math.min(text.length, match.index + match[0].length + MATCH_CONTEXT_CHARS);
  const lead = start > 0 ? "..." : "";
  const tail = end < text.length ? "..." : "";
  return `${JSON.stringify(match[0])} in: ${lead}${text.slice(start, end).replace(/\s+/g, " ")}${tail}`;
}

export function gradeTrial(
  evalCase: EvalCase,
  arm: RuntimeArm,
  trace: Trace,
  workspace: string,
  // Absolute paths of the skill directories skillval staged into this workspace. Excluded from the
  // graded text: they are skillval's own input, not the model's output.
  seededPaths: readonly string[] = [],
): Check[] {
  const checks: Check[] = [];

  checks.push({
    detail: trace.completed ? "turn.completed seen" : "no turn.completed in trace",
    name: "trace",
    pass: trace.completed,
  });

  // should_trigger asks whether the target skill activated, so it grades only on arms that seed the
  // target (solo, group) - never on baseline or peers, where the target is absent by design.
  if (evalCase.should_trigger !== undefined && TARGET_PRESENT_ARMS.has(arm)) {
    const evidence = trace.invocationEvidence === null ? "none" : trace.invocationEvidence;
    checks.push({
      detail: `invoked=${trace.invoked}, expected=${evalCase.should_trigger}, evidence=${evidence}`,
      name: "trigger",
      pass: trace.invoked === evalCase.should_trigger,
    });
  }

  // A staged skill is now COPIED into the workspace (codex cannot see a symlinked SKILL.md), so
  // walkFiles finds its text and generation mode would grade the skill as if the model had written
  // it. That is a false verdict in both directions: a must_not_match trap fires on the skill's own
  // prose (observed: a Tailwind case banning "tailwind.config" matched the skill's sentence saying
  // configuration does NOT live there), and a must_match can pass on text the model never produced.
  const gradedText =
    evalCase.mode === "generation"
      ? walkFiles(workspace)
          .filter((file) => !seededPaths.some((seeded) => pathContains(seeded, file)))
          .filter((file) => !INJECTED_FILES.has(relative(workspace, file)))
          .map((file) => `=== ${relative(workspace, file)} ===\n${readFileSync(file, "utf8")}`)
          .join("\n")
      : trace.agentText;

  for (const pattern of evalCase.assert?.must_match ?? []) {
    const pass = new RegExp(pattern, "m").test(gradedText);
    checks.push({
      detail: pass ? pattern : `${pattern} | got: ${gradedText.slice(0, 400)}`,
      name: "must_match",
      pass,
    });
  }
  for (const pattern of evalCase.assert?.must_not_match ?? []) {
    const match = new RegExp(pattern, "m").exec(gradedText);
    checks.push({
      // A failure names WHAT matched and the text around it, never the pattern alone. The pattern
      // cannot distinguish a real violation ("this is overkill") from a correct answer that happens
      // to contain the banned word ("not overkill here") - and a trap that fires on correct output
      // is a whole defect class that stays invisible without the surrounding context.
      detail: match === null ? pattern : `${pattern} | matched ${matchContext(gradedText, match)}`,
      name: "must_not_match",
      pass: match === null,
    });
  }

  checks.push(...runGraders(evalCase, workspace));
  return checks;
}
