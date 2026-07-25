/**
 * The single source of truth for report terminology. Reports are read weeks apart; the design
 * assumption is a reader who has forgotten how skillval works, so every load-bearing term
 * self-explains at point of use - the report UI renders each term as a rich popover built from
 * these definitions. Pure data: the React report app and the node-side tests both import it.
 */

export interface TermDefinition {
  // What to do with the information - the action a re-taught reader takes.
  readonly act: string;
  // How skillval computes it - the mechanism behind the word.
  readonly how: string;
  readonly title: string;
  // What the word means, in one or two plain sentences.
  readonly what: string;
}

// Keys are stable slugs; titles are the visible words.
export const TERMS = {
  arm: {
    act: "Read a case's arms side by side; every verdict is a comparison between them.",
    how: "Each arm runs the same prompt in a clean workspace with a different set of skills seeded, and is graded by the same checks.",
    title: "arm",
    what: "One isolated run configuration of a case: the same prompt with a particular set of skills installed.",
  },
  baseline: {
    act: "If baseline also passes, the skill did not cause the behavior - see no-op.",
    how: "The same prompt in a clean environment with no skill seeded at all.",
    title: "baseline",
    what: "The control arm: what the model does WITHOUT the skill.",
  },
  execution: {
    act: "The strongest deterministic evidence a case can carry - prefer it for behavioral or structural requirements.",
    how: "command_exit runs a grading script against the produced artifact; json_schema and tsc validate it; ast matches its parsed structure. All decide deterministically, beyond what text patterns can see.",
    title: "execution",
    what: "A grader rung: the case is decided by proof about the produced artifact - what it does when run, or what shape its code actually has.",
  },
  inconclusive: {
    act: "Rerun the case - infrastructure results are never cached, so a rerun grades fresh.",
    how: "Every trial of the deciding arm hit a capture-layer failure (agent output too large, or a timeout), so nothing was graded.",
    title: "inconclusive",
    what: "The case has no content result: not a pass, not a failure, and never a no-op.",
  },
  interference: {
    act: "Review the loadout pairing - the finding is about how the skills combine, not the skill alone.",
    how: "solo passes, group fails, and peers (the loadout minus this skill) still passes - the skill's presence is what breaks the case.",
    title: "interference",
    what: "The skill works alone but breaks when loaded with your other skills.",
  },
  "load-bearing": {
    act: "Keep the rule; it is earning its context window.",
    how: "The with-skill arm passes and the without-skill control fails - removing the skill removes the behavior.",
    title: "load-bearing",
    what: "The skill is doing real work: behavior appears with it and disappears without it.",
  },
  "no-op": {
    act: "Treat as a prune candidate, but verify on a second model first - no-op is per-model.",
    how: "The without-skill control (baseline, or peers in group mode) passed the same behavioral checks.",
    title: "no-op",
    what: "The behavior happens without the skill: the case passes either way, so this rule changed nothing on this model.",
  },
  peers: {
    act: "peers passing while group passes means another skill already covers the behavior (redundant).",
    how: "Group mode seeds the configured loadout minus the skill under test.",
    title: "peers",
    what: "The without-this-skill control in group mode: your other skills, alone.",
  },
  "prune-candidate": {
    act: "Surface it, verify it cross-model, then decide - skillval flags, you prune.",
    how: "A no-op finding: the control arm passed, so the model already does this unaided.",
    title: "prune candidate",
    what: "A rule that looks like dead weight on this model: the behavior no longer needs teaching.",
  },
  redundant: {
    act: "Consider consolidating: another loadout member already teaches this.",
    how: "Both group and peers pass - the behavior survives removing this skill from the loadout.",
    title: "redundant",
    what: "Another skill in the loadout already produces this behavior.",
  },
  regex: {
    act: "Good for lexical conventions; a gap when it proxies runtime behavior - see execution.",
    how: "must_match / must_not_match patterns tested against the agent's output and produced files.",
    title: "regex",
    what: "A grader rung: the case is decided by text patterns - lexical presence, which a comment can satisfy.",
  },
  solo: {
    act: "solo alone proves the skill CAN produce the behavior; only a comparison proves it is needed.",
    how: "The skill under test is seeded into a clean workspace; nothing else is installed.",
    title: "solo",
    what: "The with-skill arm: what the model does with only this skill present.",
  },
  trial: {
    act: "Disagreement between trials is normal model noise; the vote absorbs it.",
    how: "An arm runs its configured trials (1-5); the majority of graded trials decides, and disagreement escalates up to five. Infrastructure failures never vote.",
    title: "trial",
    what: "One spawn of the agent for an arm. An arm's pass/fail is a majority vote over its trials.",
  },
  trigger: {
    act: "Trigger coverage is necessary but weak: it proves loading, not effect - see the grader rungs.",
    how: "The trace is checked for the executor's skill-invocation event (structured for claude and pi, command heuristic for codex). should_trigger: false asserts the skill correctly stayed quiet.",
    title: "trigger",
    what: "Whether the model actually loaded the skill when it should - or stayed quiet when it should not.",
  },
  ungraded: {
    act: "Give the case a grader or delete it - a check that cannot fail is ceremony.",
    how: "The case declares no should_trigger and no assert, so only trace completeness is checked.",
    title: "ungraded",
    what: "A case with no grader at all. It is evidence of nothing.",
  },
} as const satisfies Readonly<Record<string, TermDefinition>>;

export type TermKey = keyof typeof TERMS;
