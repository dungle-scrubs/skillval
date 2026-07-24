# Design: evaluating agent instruction files

Status: **design agreed, unimplemented.** Roadmap item in
[README](../../README.md#roadmap).

Extend skillval to audit agent instruction files (`CLAUDE.md`, `AGENTS.md`,
root or nested) with the same arm comparison it already applies to skills, so
instruction rules can be proven load-bearing or flagged as no-ops the way skill
rules are.

## Motivation

The engine is thing-agnostic: "seed a thing, grade behavior with and without it,
call it a no-op when the baseline passes" is not specific to a `SKILL.md`. An
instruction file is just another seedable thing. Instruction files also rot
worse than skills - people accumulate `CLAUDE.md` rules nobody re-tests - so
no-op detection is arguably more valuable here.

## Proven facts

`@import` in `CLAUDE.md` is resolved by the Claude Code harness **before
inference**, mechanically, not by the model choosing to read a file.

Experiment (reproducible): a workspace with `CLAUDE.md` containing only
`@AGENTS.md`, and an `AGENTS.md` containing a single unique passphrase rule. Run
`claude -p` with **every** file-reading tool disallowed
(`Read,Glob,Grep,Bash,Edit,Write,...`). The model returns the passphrase. With
no tool able to open `AGENTS.md`, the only path from file to answer is the
harness inlining the import into the prompt. Confirmed to still hold under a
redirected `CLAUDE_CONFIG_DIR` (the claude adapter's isolation), with credentials
seeded into the clean config dir. A control run in an empty directory returns "I
don't have a passphrase."

Consequence: skillval never needs its own import-expansion logic for seeding. It
seeds the real files and lets each harness resolve them.

**Probed: claude does not read a bare `AGENTS.md` ambiently.** A workspace with
only `AGENTS.md` (no `CLAUDE.md`), run under `claude -p` with file tools blocked,
does not know a rule stated only in `AGENTS.md`. So a rule in `AGENTS.md` reaches
claude only when a sibling `CLAUDE.md` `@import`s it. This means applicability is
**per-executor resolved content**, not a static filename matrix: codex/pi see the
`AGENTS.md` text; claude sees the `CLAUDE.md` text with its `@import`s expanded. An
executor is applicable to a case when its resolved content contains the rule span,
and the arm seeds the reduced file set (the rule removed from its physical home)
and lets the harness resolve - reproducing the real layout, not synthesizing one
file per executor. codex reads `AGENTS.md` natively; pi reads both with `AGENTS.md`
precedence per its resource loader (probe before relying on it).

**Nested composition** is verified the same way. A project with a root `CLAUDE.md`
(rule ROOT) and `packages/api/CLAUDE.md` (rule SUB), run from `packages/api` with
file tools blocked, returns **both** passphrases - the harness layers the ancestor
chain before inference, no file reads. Directionality confirmed by the control:
run from the root, and SUB is UNKNOWN (root known). So nested files scope
**downward only**, which fixes the seeding rule: to evaluate a nested target set
cwd at its directory (it plus ancestors resolve); a root target does not drag in
descendants.

## Decisions

### What is graded: the resolved instruction context

Not the file on disk - the context each executor actually assembles. skillval
seeds the real files into the workspace; each harness resolves them natively:

- **codex / pi** read `AGENTS.md` directly (ambient).
- **claude** reads `CLAUDE.md`; its harness expands `@import` before inference
  (ambient, proven above).

For the common `CLAUDE.md -> @AGENTS.md` pattern (thin pointer, content in
`AGENTS.md`) all executors converge on the same content by their own native path.

Ambient vs agentic is the load-bearing distinction:

- **Ambient / pre-inference / deterministic** -> gradeable; skillval asserts
  load-bearing / no-op verdicts. (`@import`, codex-native `AGENTS.md`.)
- **Agentic / mid-inference / probabilistic** -> not gradeable as ambient;
  skillval never grounds a verdict on a stray read. (A prose "see AGENTS.md" with
  no `@import`; codex happening to open `CLAUDE.md`.) A prose pointer's
  non-resolution is itself a reportable finding, not a silent inclusion.

### Discovery: a new `projects:` config key

Skills and instruction files have different discovery shapes:

- `roots:` - curated **global** skill libraries. Flat, shallow:
  `<root>/<skill>/SKILL.md`. Unchanged.
- `projects:` - **project trees**, deep-scanned (skip `.git`, `node_modules`),
  each hit gated by a sibling `skillval.yml`. A project yields both:
  - **instruction targets**: `CLAUDE.md` / `AGENTS.md` at any depth;
  - **project-scoped skills**: `.claude/skills/*`, `.agents/skills/*`.

The sibling `skillval.yml` is the opt-in gate - scanning a large repo only
surfaces the instruction files and skills you have written cases for, exactly as
a skill library only surfaces dirs that have a `skillval.yml`. No per-file
registration.

**Not supported: a `projects:` entry that is a workspace of nested, independent
git repos** (a parent directory whose children each have their own `.git`, often
gitignored by the parent - e.g. `~/dev/reviewsion` holding `reviewsion-frontend`,
`reviewsion-backend`, ... each a separate repo). A `projects:` entry is a single
project pointed at deliberately; evaluate each real repo from its own root. The
walk deliberately does **not** detect nested-repo boundaries, honor gitignore, or
fan a workspace out into sub-projects. Rationale: what an agent harness actually
loads is cwd-dependent and does not flatten a whole tree, and single-rule ablation
holds ancestor context constant across its arms (so it cancels out of the
within-file verdict), which means the nested-workspace question changes no v1
result - it only adds a footgun. Pointing at a workspace-of-repos yields a
cross-repo jumble; that is user error, not a case skillval handles. Deep recursion
inside one repo (internal packages with their own `AGENTS.md` and no nested `.git`)
is fully supported and is the intended use.

A file's **location is its visibility declaration** - it is how the harness
decides which sessions see it. skillval honors visibility by reproducing the tree
and setting cwd, rather than reimplementing any of it.

Target IDs come from tree position: `myapp:.` (root), `myapp:packages/api`
(nested). A `CLAUDE.md` + `AGENTS.md` pair at one location is **one** target,
graded as whatever each executor resolves. A top-level `target: instructions` in
the case file disambiguates the rare directory holding both a `SKILL.md` and
instruction files.

### Arms: in-project by default for `projects:` items

Anything discovered via `projects:` defaults to **group mode** (`solo` / `group`
/ `peers`), because a project's own skills plus its resolved instruction context
are the actual runtime co-occurrence set - the highest-fidelity context in which
to ask "is this rule pulling weight *here*." Global `roots:` skills stay in solo
mode (`solo` / `baseline`). An explicit override can isolate a project item.

### Loadout: instructions ambient, skills are the set

The loadout has two parts and only one is a choice:

- **Instructions are ambient**, not members - the resolved `CLAUDE.md`/`AGENTS.md`
  context is always present in every arm. Never in the array.
- **Skills are the variable part** - which project (or global) skills co-occur
  with the target. That is what the loadout expresses.

Config, progressive disclosure:

```yaml
projects:
  - ~/dev/myapp                    # string form: loadout = all of myapp's own
                                   #   project skills (+ instructions, always)

  - path: ~/dev/monorepo           # object form: only these skills co-occur
    loadout: [commit-style, lint]  #   (project-local or global skill names,
                                   #    or a named top-level loadout)
```

The object-form `loadout:` is the same concept as the existing top-level
`loadouts:` map, scoped to a project and auto-populatable - not a second
mechanism. **v1 ships string-form auto-derive only**; add the object override the
first time a real monorepo needs it.

### Ablation grain: single-rule (v1)

The v1 bar is **single-rule** ablation, not whole-file. Whole-file (present vs
absent) rides existing `solo`/`baseline` and needs no rule boundaries, but it can
only prove *the file* is load-bearing and cannot find intra-file redundancy - the
rule made dead weight by another rule in the same file - which is the primary
reason to audit a bloated instruction file. Single-rule finds it.

Single-rule ablation **is group mode**, no new arm semantics. Map a rule R inside
a file to the existing arms:

- `solo` = R alone (a file containing only R)
- `group` = the full file (R plus its sibling rules - R's in-file loadout)
- `peers` = the full file minus R

The existing group-mode verdict table applies unchanged:

| Arms | Verdict for rule R |
| --- | --- |
| `group` pass, `peers` **fail** | load-bearing - R is needed here |
| `group` pass, `peers` **pass** | **redundant** - another rule already covers it |
| `solo` pass, `group` **fail** | R interferes with the other rules |
| `solo` fail, `peers` pass | R not needed at all |

All three arms derive **mechanically from one authored atom: the rule's span.**
`solo` = span-only file, `peers` = file-with-span-removed, `group` = original.
The runner reuses group mode wholesale.

#### Rule spans: content-addressed snippet

The case pins R's boundaries so the runner can produce "file minus R." Decision:
**content-addressed snippet**, not in-file anchors.

- The case stores R's verbatim text; `peers` strips that substring from the file.
  No modification to the real `CLAUDE.md`/`AGENTS.md` - it audits files as they
  are, which is the whole point.
- Fail-loud: if the file is edited and the snippet no longer matches (or matches
  more than once), that is a clean validation error, not silent drift.
- Cost: the snippet duplicates file content, so editing the rule means updating
  the case. The authoring skill regenerates it.
- Anchors-in-file were rejected: they force structure onto the user's file, which
  contradicts auditing real files as-is.

The rule lives in one physical file (usually `AGENTS.md`); the snippet is stripped
there, and claude still receives the reduced file via `@import`, codex directly.
The existing `rule:` field is the stable id; a new field carries the span text.

#### Authoring skill: accelerant, not a hard gate

Single-rule needs the span *mechanism* in the runner, but a human can hand-author
a case with the rule snippet - tediously. **Decision: the assisted-authoring skill
is an immediate fast-follow, not v1.** Land and prove the runner's single-rule arms
on hand-authored cases first, then build the skill against a working target. When
built, its guardrail: a model-drafted `must_match` can encode what the model
already does (a baked-in no-op), so the skill drafts and the first run's
`peers`/`baseline` arm is the check - flag "may already be innate, confirm it is a
real preference."

### Executor applicability

Applicability is a function of `(target x executor)`, derivable with no new
config because each executor already declares what it reads
(codex/pi -> `AGENTS.md` + `.agents/skills`; claude -> `CLAUDE.md` + `@import` +
`.claude/skills`). A target visible only in `CLAUDE.md` is applicable to
`{claude}`.

A non-applicable executor yields a distinct **`n/a`** status - never a pass,
fail, or silent drop. "Skipped: not visible to codex" must read differently from
"skipped: errored." This is not tolerating a gap: a `CLAUDE.md`-only rule does
not deterministically exist in codex's context, so there is nothing to grade.
`n/a` also protects against contamination - a codex stray-read of `CLAUDE.md`
cannot manufacture a false load-bearing claim because that comparison never runs.

Flip side, reported as a **portability observation**, not an error: "this rule is
only visible to the claude executor." For the common `@AGENTS.md` pattern it never
fires; when it does, it is telling the author a rule they think is universal is
claude-scoped.

### Cache identity

Instruction targets hash their **resolved file set** (target + ancestors +
loadout members), analogous to a skill's content hash. Landing the arm semantics
requires a **runner-version bump** (invalidates cached results), per AGENTS.md.

### Naming

No terminology change. `solo` and `group` are the intentional **mode** pair
(isolation vs within-a-set). `loadout` is the **set** group mode runs against - a
different layer. A project *defines a loadout*; project-discovered items default
to *group mode* against it.

## Open edges

- **Rule-boundary quality.** The runner mechanism is decided (content-addressed
  snippet, see Ablation grain). What stays subjective is *proposing good
  boundaries* - one rule per case, neither too coarse nor split mid-thought. That
  is the assisted-authoring skill's quality bar, not a runner concern; the
  human-ratified `skillval.yml` is the source of truth either way.
- **Monorepo per-subtree loadouts.** A single per-project array cannot express
  `packages/api` vs `packages/web` having different active skill sets. Per-target
  override or path-keyed loadouts is a clean v2 addition; the string/object form
  degrades into it.
- **Seeding `CLAUDE.md` into codex/pi workspaces.** Fidelity (a real codex
  session would have the file present and could read it) vs determinism (stripping
  it makes "codex does not see CLAUDE.md" deterministically true). Bounded by
  `n/a`: a stray read cannot produce a false verdict. Lean: seed the real tree
  as-is, let `n/a` protect. Not a v1 gate.

## Terminology (ablation)

**Ablation** = remove one component, measure what changes; the delta is that
component's contribution. skillval already ablates: the `baseline` arm ablates
the whole skill, the `peers` arm ablates one skill from a loadout. "File-minus-
rule" is ablation at rule grain. Ablation is the mechanism beneath the
load-bearing / no-op verdict.

## Sequencing

**v1 (runner):**

- `projects:` discovery (string-form loadout auto-derive only); instruction
  targets + project-scoped skills, gated by sibling `skillval.yml`.
- Resolved-context grading: seed the real files, let each harness resolve
  (`@import`, nested cwd). No import/expansion logic in skillval.
- Single-rule ablation via group mode + content-addressed snippet spans.
- Executor applicability with `n/a` status; portability observation.
- Cache identity over the resolved file set + loadout members; runner-version
  bump.
- Schema: `target: instructions` discriminator + rule-span field.

**Immediate fast-follow:** assisted-authoring skill (proposes rule-span cases,
human ratifies, no-op guardrail). Until it lands, cases are hand-authored.

**v2, on demand:** object-form `loadout:` override and monorepo per-subtree
loadouts. Whole-file grain is *not* planned - single-rule supersedes it.

## Review findings to resolve before activating instruction evaluation

An independent review of the slice-2 core (executor seam + decision core) raised these.
The ablation-core findings are fixed; the executor-layer findings block wiring the run path
(slice 3), because that layer is currently inert (nothing calls `seedInstruction` or the
applicability matrix yet).

Fixed (ablate.ts): overlapping-occurrence uniqueness, verbatim span (no trimming, so authored
indentation is part of the content address), and removal that changes only the span (no global
blank-line rewrite).

Open, must resolve in slice 3:

1. **Applicability matrix needs empirical verification.** The current
   `claude=[AGENTS.md,CLAUDE.md]`, `codex/pi=[AGENTS.md]` matrix asserts harness behavior that is
   unproven. Review claims claude does not ambiently read a bare `AGENTS.md` (needs `CLAUDE.md` or an
   import) and that pi reads both with `AGENTS.md` precedence. Probe each (as with `@import` and
   nesting) and set the matrix to measured native visibility; do not translate one filename into
   another when seeding, or an arm grades content the executor would not see in the real project.
2. **pi trial isolation.** pi inherits the real environment with no HOME/config redirection, so a
   user-global `AGENTS.md`/`CLAUDE.md` can contaminate an instruction arm (a global rule duplicating
   the target can make `peers` pass and misreport redundancy), and that global file is not in the
   cache identity. Redirect pi's agent/config directory to an isolated trial dir, as codex and claude
   already do.
3. **Seeding drops the target's filename and tree location.** `seededInstruction` carries only
   content and every adapter writes a fixed root file. This is an accepted v1 simplification for the
   single-rule verdict (ancestors are ambient and cancel across arms - see the not-supported scope
   note), but v2 cross-file work must carry the source filename and relative path, reproduce the
   ancestor tree, and launch from the target directory.

## README changes required when this ships

The feature touches these README sections (move the roadmap bullet to documented
behavior once landed):

- **Intro** - broaden "evaluates Agent Skills" to include agent instruction files.
- **Group mode** - loadout may be auto-derived from a project; project-discovered
  items default to group mode; loadout members are skills, instructions ambient.
- **Configuration** - document `projects:` (deep scan, sibling-`skillval.yml`
  gate, project-scoped skill discovery); contrast with `roots:`; string vs object
  `loadout:` form.
- **Case files** - `target: instructions` discriminator; instruction targets carry
  a sibling `skillval.yml`; the rule-span field (content-addressed snippet) that
  drives single-rule ablation; instruction-file arm semantics (group mode).
- **Executors** - each executor's instruction resolution (codex/pi native
  `AGENTS.md`; claude `CLAUDE.md` + `@import` expanded pre-inference); workspace
  seeding of instruction files; executor applicability and the `n/a` status; the
  `CLAUDE.md`-in-codex-workspace seeding choice.
- **Cache** - resolved-file-set hashing for instruction targets and loadout
  members; runner-version bump note.
- **Trust model** - instruction files are inert Markdown (no shell), but their
  `skillval.yml` still runs graders at the same trust level.
- **`skillval list`** - now enumerates instruction targets and project skills with
  their tree-position IDs and per-executor applicability.
- **Roadmap** - replace the instruction-files bullet with documented behavior; add
  the assisted-authoring skill (and optional `skillval init` skeleton) as their
  own item.
