---
name: skillval-coverage
description: "Audit eval coverage for the agent skills skillval discovers and decide what is worth testing, and diagnose ineffective tests by reading run output. Use when the user asks which skills or rules need skillval cases, wants to find eval gaps or coverage opportunities, asks whether a particular rule is worth a case, wants to spot stale cases to prune, or asks why a case failed / passed / whether a verdict can be trusted / how to fix a flaky or misleading case. Guides the keep / prune / stop and fix-the-case decisions; it diagnoses and proposes, it does not silently rewrite or run case files. Not for simply running a suite or reporting whether it passes - executing skillval and reading a green result is plain usage with no coverage judgment involved; reach for this skill only when a decision about cases themselves is on the table."
metadata:
  icon: 🎯
---

# skillval-coverage

Use `skillval-coverage` to audit which of the user's discoverable skills are
under-tested by skillval, and to guide the decision of what actually deserves a
case. The output is a ranked assessment and a short do-next list, not new files.
You diagnose and advise; authoring and running cases is the user's call.

This skill exists because "add more tests" is the wrong instinct for skill
evals. Most coverage effort gets misallocated to the skills that look thin
rather than the ones that are actually under-defended. The job here is to find
the real gaps and stop at the point where another case would prove nothing.

It has two modes. **Static** (before running): audit which rules are tested,
rank the gaps, guide keep / write / stop - the sections below through "Output."
**Dynamic** (after running): read the run output and find *ineffective* tests -
cases whose pass/fail verdict does not reflect whether the skill works - and
propose the fix. An ineffective test is worse than a missing one: it hands you
false confidence. See "Watching output."

## What a case defends

A skillval case exists to answer a yes/no question about one **rule** (an atomic
directive in a SKILL.md that you could write a single case against). There are
only three questions worth a case:

1. **Trigger** - does the skill fire when it should? (`should_trigger: true`)
2. **Boundary** - does it stay quiet when it should not, including on a
   neighboring skill's territory? (`should_trigger: false`)
3. **Load-bearing** - when it fires, does it change behavior the model would not
   produce anyway? (a `solo` arm vs a `baseline` arm; solo-pass with
   baseline-fail is the proof)

Coverage is not "how many cases" - it is "does every rule whose deletion I would
regret have a case that could catch the regret."

## The one test for whether a case is worth writing

**Can you name a concrete future in which this case flips to fail?** If the only
honest answer is "it will always pass," the case is comfort, not coverage - do
not write it. A case that can only pass has zero information value and costs
trials forever. This is the single most useful filter; apply it to every
candidate case before anything else.

## Workflow

1. **Inventory.** Run `skillval list --json` to get the skills skillval actually
   discovers (name, root, `class`, `caseCount`, `status`, `skillDirectory`).
   Only audit `status: ready` skills - these are the ones the user has opted
   into. A skill with a `SKILL.md` but no `skillval.yml` shows as not-ready:
   that is zero coverage, and worth flagging, but confirm the user wants it
   evaluated before treating it as a gap.
2. **Extract rules taught.** For each skill, read its `SKILL.md` and list the
   distinct testable rules (see the granularity guidance in
   [references/decisions.md](references/decisions.md) - do not count section
   headers, prose, or examples as rules). Classify each rule **capability** or
   **preference** (next section).
3. **Read what is graded.** Run `skillval coverage --json` - it classifies
   every ready skill's cases by grader strength (trigger-only / regex /
   execution; trigger-only is invocation coverage, below the behavioral
   ladder's first rung) and surfaces the gap lists mechanically;
   `skillval coverage` renders the same data as a browsable matrix, rule
   column included. Note which rules have a *behavioral* case, which have
   only a trigger case, and how many negatives exist - and on which rung each
   behavioral case sits (a regex-only case for a runtime behavior is itself a
   gap; see the ladder in the stopping rules).
4. **Audit the tests themselves.** Coverage counts cases; it says nothing
   about whether they measure anything. Read each behavioral case against
   the defect checklist in "Auditing the tests, not just the coverage" -
   a case that cannot fail, cannot match, or is narrower than the language
   is worse than a missing case, because it reports coverage you do not
   have. An unrun case is unproven by definition: its assert has never met
   real output.
5. **Diff and rank.** The gap is rules taught with no behavioral case, plus
   cases whose grading cannot be trusted. Rank by
   decay risk and decision value, **not** by which skills look thin (see the
   ranking rule below).
6. **Guide the decisions.** For each real gap, walk the user through keep /
   write / skip using the stopping rules - and flag any rule that is really a
   deterministic check, which is better moved to a tested script than written as
   a case (see "When a rule belongs in a script" below). Then surface
   interference and boundary gaps. Present a ranked table and a short do-next
   list.

