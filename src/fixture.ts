/** Prepares trial workspaces from case fixtures: content copy, setup commands, identity hashing. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { Fixture } from "./case-contract.js";
import type { FixtureCommandResult } from "./types.js";
import { SKIPPED_DIRECTORIES, walkFiles } from "./utils.js";

// Setup commands are workspace staging (git init, file moves), not agent work; a minute is ample.
const SETUP_COMMAND_TIMEOUT_MS = 60_000;

export interface ResolvedFixture {
  readonly directory: string | undefined;
  readonly hash: string;
  readonly setup: readonly string[];
}

export class FixtureSetupError extends Error {
  public readonly results: readonly FixtureCommandResult[];

  public constructor(message: string, results: readonly FixtureCommandResult[]) {
    super(message);
    this.name = "FixtureSetupError";
    this.results = results;
  }
}

export function selectFixture(
  caseFixture: Fixture | undefined,
  suiteFixture: Fixture | undefined,
): Fixture | undefined {
  // A per-case fixture replaces the suite default entirely; path and setup never merge.
  return caseFixture ?? suiteFixture;
}

export function resolveFixture(
  fixture: Fixture | undefined,
  baseDirectory: string,
): ResolvedFixture | undefined {
  if (fixture === undefined) return undefined;
  const directory = fixture.path === undefined ? undefined : join(baseDirectory, fixture.path);
  const setup = fixture.setup ?? [];
  return { directory, hash: fixtureIdentityHash(directory, setup), setup };
}

export function fixtureIdentityHash(
  directory: string | undefined,
  setup: readonly string[],
): string {
  // Hash raw bytes so binary fixture files cannot collide through lossy text decoding.
  const hash = createHash("sha256");
  if (directory !== undefined) {
    for (const file of walkFiles(directory)) {
      hash.update(relative(directory, file));
      hash.update("\0");
      hash.update(readFileSync(file));
      hash.update("\0");
    }
  }
  hash.update(JSON.stringify(setup));
  return hash.digest("hex");
}

export function applyFixture(
  fixture: ResolvedFixture,
  workspace: string,
  home: string,
): readonly FixtureCommandResult[] {
  if (fixture.directory !== undefined) {
    cpSync(fixture.directory, workspace, {
      filter: (source) => !SKIPPED_DIRECTORIES.has(basename(source)),
      recursive: true,
    });
  }

  const results: FixtureCommandResult[] = [];
  for (const command of fixture.setup) {
    // Minimal environment: PATH for tool lookup plus the throwaway trial home, nothing inherited.
    const outcome = spawnSync(command, {
      cwd: workspace,
      encoding: "utf8",
      env: { HOME: home, PATH: process.env.PATH ?? "" },
      shell: true,
      timeout: SETUP_COMMAND_TIMEOUT_MS,
    });
    results.push({
      command,
      exitCode: outcome.status,
      stderr: outcome.stderr ?? "",
      stdout: outcome.stdout ?? "",
    });
    if (outcome.error !== undefined || outcome.status !== 0) {
      const reason = outcome.error?.message ?? `exit code ${outcome.status ?? "signal"}`;
      throw new FixtureSetupError(`fixture setup failed: "${command}" (${reason})`, results);
    }
  }
  return results;
}
