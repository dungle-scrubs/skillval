# Security Policy

## Supported versions

Only the latest release receives security fixes.

## Reporting a vulnerability

Report vulnerabilities privately via
[GitHub security advisories](https://github.com/dungle-scrubs/skillval/security/advisories/new).
Do not open a public issue for security reports.

Include the skillval version, a reproduction, and the impact you
believe it has. You should receive a response within a week.

## Scope notes

skillval spawns the `codex` CLI and compiles model-produced TypeScript
with the bundled `tsc`. Generation cases run in a `workspace-write`
sandbox and trigger cases in a read-only sandbox; issues that escape
those sandboxes are in scope and worth reporting.