## Capability vs preference (the axis that drives everything)

- A **capability** rule teaches a model something it does not yet reliably do on
  its own. Capabilities **expire**: as models improve, the behavior becomes
  native, the rule stops changing anything, and the case turns into a no-op.
  Every capability rule that could plausibly become a no-op deserves its own
  behavioral case, because its whole justification can silently evaporate.
- A **preference** rule is an arbitrary house choice, style, or convention the
  model would never guess. Preferences are load-bearing almost by definition -
  the model will not stumble onto your convention - so they do **not** need a
  case per micro-rule. One trigger plus one representative behavioral case
  retires a preference-heavy skill.

Consequence: a thin, preference-heavy standards skill can be *done* at 3-5
cases. A fat, capability-heavy skill that grades one of six techniques is badly
under-covered even though it "has cases." Thinness is not the signal; untested
capability is.

## Two axes: what a rule is, and how it shows up

Capability and preference answer *what kind of rule* it is - does the model lack
the ability, or just default to a different choice. A second, **orthogonal** axis
answers *how the rule's value shows up, and therefore how you test it* -
disposition is not a third archetype, it is this second axis:

- **Triggered** - the rule only matters when the user raises the topic. "What
  state library should I use?" -> Zustand. You legitimately name the topic in the
  prompt and check the answer.
- **Dispositional** - the rule should apply by default, unasked, in ordinary
  work. "Use ahooks' hooks," "instrument every module," "return typed errors."
  The user is not asking about it; it should just appear.

Every rule sits on both axes, independently. `ahooks-over-raw` is a *preference*
that is *dispositional* (you want it in every component). `instrument-every-
module` is a *capability-ish practice* that is *dispositional*. `what-state-
library` is a *preference* that is *triggered*.

**The anchored rule: a dispositional rule must be tested with a held-out prompt -
whether it is a preference or a capability.** Never name the behavior; ask for
the ordinary surrounding task ("implement a payment client that charges a card")
and check whether the behavior appears anyway. Naming it *leads the witness*,
both arms pass, and you get a **false no-op** - the skill looks useless when it
is not. The trap is not about the *kind* of rule; it bites preferences and
capabilities identically: observability (capability-ish practices) and
standards-react (preferences) had the same failure mode - a leading prompt - and
the same fix - hold it out. A *triggered* rule is correctly tested by naming the
topic, because the user really does raise it.

To test "in everything," a dispositional case set should span a few different
ordinary tasks, not one memorized shape - a disposition that only fires on one
shape is not a disposition.

## When a rule belongs in a script, not a case

Some rules are not model judgment at all - they are deterministic checks the
skill happens to state in prose: "verify a LICENSE file exists", "the CI trigger
is pull_request-only", "publishConfig.access is public". These do not need a
skillval case and are not the skill's real value. They belong in a script the
skill ships under `scripts/`, with a unit test - which is *more* testable than
any behavioral case, because the answer is deterministic instead of a model
behavior you grade across trials. Suggest the rewrite: it improves testability
and removes the rule from the flaky eval surface entirely.

This is a suggestion to improve testability, not a mandate to restructure the
skill. Pair every script suggestion with the test it must ship, and never
script a judgment call. (PRUNED 2026-07-25: the gate checklist - decidable /
stable / testable / detection-only - and the wrong-script-worse-than-prose
caveat were a confirmed no-op on gpt-5.6-sol and GLM-5.2: models hold the
distinction natively; the two retained sentences are the procedural remainder.)

## Stopping rules

Stop adding cases to a skill when the next case cannot change a decision the user
would make about it. Concretely:

- **One behavioral case per capability rule that could no-op.** Preferences need
  one, not one-per-rule.
- **The case must be able to fail** (the test above). No nameable failure -> skip.
- **Do not test the model instead of the skill.** If `solo` and `baseline` will
  obviously agree, the case measures model ability, not skill effect - skip.
