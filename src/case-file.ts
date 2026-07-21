/** Adapts YAML case files into values validated by the executable case contract. */
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { CaseContractError, parseCaseValue } from "./case-contract.js";
import type { SkillEvals } from "./types.js";

export class CaseFileError extends CaseContractError {
  public constructor(message: string, code = "CASE_FILE_INVALID") {
    super(message, code);
    this.name = "CaseFileError";
  }
}

export function readCaseFile(path: string, expectedSkill?: string): SkillEvals {
  return parseCaseFile(readFileSync(path, "utf8"), path, expectedSkill);
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
