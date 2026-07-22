/** Defines the case-file contract used for static types, runtime validation, and JSON Schema. */
import type { Static } from "typebox";
import Type from "typebox";
import { Check as checkSchema, Errors as schemaErrors } from "typebox/value";
import { GRADER_NAMES, graderSupportsMode } from "./graders.js";

const classificationSchema = Type.Enum(["capability", "preference"]);
const nonEmptyStringSchema = Type.String({ minLength: 1, pattern: String.raw`\S` });
const stringArraySchema = Type.Readonly(Type.Array(Type.String()));
export const armSchema = Type.Enum(["baseline", "skill"]);

// These schemas are executable at runtime and are also serialized into schemas/ for editor tooling.
export const fixtureSchema = Type.ReadonlyObject(
  Type.Object({
    path: Type.Optional(
      Type.String({
        description: "Directory relative to skillval.yml, copied into the workspace.",
        minLength: 1,
        pattern: String.raw`\S`,
      }),
    ),
    setup: Type.Optional(
      Type.Readonly(
        Type.Array(nonEmptyStringSchema, {
          description: "Shell commands run sequentially inside the workspace after the copy.",
        }),
      ),
    ),
  }),
  { additionalProperties: false, minProperties: 1 },
);

export const caseAssertSchema = Type.ReadonlyObject(
  Type.Object({
    graders: Type.Optional(
      Type.Readonly(Type.Array(Type.Enum(GRADER_NAMES), { uniqueItems: true })),
    ),
    must_match: Type.Optional(stringArraySchema),
    must_not_match: Type.Optional(stringArraySchema),
  }),
  { additionalProperties: false },
);

export const evalCaseSchema = Type.ReadonlyObject(
  Type.Object({
    arms: Type.Optional(
      Type.Readonly(
        Type.Array(armSchema, {
          uniqueItems: true,
        }),
      ),
    ),
    assert: Type.Optional(caseAssertSchema),
    fixture: Type.Optional(fixtureSchema),
    id: nonEmptyStringSchema,
    mode: Type.Enum(["generation", "trigger"]),
    prompt: nonEmptyStringSchema,
    rule: Type.Optional(Type.String()),
    should_trigger: Type.Optional(Type.Boolean()),
    trials: Type.Optional(Type.Integer({ maximum: 5, minimum: 1 })),
    type: Type.Optional(classificationSchema),
  }),
  { additionalProperties: false },
);

export const skillEvalsSchema = Type.ReadonlyObject(
  Type.Object({
    cases: Type.Readonly(Type.Array(evalCaseSchema)),
    class: classificationSchema,
    fixture: Type.Optional(fixtureSchema),
    skill: nonEmptyStringSchema,
  }),
  {
    $id: "https://raw.githubusercontent.com/dungle-scrubs/skillval/main/schemas/skillval.schema.json",
    $schema: "https://json-schema.org/draft/2020-12/schema",
    additionalProperties: false,
    title: "skillval case file",
  },
);

export type Arm = Static<typeof armSchema>;
export type CaseAssert = Static<typeof caseAssertSchema>;
export type EvalCase = Static<typeof evalCaseSchema>;
export type Fixture = Static<typeof fixtureSchema>;
export type SkillEvals = Static<typeof skillEvalsSchema>;

export class CaseContractError extends Error {
  public readonly code: string;

  public constructor(message: string, code = "CASE_FILE_INVALID") {
    super(message);
    this.code = code;
    this.name = "CaseContractError";
  }
}

export function parseCaseValue(value: unknown, path: string, expectedSkill?: string): SkillEvals {
  if (!checkSchema(skillEvalsSchema, value)) {
    const [firstError] = schemaErrors(skillEvalsSchema, value);
    const location = firstError?.instancePath.replaceAll("/", ".").replace(/^\./, "");
    if (location?.endsWith(".trials")) {
      const match = /cases\.(\d+)\.trials$/.exec(location);
      const caseIndex = match?.[1] ?? "unknown";
      throw new CaseContractError(
        `${path} case at index ${caseIndex} trials must be an integer from 1 through 5`,
      );
    }
    const subject = location === undefined || location === "" ? path : `${path} ${location}`;
    throw new CaseContractError(`${subject} ${firstError?.message ?? "is invalid"}`);
  }

  if (expectedSkill !== undefined && value.skill !== expectedSkill) {
    throw new CaseContractError(
      `${path} declares skill "${value.skill}", expected "${expectedSkill}"`,
    );
  }

  const ids = new Set<string>();
  for (const evalCase of value.cases) {
    // Semantic rules that depend on sibling cases, JavaScript regex compilation, or runtime
    // registries remain here. Keeping them beside the structural schema preserves one owner.
    if (ids.has(evalCase.id)) {
      throw new CaseContractError(`${path} case id "${evalCase.id}" is duplicated`);
    }
    ids.add(evalCase.id);
    validatePatterns(evalCase, path);
    validateGraders(evalCase, path);
  }
  return value;
}

function validateGraders(evalCase: EvalCase, path: string): void {
  for (const grader of evalCase.assert?.graders ?? []) {
    if (!graderSupportsMode(grader, evalCase.mode)) {
      throw new CaseContractError(
        `${path} case "${evalCase.id}" grader "${grader}" does not support ${evalCase.mode} mode`,
      );
    }
  }
}

function validatePatterns(evalCase: EvalCase, path: string): void {
  const fields = ["must_match", "must_not_match"] as const;
  for (const field of fields) {
    for (const pattern of evalCase.assert?.[field] ?? []) {
      try {
        new RegExp(pattern, "m");
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new CaseContractError(
          `${path} case "${evalCase.id}" has invalid ${field} regex "${pattern}": ${detail}`,
        );
      }
    }
  }
}
