/** Adapts YAML case files into values validated by the executable case contract. */
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { CaseContractError, parseCaseValue } from "./case-contract.js";
import { walkFixtureEntries } from "./fixture.js";
import type { Fixture, SkillEvals } from "./types.js";

export class CaseFileError extends CaseContractError {
  public constructor(message: string, code = "CASE_FILE_INVALID") {
    super(message, code);
    this.name = "CaseFileError";
  }
}

export function readCaseFile(path: string, expectedSkill?: string): SkillEvals {
  const evals = parseCaseFile(readFileSync(path, "utf8"), path, expectedSkill);
  // Fixture directories are validated here, not in the pure contract, because only the reader
  // knows where the case file actually lives on disk.
  const baseDirectory = dirname(path);
  assertFixtureDirectory(evals.fixture, `${path} suite fixture`, baseDirectory);
  for (const evalCase of evals.cases) {
    assertFixtureDirectory(
      evalCase.fixture,
      `${path} case "${evalCase.id}" fixture`,
      baseDirectory,
    );
  }
  return evals;
}

function assertFixtureDirectory(
  fixture: Fixture | undefined,
  subject: string,
  baseDirectory: string,
): void {
  if (fixture?.path === undefined) return;
  const directory = join(baseDirectory, fixture.path);
  const stats = statSync(directory, { throwIfNoEntry: false });
  if (stats === undefined) {
    throw new CaseFileError(
      `${subject} path "${fixture.path}" does not exist`,
      "CASE_FIXTURE_INVALID",
    );
  }
  if (!stats.isDirectory()) {
    throw new CaseFileError(
      `${subject} path "${fixture.path}" is not a directory`,
      "CASE_FIXTURE_INVALID",
    );
  }
  try {
    walkFixtureEntries(directory);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CaseFileError(`${subject} path "${fixture.path}" ${detail}`, "CASE_FIXTURE_INVALID");
  }
}

export function parseCaseFile(
  source: string,
  path = "skillval.yml",
  expectedSkill?: string,
): SkillEvals {
  let parsed: unknown;
  try {
    parsed = parseYaml(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CaseFileError(`${path} YAML is invalid: ${detail}`, "CASE_FILE_YAML_INVALID");
  }

  try {
    return parseCaseValue(parsed, path, expectedSkill);
  } catch (error) {
    if (error instanceof CaseContractError) {
      throw new CaseFileError(error.message, error.code);
    }
    throw error;
  }
}
