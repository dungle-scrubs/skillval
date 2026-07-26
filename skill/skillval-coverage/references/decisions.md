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

## The catalog of ineffective tests

An ineffective test is one whose verdict does not track whether the skill works.
Each type has a tell in the report and a fix, and the fix is always anchored to
the observed difference between the arms - never to turning an arm green.

**False fail** - the skill produced the behavior, the assert missed it. Tell: a
`solo` (or both-arm) fail where the `got:` snippet plainly contains the
behavior. Example: a case for structured boundary logging required both a
`correlationId` *and* a `logger.` call shape; the model emitted a typed log
event with a `correlationId` but no `logger.` call, so the assert failed a
correct solo arm. Fix: drop the spurious requirement, key on the real
discriminator (the `correlationId`, which the skill adds and baseline omits).
The corrected case flips to `solo` pass / `baseline` fail - load-bearing.

**False pass** - the marker matched without the behavior. Tell: both arms pass,
but reading the output shows the marker appears incidentally. Fix: tighten to
something the behavior necessarily produces. A false pass is more dangerous than
a false fail because it reports coverage you do not have.

**Contamination** - the `baseline` arm could see the skill, so a no-op verdict
is fake. Tell: a prompt that names the skill's install path (`Read
~/.agents/skills/<name>/SKILL.md`), or trace evidence of the baseline reading
the skill's own file. Fix: name the skill, not a path, so only the seeded arm
can reach it.

**Infrastructure recorded as grading** - an executor process crashed and the
trial was scored as a content failure. Tell: a `run` check failure (e.g. `pi -p
exited 1`), often with empty output. Fix: this is not a case defect - retry the
trial, raise `trials` so a transient crash is outvoted, or switch to a sandboxed
executor for that run. Editing the case to "pass" would be gaming a crash.

**Can't-fail** - the case passes regardless of the skill, so it measures
nothing. Tell: it has never failed across runs, and you cannot name an input
that would make it fail. Fix: restructure it around a behavior distinctive to
the skill, or retire it (see "Why 'can it fail?' is the master filter").

**Narrower than the language** - the commonest false fail, and the one that
recurs. The behavior has several legal spellings and the pattern admits one.
Four families, every one of them observed in this corpus:

- *Typography.* A refusal pattern spelled `don'?t` with an ASCII apostrophe
  fails a model that writes `don't` with U+2019. The refusal was correct; the
  ruler was ASCII-only.
- *Type arguments.* An ast pattern `useState(() => $$$B)` does not match
  `useState<Config>(() => ...)`; the type-argument call is a different node
  shape. This one bit three separate cases before it was internalized -
  always alternate `fn($$$A)` with `fn<$$$T>($$$A)`.
- *Namespacing and aliasing.* `React.useState(...)` and
  `import { useState as useLocal }` are the same behavior wearing different
  identifiers. A bare call pattern misses both; an import-binding rule
  catches the alias.
- *Wrapping.* `await`, optional chaining, and a returned promise change the
  surrounding node without changing the behavior.

Tell: the `got:` excerpt contains an implementation you would accept, spelled
differently. Fix: alternate over the real forms - or climb to a structural
rule, which is spelling-agnostic by construction. A regex that has to
enumerate typography is usually asking for the wrong rung.

**Cannot match** - the grader is pointed where the behavior never appears, so
the case fails forever and looks like a permanent skill gap. Generation mode
grades produced *files*; trigger mode grades the agent's *text*. A generation
case asserting on an explanation the model only speaks cannot match, and
neither can an `ast` rule naming a file the prompt never asks for, or an
extension the parser does not support. Tell: mode and grader disagree about
where the behavior lives. Fix: move the assertion to where the behavior is,
or change the prompt so the behavior lands in a file.

**Leaked rubric** - the case shows the answer to both arms before grading.
Two shapes: a prompt that names the technique being graded (compliance test,
not a disposition test - both arms pass), and a fixture that stages the
expected artifact where every arm can read it. Tell: ask what the control arm
could have done differently; if the answer is "nothing, it was told", the case
measures instruction-following. Fix: hold the technique out and stage only the
task's inputs.

**Unstable verdict** - the behavior is genuinely bistable and `trials: 1`
records a coin toss as a fact. Observed: a model that writes a debug toggle
unprompted on some rolls and not others. Tell: identical re-runs disagree.
Fix: `trials: 3` on cases whose verdict drives a decision; above 1, skillval
escalates on disagreement automatically. Note this is a *measurement* fix -
the underlying bistability is itself a finding about how reliably the model
holds the behavior.

