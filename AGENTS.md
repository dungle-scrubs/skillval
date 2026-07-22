# AGENTS.md

Guidance for AI coding agents working in this repository.

## What skillval is

An open-source CLI that evaluates agent skills (agentskills.io SKILL.md
format) with deterministic graders - no model judges. Each case runs a
skill arm (skill discoverable) and optionally a baseline arm (no skill);
comparing them measures whether the skill CHANGES model behavior. A case
whose baseline passes flags its rule as a no-op (prune candidate). The
README owns all user-facing documentation; this file owns contributor and
agent guidance.

## Architecture

- `src/cli.ts` - Commander entry: `skillval run`, `skillval list`. Every
  data-emitting command supports `--json`.
- `src/executors/` - executors are an interface (one trial -> trace);
  `codex` is the only implementation (spawns `codex exec --json`, parses
  the JSONL trace). Trigger detection and baseline mechanics are
  executor-specific and documented in the README's Executors section.
- `src/grade.ts` - deterministic graders: trace completeness, trigger
  check, regex must_match / must_not_match, strict-tsc compile of
  produced files (typescript + @types/node resolved from skillval's own
  install, never the cwd).
- `src/cache.ts` - arm results keyed by runner version + skill content
  hash + case JSON + arm + executor version + model + thinking level
  (+ fixture hash when a fixture is used), under
  `$XDG_STATE_HOME/skillval` (default `~/.local/state/skillval`).
- `src/config.ts` - `$XDG_CONFIG_HOME/skillval/config.yml`
  (default `~/.config/skillval/config.yml`), `SKILLVAL_CONFIG` env
  override, `--config` flag over both. No `~/.skillval` dotdir.
- `src/discovery.ts` - a skill is evaluatable when `skillval.yml` sits
  beside its SKILL.md. JSON Schemas for config and case files live in
  `schemas/`.

## Conventions

- Toolchain: pnpm (pinned via `packageManager`), tsup builds the CLI,
  `tsc --noEmit` typechecks, Biome lints/formats, Lefthook pre-commit,
  vitest for pure-logic unit tests only (never tests that spawn codex).
- TypeScript: strict + `noUncheckedIndexedAccess`; no `any` (use
  `unknown` and narrow); `import type` for types; alphabetized object
  properties; explicit return types on top-level functions.
- Never use em dashes in any file; use "-".
- Semantics are load-bearing: arms, majority-vote trials with escalation,
  check shapes, cache keying, and the no-op definition are proven by
  downstream case suites. Do not change their behavior without bumping
  the runner version constant (invalidates all cached results) and
  saying so in the commit message.
- Case-file and config parsing must fail gracefully per skill (a clean
  error naming the file), never a raw stack trace.

## Verification

```bash
pnpm typecheck && pnpm lint && pnpm schema:check && pnpm test && pnpm build
```

End-to-end runs spawn the `codex` CLI and cost real trials - smoke with a
single case (`skillval run <skill> --case <id>`) rather than full suites.

## Release

Published as `@dungle-scrubs/skillval` (binary `skillval`), MIT. Keep
README's Roadmap section current when landing roadmap items.
