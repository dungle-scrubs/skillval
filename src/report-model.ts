/**
 * Pure derivation logic shared by the report UI and node-side tests: which action a skill case
 * earns, the teaching sentence explaining why (as structured segments so the UI can render terms
 * as rich popovers), and which checks are the evidence behind the verdict.
 */

import type { TermKey } from "./report-terms.js";
import type { InstructionAction } from "./runner.js";
import type { ArmResult, CaseResult, Check, RuntimeArm } from "./types.js";
import { armState } from "./verdict.js";

export type SkillCaseAction =
  | "investigate"
  | "keep"
  | "ok"
  | "prune-candidate"
  | "rerun"
  | "review";

export const SKILL_ACTION_LABEL: Readonly<Record<SkillCaseAction, string>> = {
  investigate: "Investigate",
  keep: "Keep",
  ok: "OK",
  "prune-candidate": "Prune candidate",
  rerun: "Rerun",
  review: "Review",
};

// Card order: graded failures first (they may be mis-keyed asserts), then ungraded reruns, then
// prune candidates, then loadout reviews.
export const CARDED_ACTIONS: readonly SkillCaseAction[] = [
  "investigate",
  "rerun",
  "prune-candidate",
  "review",
];

// Deliberately NOT the instructionAction mapping: an instruction rule is a deletable line, so
// prune and redundant both map to "delete" there. A skill is not deletable from a run report -
// its no-op maps to prune-candidate (surface, verify cross-model, then decide) and redundancy to
// review (a consolidation question about the loadout, not this skill's existence).
export function skillCaseAction(result: CaseResult): SkillCaseAction {
  if (result.loadout !== undefined) {
    switch (result.loadout.verdict) {
      case "load-bearing":
        return "keep";
      case "prune":
        return "prune-candidate";
      case "redundant":
        return "review";
      case "interference":
        return "review";
      case "inconclusive":
        return result.inconclusive ? "rerun" : "investigate";
    }
  }
  if (result.inconclusive) return "rerun";
  if (!result.pass) return "investigate";
  if (result.noop) return "prune-candidate";
  const baseline = result.arms.find((arm) => arm.arm === "baseline");
  if (baseline !== undefined && armState(baseline) === "fail") return "keep";
  return "ok";
}

// One piece of a teaching sentence: plain text, or a glossary term the UI renders as a popover.
export type ReasonSegment =
  | { readonly kind: "term"; readonly term: TermKey; readonly text?: string }
  | { readonly kind: "text"; readonly text: string };

const text = (value: string): ReasonSegment => ({ kind: "text", text: value });
const term = (key: TermKey, display?: string): ReasonSegment =>
  display === undefined ? { kind: "term", term: key } : { kind: "term", term: key, text: display };