- **Climb the grader ladder before declaring a case over the barrier.** The
  ladder has three rungs, and each decides more than the one below. (A
  trigger-only case sits beneath rung 1 entirely: it proves invocation
  behavior, not what the skill changes - `skillval coverage` reports it as
  its own tier for exactly that reason.)
  1. **Regex measures presence** - a token appeared somewhere (a `debugInfo`
     name, the word "correlation", `class \w*Error`). A comment satisfies it.
  2. **Execution measures behavior or structure** - `command_exit` runs a
     grading script against the produced artifact and asserts what the code
     *does* (and `assert.ast` matches what shape the code actually *has* -
     placement facts like a `this.`-referencing guard outside the
     constructor, which separates an internal invariant from input
     validation deterministically): the
     rejection is a typed subclass with the original `cause` preserved on the
     chain, the debug snapshot truthfully reflects live state and changes
     across a release, two boundary records share a per-call correlation id.
     Much of what reads as "quality - judge territory" from the regex rung is
     decidable here, deterministically. Before parking a case as
     over-the-barrier, ask: can a script that stubs the dependencies and calls
     the artifact decide this? Mechanics that make it safe: the script lives
     in the case's `command_exit` command (written at grading time - NEVER in
     a fixture, which lands in the workspace before the agent runs and leaks
     the rubric to both arms); for held-out disposition prompts it probes the
     skill's own taught idioms rather than prompt-pinned seams (pinning the
     surface in the prompt names the technique and leads the witness); and it
     ships with red/green validation - a known-good artifact that exits 0 and
     a known-bad one that exits nonzero.
  3. **Judgment stays out of reach** - is it good, appropriate, complete, or
     distinguishable from a *lookalike the same execution also satisfies*: a
     span that is technically emitted but attribute-poor, an error message
     that is present but unhelpful. **The tell:** you can name a lookalike
     that passes the strongest script or structural rule you can write. That is
     the model judge's territory (roadmap); leave the dimension explicitly
     flagged rather than faked - do not force a regex or a script across it.

A skill is adequately covered when every capability rule that could decay has a
case that could catch the decay, every preference has one representative case,
and the trigger/boundary is pinned. Past that point, more cases are ceremony.

## Also surface

- **Interference (highest real-world value, usually zero coverage).** If the
  user co-loads skills, group mode (`--loadout`) measures whether a skill breaks
  its neighbors - a failure mode isolated `solo` cases cannot see. Flag skills
  that are always loaded together and have no group case.
- **Thin boundaries.** One negative trigger per skill is common and thin. A
  skill sitting next to a similar one should have a boundary-negative against
  that neighbor's territory.
- **Known no-ops.** A case that already passes at `baseline` is a prune
  candidate the user has evidence for - call these out as deletions to consider,
  remembering the no-op verdict is model-specific (confirm across the executors
  they actually use before pruning).

## Auditing the tests, not just the coverage

These defects are visible by READING the case - no run, no spend. Each has a
tell you can check statically and a fix. Work them before proposing new cases:
a suite of untrustworthy tests is a worse starting point than a thin one.

- **It cannot fail.** The master filter. Tell: you cannot name output that
  would fail this assert. A `must_match` on a word the prompt itself
  guarantees, or on something every plausible answer contains. Fix:
  re-key on what distinguishes the skill's answer, or retire the case.
- **It cannot match.** The invisible one, because it looks like a skill
  failure forever. Generation mode grades *produced files*; trigger mode
  grades the *agent's text*. A generation case asserting on prose the model
  only ever says can never match, and neither can an `ast` rule on a file
  the prompt never asks for, or on an extension the grader does not parse.
  Tell: mode and grader disagree about where the behavior lives.
- **It is narrower than the language.** A correct implementation spells the
  behavior a way the pattern does not admit. Recurring families, all
  observed: typography (a model writes a curly apostrophe, the pattern has
  an ASCII one), **capitalization** (skillval compiles patterns with `m`
  only, never `i`, so `\bty\b` misses an answer that opens "Ty."), type
  arguments (`fn($$$A)` does not match `fn<T>($$$A)`), namespacing and
  aliasing (`React.useState`, `useState as useLocal`), and wrapping
  (`await`, optional chaining). Tell: the pattern encodes one spelling of a
  behavior that has several. Fix: alternate over the real forms - and
  prefer a structural rule, which is spelling-agnostic by construction.
  The discriminator for capitalization: a **code literal** (`pull_request`,
  `NPM_CONFIG_PROVENANCE`, `codex exec`) is legitimately case-sensitive and
  must stay exact, but a **prose word** the model writes in a sentence
  (`ty`, `payoff`, `planner`) needs a class - it will eventually appear
  title-cased. Loosening a code literal is its own defect: it invites the
  false pass.
- **It is broader than the behavior.** A single common word, or a pattern
  a comment satisfies. Tell: you can write a file that matches while doing
  nothing the skill teaches. Fix: climb a rung - structure and execution
  cannot be satisfied by a comment.
- **The prompt leads the witness.** Naming the technique the case grades
  turns a disposition test into a compliance test, and both arms pass. Tell:
  the prompt contains the words the assert looks for. Fix: hold the
  technique out; ask for the ordinary task.
- **The control is contaminated or vacuous.** A prompt naming the skill's
  path lets `baseline` read it; a fixture that stages the expected answer
  shows it to both arms; a trigger-only case has no behavioral check on
  `peers`, so that arm passes vacuously. Tell: ask what the control arm
  could possibly have done differently. Fix: name the skill, never a path;
  stage only the task's inputs, never its answer.