## Fixing a false verdict versus gaming a test

These produce identical diffs - both edit an assert - and are opposites. The
only thing that distinguishes them is what the adjustment is anchored to:

- **Legitimate:** you read *both* arms' output, found a real difference the skill
  causes, and re-keyed the assert on that difference. The verdict changes because
  the assert now measures the true behavior.
- **Gaming:** you tuned the assert until a target arm passed, without a real
  behavioral difference behind it. `solo` and `baseline` produce the same thing
  and you found a regex that only one happens to hit.

If `solo` and `baseline` outputs do not differ in a way you can point to, there
is no assert that legitimately separates them - the honest verdict is "no-op,"
and the fix is to prune the rule, not to invent a discriminator. Read both arms
first, every time; propose the change with the evidence; let the user ratify.

## Dispositional rules and the held-out prompt

Disposition is not a kind of rule; it is the *how-it-shows-up* axis, orthogonal
to capability/preference. A rule is **dispositional** when it should apply by
default in ordinary work (ahooks in every component, instrumentation in every
module) and **triggered** when it only matters once the user raises the topic
("what state library?"). The anchored rule: **a dispositional rule must be tested
held-out - whether it is a preference or a capability.** The false-no-op trap
bites both kinds identically.

The techniques of a dispositional rule are usually trained knowledge, so a prompt
that names one ("add a verbose toggle") passes both arms - a false no-op.
observability was the type case on the capability-ish side: prompting "add
structured boundary logging" passed both arms; held out as "implement a
PaymentClient.charge that POSTs to a gateway" (no mention of logging), the skill
arm added a correlation id and baseline did not - flipped to load-bearing.
standards-react is the type case on the preference side and was authored held-out
already: "create a debounced search box" -> checks `useDebounce`, never naming
ahooks. Same axis, same test, different kind of rule.

Two cautions from real runs:

- **Do not over-hold-out a form preference.** `modern-hints` (use `list[` not
  `List[`) only applies *when annotations exist*. Dropping "typed" from the prompt
  made the model write no hints at all - nothing to grade. Elicit the context
  ("type-annotated functions") but keep the tested dimension (modernity) out of
  the prompt. Naming the *context* is not leading the witness; naming the *tested
  dimension* is.
- **Author across a few ordinary tasks**, not one shape - a disposition that only
  fires on one memorized shape is not a disposition. If the skill arm still does
  not apply the behavior held-out, that is a real finding: the skill does not
  instill the disposition strongly enough, or its trigger is too narrow to fire
  on ordinary work.

## The barrier: presence, then behavior and shape, then quality

This section used to say the deterministic ceiling was *presence*. That was
true when regex was the only instrument; it is not any more, and the correction
matters because it moved a case everyone cited as unreachable.

Execution grading (`command_exit`) decides what the produced code *does* -
whether a rejection preserves its cause, whether a snapshot tracks live state.
Structural grading (`assert.ast`) decides what the code *is* - and it splits
the canonical example below: an `assert` guarding a constructor parameter is
input validation, while a guard reading instance state inside an operation is
an internal invariant. Regex cannot tell those apart; a structural rule can,
because the distinction is literally a matter of where the node sits.

What remains beyond reach is quality: whether a span's attributes are useful,
whether an error message helps. The tell for a genuinely unreachable case is
that you can name a lookalike which passes the strongest rule you can write.

The older presence-only framing, still correct for regex-graded cases:

- **Clean (presence is a faithful proxy):** markers a plain implementation would
  not spuriously emit - `debugInfo`, `correlationId`, a tracing `span`. Baseline
  omits them; their presence means the technique was applied. Ship these.
- **Over the barrier (presence cannot answer):** a marker with a lookalike the
  regex cannot distinguish. `assert|invariant` matches an input-validation
  `assert` as readily as an internal invariant - and the skill's whole point is
  that those are different. `class \w*Error` matches a trivial typed error as
  readily as one that names the violated contract and preserves the cause. Here
  presence is ambiguous; the distinction is a judgment.

The decision, per case: ask whether the assertion measures that the behavior
*appeared*, what it *does*, what it *is*, or whether it is *good*. Appeared ->
regex. Does -> execution. Is -> structural. Good -> the model judge (roadmap);
flag it, do not fake it. Forcing any grader across its own barrier is the
false-verdict failure - a green checkmark on a question it never answered.
