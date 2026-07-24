/** Defines the configuration contract shared by runtime validation and generated JSON Schema. */
import type { Static } from "typebox";
import Type from "typebox";
import { EXECUTOR_NAMES } from "./executors/index.js";

export const configFileSchema = Type.ReadonlyObject(
  Type.Object({
    // Names come from the executor registry so configuration cannot advertise a missing adapter.
    executor: Type.Enum(EXECUTOR_NAMES, {
      description: "Trial executor.",
    }),
    // Write a self-contained HTML report beside the JSON one after each run, and open it. Enabled
    // when omitted; set false to keep runs headless (CI, scripted use).
    htmlReport: Type.Optional(
      Type.Boolean({
        description:
          "Write and open a self-contained HTML report after each run. Enabled when omitted.",
      }),
    ),
    // Named skill sets for loadout mode: each maps a loadout name to the skill names it contains.
    loadouts: Type.Optional(
      Type.Record(
        Type.String(),
        Type.Readonly(
          Type.Array(Type.String({ minLength: 1, pattern: String.raw`\S` }), { uniqueItems: true }),
        ),
        {
          description: "Named skill sets: loadout name to the skill names it contains.",
        },
      ),
    ),
    projects: Type.Optional(
      Type.Readonly(
        Type.Array(Type.String({ minLength: 1, pattern: String.raw`\S` }), {
          description:
            "Project trees scanned recursively for CLAUDE.md/AGENTS.md and project-scoped skills that carry a sibling skillval.yml.",
        }),
      ),
    ),
    roots: Type.Readonly(
      Type.Array(Type.String({ minLength: 1, pattern: String.raw`\S` }), {
        description: "Directories whose immediate children are agent skill directories.",
      }),
    ),
  }),
  {
    $id: "https://raw.githubusercontent.com/dungle-scrubs/skillval/main/schemas/config.schema.json",
    $schema: "https://json-schema.org/draft/2020-12/schema",
    additionalProperties: false,
    title: "skillval configuration",
  },
);

export type ConfigFile = Static<typeof configFileSchema>;
