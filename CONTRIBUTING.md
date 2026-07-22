# Contributing

Thanks for contributing to skillval.

## Setup

Requires Node.js >= 22 and pnpm 10 (pinned via `packageManager`). On
Node 22 or 24, `corepack enable` is enough; Node 25+ no longer ships
Corepack, so install pnpm directly (`npm install -g pnpm@10`).

```bash
pnpm install
```

## Verification

Every change must pass the full gate locally; CI runs the same chain on
every pull request:

```bash
pnpm typecheck && pnpm lint && pnpm schema:check && pnpm test && pnpm build
```

Unit tests are pure-logic only (vitest). Never add tests that spawn the
`codex` CLI - end-to-end runs cost real trials. Smoke-test executor
changes manually with a single case:
`skillval run <skill> --case <id>`.

## Commits and releases

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):
`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`. Releases are
automated with release-please - `feat` and `fix` commits drive version
bumps and the changelog, so write messages for the changelog reader.

Semantics are load-bearing: arms, majority-vote trials with escalation,
check shapes, cache keying, and the no-op definition are proven by
downstream case suites. Do not change their behavior without bumping
`RUNNER_VERSION` in `src/cache.ts` (invalidates all cached results) and
saying so in the commit message. See [AGENTS.md](AGENTS.md) for the full
contributor conventions.

## Pull requests

- Branch from `main`; direct pushes to `main` are blocked.
- PRs are squash-merged, so the PR title should itself be a conventional
  commit message.
- CI must pass before merge.
