/** Computes eval-coverage statistics across discovered skills: cases classified by grader rung. */
import { basename } from "node:path";
import type { ReadyDiscoveredSkill } from "./discovery.js";
import type { EvalCase } from "./types.js";

// The grader ladder (see the skillval-coverage skill): a trigger-only case proves the skill loads,
// a regex case proves lexical presence in output, an execution case proves runtime behavior. A case
// with both regex and execution graders sits on the execution rung - its strongest evidence.
export type GraderRung = "execution" | "regex" | "trigger";

export const RUNG_ORDER: readonly GraderRung[] = ["trigger", "regex", "execution"];

export interface CaseCoverage {
  readonly baseline: boolean;
  readonly graders: readonly string[];
  readonly id: string;
  readonly mode: "generation" | "trigger";
  readonly rule: string | undefined;
  readonly rung: GraderRung;
  readonly trials: number;
  readonly type: "capability" | "preference" | undefined;
}

export interface SkillCoverage {
  readonly behavioral: number;
  readonly cases: readonly CaseCoverage[];
  readonly class: "capability" | "preference";
  readonly counts: Readonly<Record<GraderRung, number>>;
  readonly hasBaselineComparison: boolean;
  readonly hasNegativeTrigger: boolean;
  readonly name: string;
  readonly root: string;
}

export interface CoverageGroup {
  readonly caseCount: number;
  readonly label: string;
  readonly root: string;
  // Weakest coverage first: ascending behavioral share, larger suites breaking ties.
  readonly skills: readonly SkillCoverage[];
}

export interface CoverageReport {
  readonly caseCount: number;
  readonly counts: Readonly<Record<GraderRung, number>>;
  readonly groups: readonly CoverageGroup[];
  readonly skillCount: number;
  readonly skillsWithBaselineComparison: number;
  readonly skillsWithoutBehavioralCases: readonly string[];
  readonly skillsWithoutNegativeTrigger: readonly string[];
}

export function caseRung(evalCase: EvalCase): GraderRung {
  const assert = evalCase.assert;
  if (
    assert?.command_exit !== undefined ||
    assert?.json_schema !== undefined ||
    (assert?.graders?.length ?? 0) > 0
  ) {
    return "execution";
  }
  if ((assert?.must_match?.length ?? 0) > 0 || (assert?.must_not_match?.length ?? 0) > 0) {
    return "regex";
  }
  return "trigger";
}

// Human-readable grader labels for one case, in ladder order (weakest first).
export function caseGraderLabels(evalCase: EvalCase): readonly string[] {
  const labels: string[] = [];
  if (evalCase.should_trigger !== undefined) {
    labels.push(`should_trigger: ${evalCase.should_trigger}`);
  }
  const assert = evalCase.assert;
  const matches = assert?.must_match?.length ?? 0;
  if (matches > 0) labels.push(matches === 1 ? "must_match" : `must_match x${matches}`);
  const rejections = assert?.must_not_match?.length ?? 0;
  if (rejections > 0) {
    labels.push(rejections === 1 ? "must_not_match" : `must_not_match x${rejections}`);
  }
  if (assert?.json_schema !== undefined) labels.push("json_schema");
  if (assert?.command_exit !== undefined) labels.push("command_exit");
  for (const grader of assert?.graders ?? []) labels.push(grader);
  return labels;
}

function skillCoverage(skill: ReadyDiscoveredSkill): SkillCoverage {
  const cases = skill.evals.cases.map((evalCase): CaseCoverage => {
    const arms = evalCase.arms ?? ["solo"];
    return {
      baseline: arms.includes("baseline"),
      graders: caseGraderLabels(evalCase),
      id: evalCase.id,
      mode: evalCase.mode,
      rule: evalCase.rule,
      rung: caseRung(evalCase),
      trials: evalCase.trials ?? 1,
      type: evalCase.type,
    };
  });
  const counts = { execution: 0, regex: 0, trigger: 0 };
  for (const item of cases) counts[item.rung] += 1;
  return {
    behavioral: counts.regex + counts.execution,
    cases,
    class: skill.evals.class,
    counts,
    hasBaselineComparison: cases.some((item) => item.baseline && item.rung !== "trigger"),
    hasNegativeTrigger: skill.evals.cases.some((evalCase) => evalCase.should_trigger === false),
    name: skill.name,
    root: skill.root,
  };
}

export function computeCoverage(skills: readonly ReadyDiscoveredSkill[]): CoverageReport {
  const all = skills.map(skillCoverage);
  const byRoot = new Map<string, SkillCoverage[]>();
  for (const skill of all) {
    const members = byRoot.get(skill.root) ?? [];
    members.push(skill);
    byRoot.set(skill.root, members);
  }
  const groups = [...byRoot.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([root, members]): CoverageGroup => ({
        caseCount: members.reduce((sum, skill) => sum + skill.cases.length, 0),
        label: basename(root),
        root,
        skills: [...members].sort((left, right) => {
          const leftShare = left.behavioral / Math.max(1, left.cases.length);
          const rightShare = right.behavioral / Math.max(1, right.cases.length);
          if (leftShare !== rightShare) return leftShare - rightShare;
          if (left.cases.length !== right.cases.length) {
            return right.cases.length - left.cases.length;
          }
          return left.name.localeCompare(right.name);
        }),
      }),
    );
  const counts = { execution: 0, regex: 0, trigger: 0 };
  for (const skill of all) {
    counts.execution += skill.counts.execution;
    counts.regex += skill.counts.regex;
    counts.trigger += skill.counts.trigger;
  }
  return {
    caseCount: all.reduce((sum, skill) => sum + skill.cases.length, 0),
    counts,
    groups,
    skillCount: all.length,
    skillsWithBaselineComparison: all.filter((skill) => skill.hasBaselineComparison).length,
    skillsWithoutBehavioralCases: all
      .filter((skill) => skill.behavioral === 0)
      .map((skill) => skill.name)
      .sort(),
    skillsWithoutNegativeTrigger: all
      .filter((skill) => !skill.hasNegativeTrigger)
      .map((skill) => skill.name)
      .sort(),
  };
}
