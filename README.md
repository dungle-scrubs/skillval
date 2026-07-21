# skillval

`skillval` evaluates [Agent Skills](https://agentskills.io/) with deterministic graders and no
model judges. Each case can run a skill arm and a baseline arm, measuring whether a skill changes
agent behavior instead of merely checking whether the final answer looks acceptable. When the
baseline also passes, the rule is flagged as a no-op and a possible prune candidate. You can only
trust what you test.

## Install

```sh
pnpm add -g @dungle-scrubs/skillval
```

Node.js 22 or newer is required. The Codex CLI must be installed and authenticated for evaluation
runs. Discovery with `skillval list` does not invoke Codex.

## Quickstart

Create `~/.config/skillval/config.yml`:

```yaml
roots:
  - ~/dev/agent-skills
executor: codex
```

Given `~/dev/agent-skills/typescript-style/SKILL.md`, add
`~/dev/agent-skills/typescript-style/skillval.yml`:

```yaml
skill: typescript-style
class: preference
cases:
  - id: prefer-const-object
    mode: generation
    type: preference
    rule: enums-as-const
    arms: [skill, baseline]
    prompt: >-
      Create sizes.ts with a fixed set of small, medium, and large values.
    assert:
      must_match: ["as const"]
      must_not_match: ["\\benum\\s"]
      graders: [tsc]
    trials: 1
```

Run the case:

```console
$ skillval run typescript-style
typescript-style (preference, e8342aa91a17):
  prefer-const-object [skill] ...
  prefer-const-object [skill] pass
  prefer-const-object [baseline] ...
  prefer-const-object [baseline] FAIL
report: /Users/example/.local/state/skillval/reports/0f47c8d4....json
all cases passed
```

Run every discovered skill that has a `skillval.yml` by omitting the skill names. Use `--case <id>`
to select one case, `--no-cache` to ignore cached arm results, `--skip-baseline` to omit baseline
arms, and `--json` for the complete report. The command exits with status 1 when any selected
case's skill arm fails.

## Configuration

The configuration follows the [configuration JSON Schema](schemas/config.schema.json):

```yaml
roots:
  - ~/dev/skills/skills/standards
  - $HOME/dev/shared/skills/backend
executor: codex
```

`roots` contains directories whose immediate children have the form `<skill>/SKILL.md`. Both `~`
and `$HOME` are expanded. Missing roots are skipped during `run`; `list` returns them in
`missingRoots` with JSON output and prints each as `missing root: <path>` in human output.

Configuration path precedence is:

1. `--config <path>`
2. `SKILLVAL_CONFIG`
3. `$XDG_CONFIG_HOME/skillval/config.yml`
4. `~/.config/skillval/config.yml`

There is no legacy `~/.skillval` lookup. State uses `$XDG_STATE_HOME/skillval`, or
`~/.local/state/skillval` when `XDG_STATE_HOME` is unset:

- `cache/` stores arm results.
- `reports/` stores run reports named by a hash of the participating skills and their content
  hashes. Each report also includes every participating skill's content hash.

`skillval list` returns the skill name, configured root, class, case count, and whether
`skillval.yml` exists. Discovery only requires `SKILL.md`; evaluation additionally requires
`skillval.yml`.

## Case files

Only a file named `skillval.yml` next to `SKILL.md` is recognized. There is no `evals.yml`
fallback. The complete format is described by the
[case-file JSON Schema](schemas/skillval.schema.json).

Top-level fields:

- `skill`: the directory and skill name.
- `class`: `preference` or `capability`.
- `cases`: an array of deterministic evaluation cases.

Case fields:

- `id`: unique case identifier.
- `mode`: `trigger` grades the final agent message; `generation` grades files produced in the
  temporary workspace.
- `type`: optional `preference` or `capability` classification.
- `rule`: optional stable rule identifier included in reports.
- `should_trigger`: optional expected invocation verdict. It is checked only on the skill arm.
- `arms`: `skill`, or `skill` and `baseline`. The default is `[skill]`.
- `prompt`: the complete trial prompt.
- `assert.must_match`: JavaScript regular expressions that must match, with the `m` flag.
- `assert.must_not_match`: JavaScript regular expressions that must not match, with the `m` flag.
- `assert.graders`: deterministic graders. `tsc` is currently supported for generation cases.
- `trials`: an integer from 1 through 5. Results use a strict majority. If configured trials
  disagree, the arm escalates to 5 trials.

Every trial must also contain a complete executor trace. For generation cases, regex assertions
see only produced files, prefixed with `=== filename ===`; prose cannot satisfy a file assertion.
The `tsc` grader injects a module package file when needed and a strict bundler-resolution
TypeScript configuration, then runs the TypeScript installation shipped with `skillval`.

## Executors

Executors are adapters with two responsibilities: report stable metadata for cache keys and run
one trial request to return a normalized `Trace`. The runner owns temporary workspaces, skill
seeding, grading, caching, majority voting, and reports. `codex` is the only adapter today.

The Codex adapter runs:

```text
codex exec --json --skip-git-repo-check --ephemeral -s <sandbox> -C <workspace> <prompt>
```

Trigger cases use a read-only sandbox. Generation cases use `workspace-write`. Codex has no
dedicated skill-invocation event, so invocation is detected when a `command_execution` command
contains `<skill>/SKILL.md`. The skill arm always receives a workspace-local
`.agents/skills/<name>` symlink to the evaluated skill.

Baseline arms are not seeded. Their `HOME` points to an empty temporary directory so globally
installed skills are invisible, while `CODEX_HOME` still points to the user's real `~/.codex` for
authentication and model configuration. A Claude executor is planned.

Cached arm results are keyed by runner version, skill content hash, serialized case, arm, Codex
version, and configured Codex model. A trial has a 15-minute timeout and a 64 MB output buffer.

## Roadmap

- Add a Claude executor, then support multi-executor runs through the same normalized trace
  interface.
- Run multiple models and emit per-model reports. A passing binding or trigger result on a weaker
  tier is a conservative bound for stronger tiers. Baseline no-op results remain model-specific,
  and a rule is a prune candidate only when every model in normal use passes at baseline.
- Add workspace fixtures for audit-style skills that need realistic repositories or document
  trees.
- Add contested-boundary cases with `expect_invoked` and `expect_not_invoked` outcomes.
- Include the discovered skill-listing hash in trigger-case invalidation so description changes in
  neighboring skills invalidate affected results.
- Add cheap trigger simulations for broad description coverage before expensive executor trials.
- Add a `lint` subcommand for Agent Skills format, references, case coverage, and regular
  expressions.
- Harvest missed triggers, false invocations, and behavioral regressions from real session
  transcripts as new cases.
- Support multi-model interpretation and no-op pruning in report summaries, not only raw reports.
