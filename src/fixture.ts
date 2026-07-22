/** Prepares trial workspaces from case fixtures: content copy, setup commands, identity hashing. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Fixture } from "./case-contract.js";
import type { FixtureCommandResult } from "./types.js";
import { SKIPPED_DIRECTORIES } from "./utils.js";

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

interface FixtureEntry {
  readonly absolutePath: string;
  readonly executable: boolean;
  readonly path: string;
  readonly type: "directory" | "file";
}

/**
 * Walks a fixture directory into a deterministic manifest, rejecting symlinks and special files.
 * Symlinks are refused because a copied link can resolve back into the source fixture and let
 * setup commands mutate it; links belong in setup commands instead.
 */
export function walkFixtureEntries(directory: string): FixtureEntry[] {
  const entries: FixtureEntry[] = [];

  function visit(current: string, prefix: string): void {
    const dirents = [...readdirSync(current, { withFileTypes: true })].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const dirent of dirents) {
      if (SKIPPED_DIRECTORIES.has(dirent.name)) continue;
      const absolutePath = join(current, dirent.name);
      const path = prefix === "" ? dirent.name : `${prefix}/${dirent.name}`;
      if (dirent.isSymbolicLink()) {
        throw new Error(
          `contains unsupported symlink "${path}"; create links with setup commands instead`,
        );
      }
      if (dirent.isDirectory()) {
        entries.push({ absolutePath, executable: false, path, type: "directory" });
        visit(absolutePath, path);
      } else if (dirent.isFile()) {
        const executable = (statSync(absolutePath).mode & 0o111) !== 0;
        entries.push({ absolutePath, executable, path, type: "file" });
      } else {
        throw new Error(`contains unsupported special file "${path}"`);
      }
    }
  }

  visit(directory, "");
  return entries;
}

export function fixtureIdentityHash(
  directory: string | undefined,
  setup: readonly string[],
): string {
  // Each entry is framed with its type, path, mode, and byte length so file bytes can never
  // masquerade as entry boundaries, and raw bytes are hashed so binary files cannot collide
  // through lossy text decoding.
  const hash = createHash("sha256");
  if (directory !== undefined) {
    for (const entry of walkFixtureEntries(directory)) {
      if (entry.type === "directory") {
        hash.update(`D\0${entry.path}\0`);
        continue;
      }
      const content = readFileSync(entry.absolutePath);
      hash.update(`F\0${entry.path}\0${entry.executable ? "x" : "-"}\0${content.byteLength}\0`);
      hash.update(content);
    }
  }
  hash.update(`S\0${JSON.stringify(setup)}`);
  return hash.digest("hex");
}

export function applyFixture(
  fixture: ResolvedFixture,
  workspace: string,
  home: string,
): readonly FixtureCommandResult[] {
  if (fixture.directory !== undefined) {
    // verbatimSymlinks guards the window between hashing (which rejects symlinks) and copying:
    // a link that appears mid-run is copied inert instead of resolving into the source fixture.
    cpSync(fixture.directory, workspace, {
      filter: (source) => !SKIPPED_DIRECTORIES.has(basename(source)),
      recursive: true,
      verbatimSymlinks: true,
    });
  }

  const results: FixtureCommandResult[] = [];
  for (const command of fixture.setup) {
    // Minimal environment: PATH for tool lookup plus the throwaway trial home, nothing inherited.
    // SIGKILL on timeout because SIGTERM is trappable and would let a hung command run forever.
    const outcome = spawnSync(command, {
      cwd: workspace,
      encoding: "utf8",
      env: { HOME: home, PATH: process.env.PATH ?? "" },
      killSignal: "SIGKILL",
      shell: true,
      timeout: SETUP_COMMAND_TIMEOUT_MS,
    });
    results.push({
      command,
      exitCode: outcome.status,
      signal: outcome.signal ?? null,
      stderr: outcome.stderr ?? "",
      stdout: outcome.stdout ?? "",
    });
    if (outcome.error !== undefined || outcome.status !== 0) {
      const timedOut = (outcome.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
      const reason = timedOut
        ? `timed out after ${SETUP_COMMAND_TIMEOUT_MS / 1000}s`
        : (outcome.error?.message ??
          (outcome.signal !== null
            ? `terminated by ${outcome.signal}`
            : `exit code ${outcome.status}`));
      throw new FixtureSetupError(`fixture setup failed: "${command}" (${reason})`, results);
    }
  }
  return results;
}
