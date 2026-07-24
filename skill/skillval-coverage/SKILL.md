---
name: skillval-coverage
description: "Audit eval coverage for the agent skills skillval discovers and decide what is worth testing, and diagnose ineffective tests by reading run output. Use when the user asks which skills or rules need skillval cases, wants to find eval gaps or coverage opportunities, asks whether a particular rule is worth a case, wants to spot stale cases to prune, or asks why a case failed / passed / whether a verdict can be trusted / how to fix a flaky or misleading case. Guides the keep / prune / stop and fix-the-case decisions; it diagnoses and proposes, it does not silently rewrite or run case files."
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
3. **Read what is graded.** From the skill's `skillval.yml`, note which rules
   have a *behavioral* case (an `assert` with `must_match` / `must_not_match` /
   graders), which have only a trigger case, and how many negatives exist.
4. **Diff and rank.** The gap is rules taught with no behavioral case. Rank by
   decay risk and decision value, **not** by which skills look thin (see the
   ranking rule below).
5. **Guide the decisions.** For each real gap, walk the user through keep /
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
skill - skillval does not rewrite skills for their own sake. Recommend moving a
rule to a script only when it clears every gate:

- **Decidable** - a definite right answer from inspecting state, not a judgment.
  "Does the README have an Install heading" is decidable; "is the README good"
  is not. The regex-able proxy is not the real question, and scripting it
  launders a judgment into a checkbox.
- **Stable** - what the script inspects drifts slower than the script will be
  maintained. File shapes and config fields qualify; a remote API's responses
  do not - they rot silently green.
- **Testable** - you can name the input the script must catch and fail on, and
  that test ships with the script. If you cannot name the failing input, the
  rule is not understood well enough to script; it stays prose.
- **Detection or a literal fix only** - never suggest scripting "author",
  "decide", or "improve".

The caveat that makes this advice safe: **a wrong script is worse than an
untested prose rule.** Prose poses a question the model may answer well; a bad
script closes the question with a green checkmark that stops anyone looking
again. So default to leaving prose alone, pair every script suggestion with the
test the script must ship, and when a rule fails any gate say so plainly and
leave it as prose. Never suggest scripting a judgment call.

## Stopping rules

Stop adding cases to a skill when the next case cannot change a decision the user
would make about it. Concretely:

- **One behavioral case per capability rule that could no-op.** Preferences need
  one, not one-per-rule.
- **The case must be able to fail** (the test above). No nameable failure -> skip.
- **Do not test the model instead of the skill.** If `solo` and `baseline` will
  obviously agree, the case measures model ability, not skill effect - skip.
- **Stop at the edge of determinism.** skillval uses deterministic graders only.
  Some skill value is un-gradeable without a judge ("is this a *good*
  orientation" vs "does it have the right shape"). Once an assertion only checks
  shape, more shape-cases add no confidence - that is a hard stop.

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

Which verdicts to read behind, and what each usually means:

- **`solo` fail** - real skill gap, or a broken assert? Read the `got:`. If the
  produced output contains the behavior and the pattern missed it, the assert is
  wrong, not the skill. Re-key it on what actually differs between the arms.
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