- **The verdict is unstable.** Behavior that flips between identical runs
  graded at `trials: 1` is a coin toss recorded as a fact. Tell: repeated
  runs disagree. Fix: raise `trials` to 3 on cases whose verdict drives a
  decision - above 1, disagreement escalates automatically.

## Watching output: fixing ineffective tests

After a run, the pass/fail column is not the finding - it is the *starting
point*. An ineffective test is one whose verdict does not reflect whether the
skill works: a broken assert that fails a case the skill actually passed, a
loose assert that passes without the behavior, an executor crash recorded as a
grading failure, a case that can never fail. The report skillval writes carries
the evidence to tell them apart: on a failed `must_match` the check `detail`
includes the `got:` snippet of what was graded, plus the trace and the
invocation evidence. Read it. Never trust a verdict you have not looked behind.

**The guardrail, which is the whole safety of this mode:** adjust an assert
toward the difference you can *see* between the `solo` and `baseline` output -
never toward making an arm turn green. Read *both* arms before changing
anything. If `solo` and `baseline` produced the same thing, the honest verdict
is "no-op," not "find a regex that only `solo` happens to hit." An assert tuned
to pass is worse than one that fails honestly - it is the false-verdict failure,
now baked into the suite. Fixing a false verdict and gaming a test look
identical from the diff; only the direction of the adjustment tells them apart.

Which verdicts to read behind, and what each usually means (PRUNED 2026-07-25:
the generic solo-fail diagnosis - read the got:, and if the behavior is present
the assert is wrong, not the skill - was a confirmed no-op on gpt-5.6-sol and
GLM-5.2; the bullets that remain are skillval-specific knowledge):

- **`solo` fail + `baseline` pass** ("the skill did worse") - almost never real.
  Suspect a broken assert or a contaminated `baseline` (a prompt that names the
  skill's install path, so the baseline arm reads the real skill). Fix the
  prompt to name the skill, not a path.
- **A `run`/process failure** - the executor crashed; this is infrastructure,
  not a grading result. Do not edit the case - retry the trial (raise `trials`
  so a transient crash is outvoted, or re-run). Never "fix" a case to work
  around a crash.
- **Both arms pass (no-op)** - before trusting the prune signal, confirm the
  marker reflects the behavior and is not a trivial match, and that `baseline`
  is not contaminated. A false pass hides a real gap the way a false fail hides
  real coverage.
- **A case that never fails across runs** - a can't-fail case (see "The one
  test"). Its assert does not discriminate; restructure it so a failing future
  exists, or retire it.

Diagnose the category, then **propose** the adjustment with the `got:` evidence
attached, so the user can see why. Apply on their confirmation; do not silently
rewrite asserts. See [references/decisions.md](references/decisions.md) for the
catalog of ineffective-test types and worked examples.

## Confidence: what evidence licenses what action

Every verdict carries a confidence, and the action it justifies is bounded by
it. Reading a strong action off weak evidence is how a suite starts damaging
the skills it was built to protect.

| Evidence | Licenses |
| --- | --- |
| One trial, one model, regex-graded | Investigate. Never a prune, never a skill edit. |
| Multiple trials, one model | A ledger entry for *that model*. |
| Agreement across two model families | A prune proposal, for the user to decide. |
| Execution or structural grading | Raises confidence a notch at any tier: it measures behavior or shape, not spelling. |
| A failing arm whose `got:` shows correct output | An assert fix only. The ruler is broken, not the skill. |

Two boundaries this table is drawing:

- **A ruler defect is not a skill finding.** When the evidence says the
  measurement was wrong, the only licensed change is to the measurement.
  Editing the skill to satisfy a broken assert corrupts both.
- **Effort and model tiers are routing data, not defects.** A rule that is
  load-bearing at low reasoning effort and a no-op at high has not failed;
  it has a scope. The useful output is which tiers still need it, not a
  prune. Only a no-op that holds *across* tiers and models is dead weight.

Where confidence is genuinely low, say so and name the cheapest experiment
that would raise it - usually a second model, or three trials instead of one.

## Output

Produce a ranked table - one row per ready skill, rules-taught vs
rules-graded-behaviorally, gap flagged by capability/preference - worst-covered
(most untested capability rules) at the top. Follow it with a short do-next
list: which two or three rules are worth a case and why, which cases are prune
candidates, and which skills are already done. Keep it to what changes a
decision. Do not write `skillval.yml` files or run trials - that is the user's
next move, and a separate step.

See [references/decisions.md](references/decisions.md) for rule-granularity
guidance, worked examples, and the reasoning behind each stopping rule.
