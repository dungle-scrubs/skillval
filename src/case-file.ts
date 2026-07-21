import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { Arm, CaseAssert, EvalCase, SkillEvals } from "./types.js";
import { isRecord } from "./utils.js";

export class CaseFileError extends Error {
  public readonly code: string;

  public constructor(message: string, code = "CASE_FILE_INVALID") {
    super(message);
    this.code = code;
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

  if (!isRecord(parsed)) {
    throw new CaseFileError(`${path} must contain a YAML mapping`);
  }
  const skill = nonEmptyString(parsed.skill, `${path} skill must be a non-empty string`);
  if (expectedSkill !== undefined && skill !== expectedSkill) {
    throw new CaseFileError(`${path} declares skill "${skill}", expected "${expectedSkill}"`);
  }
  if (parsed.class !== "preference" && parsed.class !== "capability") {
    throw new CaseFileError(`${path} class must be "preference" or "capability"`);
  }
  if (!Array.isArray(parsed.cases)) {
    throw new CaseFileError(`${path} cases must be an array`);
  }

  const ids = new Set<string>();
  const cases = parsed.cases.map((value, index) => parseCase(value, index, path, ids));
  return { cases, class: parsed.class, skill };
}

function parseCase(value: unknown, index: number, path: string, ids: Set<string>): EvalCase {
  if (!isRecord(value)) {
    throw new CaseFileError(`${path} case at index ${index} must be a mapping`);
  }
  const id = nonEmptyString(value.id, `${path} case at index ${index} must have a non-empty id`);
  if (ids.has(id)) throw new CaseFileError(`${path} case id "${id}" is duplicated`);
  ids.add(id);

  if (value.mode !== "trigger" && value.mode !== "generation") {
    throw new CaseFileError(`${path} case "${id}" mode must be "trigger" or "generation"`);
  }
  const prompt = nonEmptyString(value.prompt, `${path} case "${id}" must have a non-empty prompt`);
  const arms = value.arms === undefined ? undefined : parseArms(value.arms, path, id);
  const assertion = value.assert === undefined ? undefined : parseAssertion(value.assert, path, id);
  const rule = optionalString(value.rule, `${path} case "${id}" rule must be a string`);
  const shouldTrigger = optionalBoolean(
    value.should_trigger,
    `${path} case "${id}" should_trigger must be a boolean`,
  );
  const trials = parseTrials(value.trials, path, id);
  const type = parseType(value.type, path, id);

  return {
    ...(arms === undefined ? {} : { arms }),
    ...(assertion === undefined ? {} : { assert: assertion }),
    id,
    mode: value.mode,
    prompt,
    ...(rule === undefined ? {} : { rule }),
    ...(shouldTrigger === undefined ? {} : { should_trigger: shouldTrigger }),
    ...(trials === undefined ? {} : { trials }),
    ...(type === undefined ? {} : { type }),
  };
}

function parseArms(value: unknown, path: string, id: string): readonly Arm[] {
  if (!Array.isArray(value) || value.some((arm) => arm !== "skill" && arm !== "baseline")) {
    throw new CaseFileError(`${path} case "${id}" arms must contain only "skill" or "baseline"`);
  }
  return value;
}

function parseAssertion(value: unknown, path: string, id: string): CaseAssert {
  if (!isRecord(value)) {
    throw new CaseFileError(`${path} case "${id}" assert must be a mapping`);
  }
  const graders = optionalStringArray(
    value.graders,
    `${path} case "${id}" assert.graders must be an array of strings`,
  );
  const mustMatch = optionalRegexArray(value.must_match, path, id, "must_match");
  const mustNotMatch = optionalRegexArray(value.must_not_match, path, id, "must_not_match");
  return {
    ...(graders === undefined ? {} : { graders }),
    ...(mustMatch === undefined ? {} : { must_match: mustMatch }),
    ...(mustNotMatch === undefined ? {} : { must_not_match: mustNotMatch }),
  };
}

function optionalRegexArray(
  value: unknown,
  path: string,
  id: string,
  field: "must_match" | "must_not_match",
): readonly string[] | undefined {
  const patterns = optionalStringArray(
    value,
    `${path} case "${id}" assert.${field} must be an array of strings`,
  );
  for (const pattern of patterns ?? []) {
    try {
      new RegExp(pattern, "m");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new CaseFileError(
        `${path} case "${id}" has invalid ${field} regex "${pattern}": ${detail}`,
      );
    }
  }
  return patterns;
}

function optionalStringArray(value: unknown, message: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new CaseFileError(message);
  }
  return value;
}

function parseTrials(value: unknown, path: string, id: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 5) {
    throw new CaseFileError(`${path} case "${id}" trials must be an integer from 1 through 5`);
  }
  return Number(value);
}

function parseType(
  value: unknown,
  path: string,
  id: string,
): "capability" | "preference" | undefined {
  if (value === undefined) return undefined;
  if (value !== "capability" && value !== "preference") {
    throw new CaseFileError(`${path} case "${id}" type must be "preference" or "capability"`);
  }
  return value;
}

function optionalBoolean(value: unknown, message: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new CaseFileError(message);
  return value;
}

function optionalString(value: unknown, message: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new CaseFileError(message);
  return value;
}

function nonEmptyString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CaseFileError(message);
  }
  return value;
}
