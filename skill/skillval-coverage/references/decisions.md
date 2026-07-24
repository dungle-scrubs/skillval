# Coverage decisions: granularity, examples, and reasoning

Load this when you need to decide what counts as a rule, or want the worked
examples behind the stopping rules in `SKILL.md`.

## What counts as a distinct rule

A rule is the atomic unit you could write **one** behavioral case against - a
directive that could independently be load-bearing or a no-op. Be disciplined:

- **Count** each specific directive that changes what the model produces:
  "use uv not pip", "use ruff not black", "use ty for type checking" are three
  rules.
- **Do not count** section headers, motivation, background, or examples. A skill
  that explains a workflow narratively usually has 2-4 real rules, not 20.
- **Merge** restatements of the same directive scattered across sections into
  one rule.

When you are unsure whether two directives are one rule or two, ask whether a
single case could fail for one and pass for the other. If yes, they are two.

## Worked example: the misallocation trap

`observability` teaches six techniques - inspectable state, structured boundary
logs, typed errors, a verbose toggle, internal invariants, boundary tracing -
and grades exactly one (`inspectable-state`, via one `must_match`). Five
capability rules are untested. Any of them could silently become native to the
model and nobody would notice.

Compare a `standards-*` skill: 3-4 preference rules, 3-4 cases, effectively
complete. It looks similarly "thin" by case count, but it is done and
observability is not. Ranking by case count would put effort in exactly the
wrong place. Rank by untested-capability-rules instead.

## Worked example: a case that could not fail

A review-cleanup case once asserted only that narrating comments were deleted.
Every model deletes obvious narrating comments unprompted, so `solo` and
`baseline` both passed - the case tested the model, not the skill, and passed
for weeks while proving nothing. It became a real test only when it was
restructured to grade the skill's *distinctive* behavior: given one staged file
and one committed file both carrying narrating comments, clean the staged change
and leave the unchanged committed file alone. Now an over-reaching cleanup fails
`must_match` on the committed file - the case can fail, so it means something.

The lesson: grade the behavior that is *distinctive to the skill*, not the
behavior any competent model already has. If you cannot find a distinctive
behavior a deterministic grader can see, that is a signal to stop, not to write
a weaker case.

## Why "can it fail?" is the master filter

Every other stopping rule is a special case of it:

- "Do not test the model" = the case cannot fail because baseline already passes.
- "Stop at the edge of determinism" = the case cannot fail *meaningfully*
  because the grader only sees shape, and correct-shape/wrong-content passes.
- "Preferences need only one case" = additional preference cases cannot fail in
  a new way; they re-assert the same guessable-vs-not fact.

If you can state the concrete input and model behavior that would make the case
go red, it is worth writing. If you cannot, adding it just grows the trial bill
and the green-checkmark comfort without adding coverage.

## The no-op verdict is model-specific

A rule that passes at `baseline` on a strong model may be load-bearing on a
weaker one. A rule is a true prune candidate only when every model in the user's
normal rotation passes it at baseline. Before recommending a deletion, check
whether the no-op was observed across the executors the user actually runs
(codex, claude, pi), not just one. Recommend re-running the case on the other
executors rather than pruning on a single data point.

## Interference is the coverage class everyone skips

Solo cases measure a skill alone. They cannot see a skill that quietly degrades
a neighbor when both are loaded - the exact situation of real use, where a user
runs a dozen skills at once. Group mode (`--loadout`) runs `solo` / `group` /
`peers` and attributes interference to the target only when the target's
presence is what breaks the case. For any set of skills the user always loads
together, one group case is worth more than another per-rule behavioral case,
because it covers a failure mode that has no coverage at all today.

## Prose, script, or case: the third triage bucket

Capability and preference are not the only fates of a rule. A third kind is not
skill judgment at all - a deterministic check the skill states in prose ("a
LICENSE exists", "the CI trigger is pull_request-only"). For these, the best
move is neither a skillval case nor better prose: ship a script under `scripts/`
with a unit test. That is strictly more testable than a behavioral case, because
the answer is deterministic rather than a model behavior graded across trials,
and the rule leaves the flaky eval surface entirely.

Before recommending it, run the four gates in `SKILL.md`. The gate that does the
real work is **testability**: can you name the input the script must catch and
fail on? If not, the check is not understood well enough to script - it stays
prose. A scripted check that ships without a test has not solved the
untested-rule problem, it has moved it and added false authority.

The discipline is conservative by construction, because the failure is
asymmetric. A missing test on a prose rule is a known gap. A wrong script is a
*hidden* gap wearing a green checkmark: it answers a question that was open,
closes it incorrectly, and stops anyone from looking again. So the default is
"leave the prose," a rule earns its way to a script by clearing every gate with
a test attached, and a judgment call ("is the README good", "is this the right
license") never becomes a script no matter how regex-able a proxy for it looks.
Scripting the proxy launders a judgment into a checkbox - the most damaging move
this advice can make, and the one it exists to prevent.
