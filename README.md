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
and `$HOME` are expanded. `executor` selects the trial adapter: `codex`, `claude`, or `pi`. Missing roots are skipped during `run`; `list` returns them in
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
  hashes. Each report also includes every participating skill's content hash and the executor's
  name, version, model, and thinking-level identity.

`skillval list` returns the skill name, configured root, class, case count, whether `skillval.yml`
exists, and a `missing`, `invalid`, or `ready` status in JSON output. Invalid case files include a
validation error. Discovery only requires `SKILL.md`; evaluation requires a valid `skillval.yml`.

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
- `should_trigger`: optional expected invocation verdict. It is checked only on the skill arm.
- `arms`: `skill`, or `skill` and `baseline`. The default is `[skill]`.
- `prompt`: the complete trial prompt.
- `assert.must_match`: JavaScript regular expressions that must match, with the `m` flag.
- `assert.must_not_match`: JavaScript regular expressions that must not match, with the `m` flag.
- `assert.graders`: deterministic graders. `tsc` is supported for generation cases. Unknown
  graders and graders used with an unsupported mode are validation errors.
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
  environment (`PATH` plus a throwaway `HOME`). A non-zero exit fails the trial with a
  `fixture-setup` error before the agent runs; it is never a grading failure. Each command's
  stdout and stderr are captured into the trial record.

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
command contains `<skill>/SKILL.md`. The adapter also gives the skill arm a workspace-local
`.agents/skills/<name>` symlink to the evaluated skill.

Baseline arms are not seeded. Their `HOME` points to an empty temporary directory so globally
installed skills are invisible, while `CODEX_HOME` still points to the user's real `~/.codex` for
authentication and model configuration.

The Claude adapter runs Claude Code headlessly:

```text
claude -p <prompt> --output-format stream-json --verbose --no-session-persistence <permissions>
```

with the workspace as the working directory. Trigger cases run
`--permission-mode dontAsk --allowedTools "Read,Glob,Grep,Skill"` - read-only, but the Skill tool
must be allowed or invocation would be blocked before it can be observed. Generation cases run
`--permission-mode acceptEdits`. Invocation is detected from `Skill` tool_use blocks in the
stream-json trace that name the evaluated skill. The skill arm seeds a workspace-local
`.claude/skills/<name>` symlink; the baseline arm points `CLAUDE_CONFIG_DIR` at an empty
temporary directory so user-level skills are invisible (on macOS credentials live in the
Keychain, so authentication survives; elsewhere the credentials file is copied across). The
reported model comes from the real configuration's `settings.json`, or `default`.

The pi adapter runs [pi](https://github.com/badlogic/pi-mono) headlessly:

```text
pi -p --mode json --no-session <arm flags> <tool flags> <prompt>
```

with the workspace as the working directory. pi has first-class arm switches: the skill arm
passes `--skill <directory>` so the evaluated skill is discoverable alongside the user's normal
library, and the baseline arm passes `--no-skills` - no HOME or config redirection is involved.
Trigger cases restrict tools with `-t read` (read also loads SKILL.md, so invocation stays
observable); generation cases keep pi's default tool set. pi implements the Agent Skills
progressive-disclosure standard by having the model `read` a listed skill's SKILL.md, so
invocation is detected from `read` toolCalls targeting `<skill>/SKILL.md` in the transcript.
The reported model is `defaultProvider/defaultModel` from `~/.pi/settings.json`. pi resolves
provider API keys from its auth file or environment variables (e.g. `ZAI_API_KEY`) - the key
must be available in the environment running skillval. Unlike codex, pi has no OS sandbox;
generation trials rely on the temporary workspace convention alone.

Executors never set a model or thinking/effort level; trials inherit the harness defaults the
user has configured. Each adapter captures both into its identity so results are always
associated with what actually ran: codex reads `model` and `model_reasoning_effort` from
`~/.codex/config.toml`, claude reads `model` and `effort` from `settings.json`, and pi reads
`defaultProvider/defaultModel` and `defaultThinkingLevel` from `~/.pi/settings.json`. A missing
value is recorded as `default` (the provider's own default applies). Changing any of these in
the provider configuration therefore invalidates the affected cached results.

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
