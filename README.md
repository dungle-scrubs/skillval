# skillval

`skillval` evaluates [Agent Skills](https://agentskills.io/) with deterministic graders and no
model judges. Each case can run a `solo` arm (the skill alone) and a `baseline` arm (no skill),
measuring whether a skill changes agent behavior instead of merely checking whether the final
answer looks acceptable. When the baseline also passes, the rule is flagged as a no-op and a
possible prune candidate. You can only trust what you test.

Both arms run in a clean environment - your globally installed skills are hidden - so the only
variable is whether the skill under test is present. `solo` seeds just that skill; `baseline` seeds
nothing.

## Capability and preference rules

A skill carries two kinds of rules. **Capability** rules teach a model something it does not yet
reliably do. **Preference** rules express a choice - style, convention, house taste - a model would not reach on its own. Most skills mix both. The distinction matters because capabilities expire: as models are trained on the same information, a capability rule stops changing behavior and turns into dead weight. skillval finds those.

Each case runs with the skill (`solo`) and again without it (`baseline`). Solo-pass with
baseline-fail means the rule is load-bearing. Solo-pass with baseline-pass means the model already
does this on its own - the rule is a prune candidate. Preferences stay; stale capabilities go.
Cases can record which kind they exercise with the `type` field (`capability` or `preference`).

### Reading a result

- **`solo` pass, `baseline` fail** - the skill is doing the work; it changed behavior. Load-bearing.
- **`solo` pass, `baseline` pass** - the case passes with or without the skill; the model already
  does this. A no-op and a prune candidate.
- **`solo` fail** - the skill did not produce the required behavior. A failing case to investigate.

`should_trigger`, when set, is checked only on arms where the skill under test is present (`solo`),
never on `baseline`, where it is absent by design.

## Group mode

Solo mode measures a skill in isolation - the skill alone versus nothing. Group mode measures its
marginal effect **inside a set of other skills**, which is closer to how skills are used in
practice, and it surfaces interference that isolation cannot see.

Define named loadouts in the configuration, then pass `--loadout <name>`:

```yaml
# config.yml
loadouts:
  everyday: [commit-style, naming, imports]
```

```sh
skillval run typescript-style --loadout everyday
```

Group mode runs three arms per case (ignoring the case's `arms` field, since the verdict needs all
three): `solo` (the target alone), `group` (the loadout plus the target), and `peers` (the loadout
minus the target). Every arm runs clean, differing only by its seeded set. Loadout members must be
discovered skills; they only need a `SKILL.md`, not a `skillval.yml`. If a member name matches more
than one discovered skill (the same name under two roots), the first match wins and the run prints a
`warning:` line naming what was used and what was shadowed. The verdict per case:

| Arms | Verdict |
| --- | --- |
| `solo` pass, `group` **fail**, `peers` pass | **interferes with your other skills** |
| `group` pass, `peers` fail | **works and is needed here** (load-bearing) |
| `group` pass, `peers` pass | **redundant** - another skill already does it |
| `solo` fail, `peers` pass | **not needed at all** |

The raw three arm results stay in the report; the verdict is a derived `loadout` block. Any other
combination is reported as `inconclusive`. `should_trigger` is checked on `solo` and `group` (the
target is present) but never on `peers`. The run summary calls out interference, the way it calls
out no-ops.

Interference is only attributed to the target when the target's presence is what breaks the case:
`solo` passes, `group` fails, and `peers` (the loadout minus the target) still passes. If `peers`
also fails, the loadout breaks the case without the target at all, so the finding is about the other
skills, not this one - that is left `inconclusive` rather than blamed on the target. (A pure
trigger-only case has no behavioral check on `peers`, so `solo`-vs-`group` still isolates the target
and interference stands.)

The `redundant` / `load-bearing` / `not needed` verdicts compare `group` against `peers`, so they
need an assertion that grades behavior on the `peers` arm (a `must_match`, grader, and so on). A
pure trigger-only case - `should_trigger` and nothing else - has no such check on `peers` (the
trigger check is target-specific), so it is reported `inconclusive` unless it shows interference.

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
    arms: [solo, baseline]
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
case's solo arm fails.

Use `--model <model>` and `--effort <level>` to pin the executor's model and effort for the run,
so you can evaluate one skill under, for example, `--model sonnet --effort medium`. Both pass
through to the configured executor and are recorded in the report and the cache identity, so runs
at different levels are cached and compared separately. Effort levels are executor-specific and
validated before the run: `codex` accepts `none, minimal, low, medium, high, xhigh, max`; `claude`
accepts `low, medium, high, xhigh, max`; `pi` accepts `off, minimal, low, medium, high, xhigh`.
Model support for a given effort is a subset of these, enforced by the harness itself.

## Configuration

The configuration follows the [configuration JSON Schema](schemas/config.schema.json):

```yaml
roots:
  - ~/dev/skills/skills/standards
  - $HOME/dev/shared/skills/backend
executor: codex
```

`roots` contains directories whose immediate children have the form `<skill>/SKILL.md`. Both `~`
and `$HOME` are expanded. `executor` selects the trial adapter: `codex`, `claude`, or `pi`. Missing roots are skipped during `run`; `list` returns them in
`missingRoots` with JSON output and prints each as `missing root: <path>` in human output.

`loadouts` (optional) defines named skill sets for [group mode](#group-mode): a map from a loadout
name to the discovered skill names it contains. Select one with `--loadout <name>`.

Configuration path precedence is:

1. `--config <path>`
2. `SKILLVAL_CONFIG`
3. `$XDG_CONFIG_HOME/skillval/config.yml`
4. `~/.config/skillval/config.yml`

There is no legacy `~/.skillval` lookup. State uses `$XDG_STATE_HOME/skillval`, or
`~/.local/state/skillval` when `XDG_STATE_HOME` is unset:

- `cache/` stores arm results.
- `reports/` stores run reports named by a hash of the participating skills and their content
  hashes. Each report also includes every participating skill's content hash and the executor's
  name, version, model, thinking-level identity, and invocation-detection method.

`skillval list` returns the skill name, configured root, class, case count, whether `skillval.yml`
exists, and a `missing`, `invalid`, or `ready` status in JSON output. Invalid case files include a
validation error. Discovery only requires `SKILL.md`; evaluation requires a valid `skillval.yml`.

## Trust model

A `skillval.yml` is executable input, not passive configuration. Two fields run case-authored
shell commands directly on the machine that grades the suite:

- fixture `setup` commands, before the trial's agent runs;
- `assert.command_exit`, at grading time.

Both run with a minimal environment - only `PATH` is inherited, and `HOME` points at a throwaway
trial directory - and are killed on timeout, but that is scoping, not a sandbox: nothing prevents
a command from reading or writing anything your user account can reach. Evaluating a skill
therefore means trusting its `skillval.yml` exactly as you would trust running its Makefile or
npm scripts.

Because of that, case-authored shell is **off by default**. A run refuses any selected case that
carries fixture `setup` commands or a `command_exit` grader, failing before any trial spawns with a
message naming the skill, case, and surface. Pass `--allow-shell` to opt in once you have reviewed
the case file. Keeping it off by default means pointing skillval at a skill from a repository you do
not control never runs that skill's shell unless you explicitly allow it - the safe default for CI
and for auditing third-party skills.

The agent trials themselves are a separate boundary, sandboxed per executor (see
[Executors](#executors)): codex trials get an OS sandbox, claude trials get permission modes, and
pi generation trials have no sandbox at all and must be acknowledged with
`--allow-unsandboxed-pi`.

## Case files

Only a file named `skillval.yml` next to `SKILL.md` is recognized. There is no `evals.yml`
fallback. The complete format is described by the
[case-file JSON Schema](schemas/skillval.schema.json).
The published configuration and case-file schemas are generated from the same executable TypeBox
contracts used for runtime validation. Contributors can regenerate them with `pnpm schema` and
check freshness with `pnpm schema:check`.

Top-level fields:

- `skill`: the directory and skill name.
- `class`: `preference` or `capability`.
- `cases`: an array of deterministic evaluation cases.
- `fixture`: optional suite-wide workspace fixture applied to every case that does not declare
  its own. See [Fixtures](#fixtures).

Case fields:

- `id`: unique case identifier.
- `mode`: `trigger` grades the final agent message; `generation` grades files produced in the
  temporary workspace.
- `type`: optional `preference` or `capability` classification.
- `rule`: optional stable rule identifier included in reports.
- `should_trigger`: optional expected invocation verdict. It is checked only on arms where the skill under test is present (`solo`).
- `arms`: `solo`, or `solo` and `baseline`. The default is `[solo]`.
- `prompt`: the complete trial prompt.
- `assert.must_match`: JavaScript regular expressions that must match, with the `m` flag.
- `assert.must_not_match`: JavaScript regular expressions that must not match, with the `m` flag.
- `assert.graders`: parameterless deterministic graders. `tsc` is supported for generation cases.
  Unknown graders and graders used with an unsupported mode are validation errors.
- `assert.json_schema`: validates a produced file against a JSON Schema (draft 2020-12), for
  generation cases. Takes `file` (relative to the workspace) and `schema` (the JSON Schema, an
  object or boolean). The file must exist inside the workspace, be a regular file, and parse as
  JSON; a schema mismatch reports the failing instance path. Omit `$schema` or set it to 2020-12;
  other declared dialects, an escaping `file` path, or a schema that does not compile are validation
  errors.
- `assert.command_exit`: runs a shell command in the workspace and passes when it exits with the
  expected code, for generation cases. Takes `command` and optional `expect` (default `0`). The
  command is case-authored arbitrary shell, the same trust level as fixture `setup`, and is off by
  default: a case using it is refused unless the run passes `--allow-shell` (see
  [Trust model](#trust-model)). It runs with a minimal environment and is killed after
  120 seconds. This is the language-agnostic grader: run a
  compiler, test runner, or validator over produced files in any language. Used in a non-generation
  case it is a validation error.
- `trials`: an integer from 1 through 5. Results use a strict majority. If configured trials
  disagree, the arm escalates to 5 trials.
- `fixture`: optional workspace fixture for this case. It replaces the suite-level `fixture`
  entirely; `path` and `setup` never merge across levels.

Every trial must also contain a complete executor trace. For generation cases, regex assertions
see only produced files, prefixed with `=== filename ===`; prose cannot satisfy a file assertion.
The `tsc` grader injects a module package file when needed and a strict bundler-resolution
TypeScript configuration, then runs the TypeScript installation shipped with `skillval`.

## Fixtures

By default every trial starts in an empty temporary workspace. A fixture populates that workspace
before the trial runs, for cases that need a realistic repository or document tree. A fixture has
two fields, and at least one is required:

- `path`: a directory relative to `skillval.yml`, copied recursively into the workspace before
  the trial. `.git` and `node_modules` directories are never copied. The path must exist and be a
  directory, and it may not contain symbolic links (create links with `setup` commands instead);
  anything else is a validation error at load time.
- `setup`: shell commands run sequentially inside the workspace after the copy, with a minimal
  environment (`PATH` plus a throwaway `HOME`). These are case-authored arbitrary shell commands
  executed on the grading machine and are off by default: a case whose fixture carries `setup` is
  refused unless the run passes `--allow-shell` (see [Trust model](#trust-model)). A non-zero exit
  fails the trial with a `fixture-setup` error before the agent runs; it is never a grading failure.
  Each command's stdout and stderr are captured into the trial record.

A suite-level `fixture` applies to every case; a case-level `fixture` replaces it entirely.
Fixture directory contents and setup commands are part of the arm cache identity, so editing a
fixture file or a setup command invalidates cached results for the cases that use it.

Generation-mode regex assertions read every workspace file except `.git` and `node_modules`
contents and the injected `package.json`/`tsconfig.json`, so fixture files are graded alongside
anything the agent produced. Graders access the workspace directly (`tsc` compiles what it finds
there). Write `must_match` patterns against the state you expect after the agent acts, not only
against new files.

Nested `.git` directories inside a fixture are not supported. Express git state with `setup`
commands instead - this example stages a merge conflict for the agent to resolve:

```yaml
skill: resolve-conflicts
class: capability
cases:
  - id: merge-conflict
    mode: generation
    prompt: Resolve the merge conflict in notes.md, keeping both sections.
    assert:
      must_not_match: ["^<{7} ", "^={7}$", "^>{7} "]
    fixture:
      path: fixtures/notes-repo
      setup:
        - git init -q -b main
        - git config user.name fixture && git config user.email fixture@skillval.invalid
        - git add -A && git commit -qm base
        - git switch -qc feature
        - printf 'feature section\n' >> notes.md && git commit -qam feature
        - git switch -q main
        - printf 'main section\n' >> notes.md && git commit -qam main
        - git merge feature || true
```

The final `|| true` matters: `git merge` exits non-zero on conflict, which would otherwise fail
the trial as a fixture-setup error - here the conflict is the point.

## Executors

Executors are adapters with three responsibilities: report stable metadata for cache keys, prepare
provider-specific skill and environment state, and run one trial request to return a normalized
`Trace`. The runner owns temporary workspace lifecycle, grading, caching, majority voting, and
reports. Three adapters exist: `codex`, `claude`, and `pi`.

The Codex adapter runs:

```text
codex exec --json --skip-git-repo-check --ephemeral -s <sandbox> -C <workspace> <prompt>
```

Trigger cases use a read-only sandbox. Generation cases use `workspace-write`. Codex has no
dedicated skill-invocation event, so its adapter detects invocation when a `command_execution`
command contains `<skill>/SKILL.md`. Each arm seeds its own skills as workspace-local
`.agents/skills/<name>` symlinks - the `solo` arm the evaluated skill, the `baseline` arm none.

Every arm runs clean: `HOME` points to an empty temporary directory so `~/.agents/skills` is
invisible, and `CODEX_HOME` points to a per-trial home that symlinks only `config.toml` and
`auth.json` from the real `~/.codex`. Skills, plugins, and plugin-activation state are omitted, so
no globally installed skill leaks in through `CODEX_HOME`. Authentication and model configuration
are unchanged; the only skills the model sees are the ones seeded into the workspace.

The Claude adapter runs Claude Code headlessly:

```text
claude -p <prompt> --output-format stream-json --verbose --no-session-persistence <permissions>
```

with the workspace as the working directory. Trigger cases run
`--permission-mode dontAsk --allowedTools "Read,Glob,Grep,Skill"` - read-only, but the Skill tool
must be allowed or invocation would be blocked before it can be observed. Generation cases run
`--permission-mode acceptEdits`. Invocation is detected from `Skill` tool_use blocks in the
stream-json trace that name the evaluated skill. Every arm points `CLAUDE_CONFIG_DIR` at a clean
directory holding the credentials file and a minimal `settings.json` rebuilt from only the model,
effort, and auth-routing keys - hooks, permissions, plugins, and user skills are omitted, so no
user configuration acts on one arm differently (on macOS credentials live in the Keychain, so
authentication survives; elsewhere the credentials file is copied across). Each arm seeds its own
skills as workspace-local `.claude/skills/<name>` symlinks - the `solo` arm the target, the
`baseline` arm none. The reported model and effort come from the real configuration's
`settings.json` (`model`/`effortLevel`), or `default`.

The pi adapter runs [pi](https://github.com/badlogic/pi-mono) headlessly:

```text
pi -p --mode json --no-session <arm flags> <tool flags> <prompt>
```

with the workspace as the working directory. Every arm passes `--no-skills` to hide the user's
global skill library, plus a repeatable `--skill <directory>` per seeded skill (pi loads explicit
`--skill` paths even under `--no-skills`); the `solo` arm seeds the target, the `baseline` arm
seeds nothing - no HOME or config redirection is involved.
Trigger cases restrict tools with `-t read` (read also loads SKILL.md, so invocation stays
observable); generation cases keep pi's default tool set. pi implements the Agent Skills
progressive-disclosure standard by having the model `read` a listed skill's SKILL.md, so
invocation is detected from `read` toolCalls targeting `<skill>/SKILL.md` in the transcript.
The reported model is `defaultProvider/defaultModel` from `~/.pi/settings.json`. pi resolves
provider API keys from its auth file or environment variables (e.g. `ZAI_API_KEY`) - the key
must be available in the environment running skillval.

Unlike codex (which gets a read-only or `workspace-write` sandbox) and claude (permission modes),
pi has no OS sandbox: generation trials rely on the temporary-workspace convention alone, with no
enforced isolation, so an agent's writes are only conventionally scoped to the workspace. Because
of this, skillval refuses to run pi generation cases unless you pass `--allow-unsandboxed-pi` to
acknowledge the missing sandbox. Trigger cases are read-only and unaffected. Prefer codex or claude
for untrusted generation cases.

Each adapter reports its detection method as `invocationDetection` in report metadata. The
`invoked` signal has asymmetric confidence: claude detects invocation from a structured `Skill`
tool_use block, while codex and pi string-match trace text for `<skill>/SKILL.md`. Trigger rates
should not be compared across executors as if they measured the same thing.

By default, executors do not set a model or thinking/effort level; trials inherit the harness
defaults the user has configured, and each adapter captures both into its identity so results are
always associated with what actually ran: codex reads `model` and `model_reasoning_effort` from
`~/.codex/config.toml`, claude reads `model` and `effort` from `settings.json`, and pi reads
`defaultProvider/defaultModel` and `defaultThinkingLevel` from `~/.pi/settings.json`. A missing
value is recorded as `default` (the provider's own default applies). Passing `--model`/`--effort`
overrides the default for the run, and the override is what gets captured. Changing any of these -
in the provider configuration or via the flags - therefore keys distinct cached results.

Cached arm results are keyed by runner version, skill content hash, serialized case, arm, executor
name, executor version, configured model, and configured thinking level. A trial has a 15-minute
timeout and a 64 MB output buffer.

## Roadmap

- Support multi-executor runs through the same normalized trace interface, now that `codex` and
  `claude` adapters share it.
- Run multiple models and emit per-model reports. A passing binding or trigger result on a weaker
  tier is a conservative bound for stronger tiers. Baseline no-op results remain model-specific,
  and a rule is a prune candidate only when every model in normal use passes at baseline.
- Add contested-boundary cases with `expect_invoked` and `expect_not_invoked` outcomes.
- Include the discovered skill-listing hash in trigger-case invalidation so description changes in
  neighboring skills invalidate affected results.
- Add cheap trigger simulations for broad description coverage before expensive executor trials.
- Add a `lint` subcommand for Agent Skills format, references, case coverage, and regular
  expressions.
- Evaluate agent instruction files (`CLAUDE.md`, `AGENTS.md`) with the same arm comparison, so
  instruction rules can be proven load-bearing or flagged as no-ops the way skill rules are. The
  shape is undecided: likely instructions-present vs instructions-absent arms over cases derived
  from the file's rules.
- Harvest missed triggers, false invocations, and behavioral regressions from real session
  transcripts as new cases.
- Support multi-model interpretation and no-op pruning in report summaries, not only raw reports.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Commits follow Conventional Commits, PRs are
squash-merged, and every change must pass
`pnpm typecheck && pnpm lint && pnpm schema:check && pnpm test && pnpm build`.

## License

[MIT](LICENSE)
