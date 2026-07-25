# Design: model-as-judge (the quality grader)

Status: proposed. This is the buildable spec behind the roadmap item. It
turns the anchored decision in the `skillval-coverage` skill
(`references/decisions.md`, "The barrier: presence, not quality") into a
feature. Read that section first - it defines the exact gap this closes.

## The problem it solves

Every grader skillval has today measures **presence**: a regex over produced
files (generation) or agent text (trigger), a `tsc` compile, a JSON-schema
shape, a command exit code. Presence is a faithful proxy right up to a
barrier, then it stops being one:

- `class \w*Error` matches a trivial typed error as readily as one that names
  the violated contract and preserves the original cause.
- `assert|invariant` matches an input-validation `assert` as readily as an
  internal invariant - and the skill's whole point is that those differ.

At the barrier the question is no longer "did the behavior *appear*" but "is
it *good / correct / distinct from its lookalike*." That is a judgment, and a
regex forced across it is a false verdict: a green checkmark on a question it
never answered. skillval has ~111 catalogued gaps sitting on the far side of
this barrier with no coverage possible today.

## What it is (and is not)

A `judge` is an **opt-in, per-case** grader that asks a model a single
yes/no question about the graded output. It is not a new default and it does
not replace deterministic grading:

- The headline stays "deterministic by default." The judge never runs unless
  a case explicitly declares `assert.judge`. A repo with no `judge:` blocks
  behaves exactly as today and pays for zero model calls.
- Deterministic and judge asserts compose. The common shape is a two-layer
  assert: `must_match` proves the behavior is *present* (cheap, deterministic,
  can fail fast), and `judge` proves it is *correct* (paid, only reached when
  present). Presence gates quality.

## Product decision this requires (owner: Kevin)

The README's pitch is literally "deterministic graders and no model judges."
Shipping a judge changes that sentence. The recommended framing keeps the
promise honest rather than dropping it:

> Deterministic by default - no model judge runs unless a case opts in. An
> explicit, per-case model judge is available for the one dimension a regex
> cannot reach: whether a present behavior is correct, not just present.

Everything below assumes that framing is ratified. If the answer is instead
"keep skillval strictly deterministic, never ship a judge," the whole feature
is dropped and the 111 over-the-barrier gaps stay permanently flagged as
"model judge (roadmap)" - which is a coherent choice, just a different one.

## Case-file surface

```yaml
assert:
  # deterministic gate (optional but recommended): behavior must be present
  must_match: ['class \w*Error']
  # quality judge: behavior must be correct
  judge:
    criterion: >-
      The thrown error type preserves the original cause - it wraps or
      chains the underlying error (via `cause`, a wrapped field, or an
      equivalent) rather than discarding it and rethrowing a bare message.
```

- `criterion` is author-written, one decidable question, phrased so a
  competent reviewer would answer it the same way every time. Vague criteria
  ("is this good error handling") are an authoring error the way a can't-fail
  regex is - the coverage skill's gates apply unchanged.
- **generation mode only** for the MVP, validated like `json_schema`. The
  judge reads the same `gradedText` the deterministic graders read: the
  concatenated produced files (injected files excluded). Trigger-mode judging
  (grading agent prose) is a later extension; the barrier gaps are all
  generation-shaped.

## What the judge evaluates

Reuse the existing `gradedText` construction from `grade.ts` verbatim - the
judge and the regex graders must see the *same* surface, or a `must_match`
gate and its `judge` follow-up could disagree about what was produced. Inline
that text into the judge prompt rather than letting the judge re-read the
workspace with tools; inlining removes tool-use variance and makes the call a
pure classification.

## Transport: reuse codex exec, not a new API client

skillval's only model transport is the executor CLIs. Do **not** add a direct
Anthropic/OpenAI HTTP client - that is scope creep and a second auth surface.
The judge is a single read-only classification, so it does not need the full
`Executor` interface (workspace, trigger detection, trace parsing for
tool-use). Ship a thin `judge` module that:

1. Builds a fixed rubric prompt (scaffolding + `criterion` + inlined
   `gradedText`).