// The reason sentence teaches the causal chain behind the action; every load-bearing word is a
// term segment so the UI can open its definition in place.
export function skillCaseReason(result: CaseResult): readonly ReasonSegment[] {
  const action = skillCaseAction(result);
  if (action === "rerun") {
    return [
      text("Every "),
      term("trial"),
      text(" of the deciding "),
      term("arm"),
      text(" hit an infrastructure failure (output overflow or timeout), leaving the case "),
      term("inconclusive"),
      text(". Nothing was graded or cached - rerun to grade fresh."),
    ];
  }
  if (action === "prune-candidate") {
    return result.loadout === undefined
      ? [
          text("Both arms passed: "),
          term("baseline"),
          text(" produced the behavior without the skill - a "),
          term("no-op"),
          text(" on this model. Verify on a second model before pruning."),
        ]
      : [
          term("peers"),
          text(" passed without this skill - a "),
          term("no-op"),
          text(" within this loadout."),
        ];
  }
  if (action === "review") {
    return result.loadout?.verdict === "interference"
      ? [
          text("Works alone but the loadout breaks it - "),
          term("interference"),
          text(" between this skill and the rest of the loadout."),
        ]
      : [
          term("peers"),
          text(" already produce this behavior - this skill is "),
          term("redundant"),
          text(" within the loadout."),
        ];
  }
  if (result.loadout === undefined && !result.pass && result.noop) {
    return [
      term("solo"),
      text(" failed while "),
      term("baseline"),
      text(
        " passed. Read the evidence: either the assert is mis-keyed for what the model actually wrote (see the got: snippet) or the skill is hurting.",
      ),
    ];
  }
  if (result.loadout?.verdict === "inconclusive") {
    // The group arm may well have PASSED here: the verdict is inconclusive because the arm
    // pattern does not decide, or a consulted arm (solo, peers) was never graded.
    return [
      text("The "),
      term("arm", "arms"),
      text(" did not form a conclusive pattern - or a consulted arm ("),
      term("solo"),
      text(" or "),
      term("peers"),
      text(
        ") was never graded - so no verdict stands. Open the full evidence and read each arm's state.",
      ),
    ];
  }
  return [
    text("The deciding "),
    term("arm"),
    text(
      " failed its checks. Read the failing check's evidence before blaming the skill - a too-strict pattern fails exactly the same way.",
    ),
  ];
}

// The arm whose result decides the case: group in group mode, solo otherwise.
export function decidingArm(result: CaseResult): ArmResult | undefined {
  const wanted: RuntimeArm = result.loadout === undefined ? "solo" : "group";
  return result.arms.find((arm) => arm.arm === wanted) ?? result.arms[0];
}

// The checks shown inline on a card. A group-inconclusive verdict can be caused by a consulted
// arm (solo or peers) while the deciding group arm passed, so its evidence spans every arm; other
// actions point at the deciding arm, whose checks produced the verdict.
export function cardEvidence(result: CaseResult): readonly Check[] {
  if (result.loadout?.verdict === "inconclusive") {
    return result.arms.flatMap((arm) => failingChecks(arm)).slice(0, 3);
  }
  const arm = decidingArm(result);
  return arm === undefined ? [] : failingChecks(arm);
}

export function failingChecks(arm: ArmResult): readonly Check[] {
  return arm.trials
    .flatMap((trial) => trial.checks)
    .filter((check) => !check.pass)
    .slice(0, 3);
}

// Why each instruction verdict produced its action, in plain language tied to the arm that proved
// it - the "why" the run report leads with.
export const FINDING_REASON: Readonly<Record<string, string>> = {
  inconclusive: "The arms did not form a conclusive pattern, so no action is implied yet.",
  interference:
    "The rule works on its own but the file fails with it present, so it fights the other rules here.",
  "load-bearing":
    "Removing this rule broke the behavior (the peers arm failed), so the rule is doing the work.",
  prune:
    "The rule did not produce the behavior on its own, and the behavior happened without it anyway.",
  redundant:
    "The behavior still happened with this rule removed (the peers arm passed), so another rule in this file already covers it.",
};

export const ACTION_LABEL: Readonly<Record<InstructionAction, string>> = {
  delete: "Delete",
  investigate: "Investigate",
  keep: "Keep",
  review: "Review",
};

// Rung copy shared by the coverage view's legend, tooltips, and tiles.
export const RUNG_LABEL: Readonly<Record<string, string>> = {
  execution: "execution",
  regex: "regex",
  trigger: "trigger-only",
  ungraded: "ungraded",
};

export const RUNG_MEANING: Readonly<Record<string, string>> = {
  execution:
    "Deterministic proof of the artifact beyond lexical matching: runtime behavior via command_exit, schema or compile validation, or structural ast rules.",
  regex: "Lexical presence in the output; a comment can satisfy it.",
  trigger:
    "Proves invocation behavior - the skill fires (or stays quiet) when it should; says nothing about what it changes.",
  ungraded: "No grader at all - only trace completeness is checked. Not evidence of anything.",
};
