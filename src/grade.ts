/** Composes trace, trigger, regex, and registered deterministic checks for one trial. */
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { runGraders } from "./graders.js";
import type { Check, EvalCase, RuntimeArm, Trace } from "./types.js";
import { walkFiles } from "./utils.js";

// The arms that seed the target skill, so should_trigger can be graded on them.
const TARGET_PRESENT_ARMS = new Set<RuntimeArm>(["solo", "group"]);

const INJECTED_FILES = new Set(["package.json", "tsconfig.json"]);
export function gradeTrial(
  evalCase: EvalCase,
  arm: RuntimeArm,
  trace: Trace,
  workspace: string,
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

  const gradedText =
    evalCase.mode === "generation"
      ? walkFiles(workspace)
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
    checks.push({
      detail: pattern,
      name: "must_not_match",
      pass: !new RegExp(pattern, "m").test(gradedText),
    });
  }

  checks.push(...runGraders(evalCase, workspace));
  return checks;
}