2. Runs the configured judge command - default `codex exec -s read-only
   --json` - feeding the prompt on argv/stdin, in a throwaway cwd (it needs no
   workspace; the output is inlined).
3. Parses the final agent message for a strict verdict token (below).

Keep the command pluggable via config so a `claude`-based or other judge can
be dropped in without touching the grader.

## Verdict contract

The rubric instructs the judge to end its reply with exactly one line:

```
VERDICT: PASS
```
or
```
VERDICT: FAIL
reason: <one sentence>
```

- Parse the **last** `VERDICT:` line (models preamble; the last one is the
  committed answer). `PASS` -> check passes; `FAIL` -> check fails with the
  reason as `detail`.
- **No parseable verdict = infrastructure failure, not a content fail.** A
  crashed judge, a timeout, or an unparseable reply is scored exactly like a
  crashed executor in the coverage catalog ("infrastructure recorded as
  grading"): it is retried / outvoted across trials, never recorded as the
  skill failing. Scoring a judge crash as a red skill result would be the same
  false verdict this feature exists to avoid, inverted.

## Rubric stance: conservative by construction

The rubric must tell the judge to:

- Evaluate **only** the stated criterion, ignore everything else about the
  output (style, unrelated correctness).
- Answer strictly and **default to FAIL on ambiguity** - if the criterion is
  not clearly satisfied, it is not satisfied. This mirrors the adversarial
  "default to refuted" stance: a lenient judge manufactures coverage the same
  way a loose regex does.
- Not reward intent or comments - grade what the code does.

## Determinism, voting, and caching

- **Voting is already handled.** The judge runs once per trial, inside the
  existing majority-vote-over-trials-with-escalation machinery. Judge noise is
  smoothed by the same mechanism that smooths executor noise - no new voting
  layer, and `trials` is the knob for a noisy criterion.
- **Caching:** fold a judge-identity component into the arm cache key - judge
  command + judge model/version + a hash of the `criterion`. Editing the
  criterion or changing the judge model must invalidate; re-running an
  unchanged judge must hit cache. Because this changes cache semantics and
  grading behavior, bump `RUNNER_VERSION` 13 -> 14 (invalidates all cached
  results) and say so in the commit, per the AGENTS.md load-bearing-semantics
  rule.

## Self-judge bias

Default the judge model to a strong model independent of the executor under
test (recommend `gpt-5.5`), even when the executor is `codex`. A model judging
its own output is the weakest configuration. Document the caveat; do not hard-
block same-model judging (a user may deliberately want it), but the shipped
default should not be self-judging.

## Cost

Each judge assert adds one paid model call per trial per arm. This is why it
is strictly opt-in and why presence should gate quality (`must_match` fails
fast and free before the judge is reached). Document the cost next to the
`trials` guidance so authors understand a `judge` case with `trials: 5` on two
arms is ten judge calls.

## Build checklist

1. `src/judge.ts` - rubric builder, transport (codex exec), verdict parser,
   `{ pass, detail }` result. Pure functions (prompt build, verdict parse)
   are unit-testable without spawning a model; test those.
2. `case-contract.ts` - `judgeGraderSchema` (`{ criterion: nonEmptyString }`),
   wire into `caseAssertSchema`, `validateJudgeGrader` (generation-only,
   non-empty criterion), regenerate `schemas/`.
3. `graders.ts` / `grade.ts` - invoke the judge after the regex graders, on
   the shared `gradedText`; surface its check with `name: "judge"`.
4. `config.ts` / `config-contract.ts` - `judge: { command?, model? }` block,
   defaults to codex + gpt-5.5.
5. `cache.ts` - add judge identity to the key; bump `RUNNER_VERSION` to 14.
6. `README.md` - amend the thesis sentence per the ratified framing; document
   the `judge` assert, the cost, and the self-judge default.
7. Migrate a real over-the-barrier case as the first consumer and proof:
   `observability` typed-contextual-errors (cause preservation) or the
   invariant-vs-validation distinction.

Routing note: steps 1-5 are load-bearing (a wrong or flaky judge is
silently-wrong behavior on the grading hot path), so they are Claude-authored,
not delegated as mechanical work. Step 6-7 and the schema regen are
mechanical.
