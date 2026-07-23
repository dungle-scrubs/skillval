/** Owns the deterministic grader catalog, mode support, and grader implementations. */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import type { AnySchema, ValidateFunction } from "ajv/dist/2020.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { Static } from "typebox";
import Type from "typebox";

type CaseMode = "generation" | "trigger";

// The json_schema grader is parameterized, so its config schema lives here beside the grader and
// is imported by the case contract, keeping graders.ts the single owner of grader behavior.
export const jsonSchemaGraderSchema = Type.ReadonlyObject(
  Type.Object({
    file: Type.String({
      description: "Produced file, relative to the workspace, parsed as JSON and validated.",
      minLength: 1,
      pattern: String.raw`\S`,
    }),
    schema: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Boolean()], {
      description:
        "JSON Schema (draft 2020-12) the produced file must satisfy; an object or a boolean schema. Omit $schema, or set it to 2020-12; other declared dialects are rejected.",
    }),
  }),
  { additionalProperties: false },
);

export type JsonSchemaGraderConfig = Static<typeof jsonSchemaGraderSchema>;

// The json_schema grader supports only generation cases, mirroring the produced-file graders.
export const JSON_SCHEMA_GRADER_MODES: readonly CaseMode[] = ["generation"];

// The command_exit grader runs a case-authored command in the workspace and grades on exit code.
// The command comes from the case file, the same trust level as fixture setup commands.
export const commandExitGraderSchema = Type.ReadonlyObject(
  Type.Object({
    command: Type.String({
      description:
        "Shell command run in the workspace; the grader passes when it exits as expected.",
      minLength: 1,
      pattern: String.raw`\S`,
    }),
    expect: Type.Optional(
      Type.Integer({
        description: "Exit code the command must produce to pass. Defaults to 0.",
        maximum: 255,
        minimum: 0,
      }),
    ),
  }),
  { additionalProperties: false },
);

export type CommandExitGraderConfig = Static<typeof commandExitGraderSchema>;

// The command_exit grader supports only generation cases, mirroring the produced-file graders.
export const COMMAND_EXIT_GRADER_MODES: readonly CaseMode[] = ["generation"];

interface GradableCase {
  readonly assert?: {
    readonly command_exit?: CommandExitGraderConfig;
    readonly graders?: readonly GraderName[];
    readonly json_schema?: JsonSchemaGraderConfig;
  };
}

interface GraderCheck {
  readonly detail: string;
  readonly name: string;
  readonly pass: boolean;
}

interface Grader {
  readonly modes: readonly CaseMode[];
  run(workspace: string): GraderCheck;
}

const packageRequire = createRequire(import.meta.url);
// This registry is the sole source of grader names, supported modes, and implementations.
const graders = {
  tsc: {
    modes: ["generation"],
    run: gradeTsc,
  },
} satisfies Readonly<Record<string, Grader>>;

export type GraderName = keyof typeof graders;
// The case contract derives its allowed grader values from the registry keys.
export const GRADER_NAMES = Object.keys(graders) as GraderName[];

export function graderSupportsMode(name: GraderName, mode: CaseMode): boolean {
  const modes: readonly CaseMode[] = graders[name].modes;
  return modes.includes(mode);
}

export function runGraders(evalCase: GradableCase, workspace: string): readonly GraderCheck[] {
  const checks: GraderCheck[] = [];
  // Graders run least-mutating first: json_schema only reads, command_exit may write, and gradeTsc
  // injects package.json/tsconfig.json. Reading produced files before any grader can rewrite them
  // keeps a combined case deterministic.
  if (evalCase.assert?.json_schema !== undefined) {
    checks.push(gradeJsonSchema(workspace, evalCase.assert.json_schema));
  }
  if (evalCase.assert?.command_exit !== undefined) {
    checks.push(gradeCommandExit(workspace, evalCase.assert.command_exit));
  }
  for (const name of evalCase.assert?.graders ?? []) {
    checks.push(graders[name].run(workspace));
  }
  return checks;
}

const COMMAND_EXIT_TIMEOUT_MS = 120_000;

function gradeCommandExit(workspace: string, config: CommandExitGraderConfig): GraderCheck {
  const expected = config.expect ?? 0;
  // Minimal environment and SIGKILL on timeout mirror fixture setup: nothing inherited beyond PATH,
  // a throwaway HOME, and a hard kill because SIGTERM is trappable and would let a hang run forever.
  // A large maxBuffer keeps a verbose compiler or test runner from being killed with ENOBUFS, which
  // would fail the check regardless of exit code. Like fixture setup, a timed-out command that
  // spawned background descendants may leave them running; grading commands are trusted case input.
  const outcome = spawnSync(config.command, {
    cwd: workspace,
    encoding: "utf8",
    env: { HOME: workspace, PATH: process.env.PATH ?? "" },
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024 * 1024,
    shell: true,
    timeout: COMMAND_EXIT_TIMEOUT_MS,
  });
  if (outcome.error !== undefined) {
    const timedOut = (outcome.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    const reason = timedOut
      ? `timed out after ${COMMAND_EXIT_TIMEOUT_MS / 1000}s`
      : outcome.error.message;
    return {
      detail: `command "${config.command}" failed to run: ${reason}`,
      name: "command_exit",
      pass: false,
    };
  }
  if (outcome.signal !== null) {
    return {
      detail: `command "${config.command}" terminated by ${outcome.signal}`,
      name: "command_exit",
      pass: false,
    };
  }
  if (outcome.status === expected) {
    return {
      detail: `command "${config.command}" exited ${expected}`,
      name: "command_exit",
      pass: true,
    };
  }
  const stderr = outcome.stderr === "" ? "" : `: ${outcome.stderr.slice(0, 300)}`;
  return {
    detail: `command "${config.command}" exited ${outcome.status}, expected ${expected}${stderr}`,
    name: "command_exit",
    pass: false,
  };
}

type CompileResult = { ok: true; validate: ValidateFunction } | { message: string; ok: false };

// A fresh instance per call keeps grading deterministic and avoids $id collisions across cases.
// Ajv2020 validates draft 2020-12 schemas (a superset of the older keywords authors commonly use).
function compileSchema(schema: unknown): CompileResult {
  try {
    const ajv = new Ajv2020({ allErrors: false, strict: false });
    return { ok: true, validate: ajv.compile(schema as AnySchema) };
  } catch (error) {
    return { message: error instanceof Error ? error.message : String(error), ok: false };
  }
}

// Case parsing calls this so an unusable schema is a case-authoring error, not a paid trial failure.
export function jsonSchemaCompileError(schema: unknown): string | null {
  const result = compileSchema(schema);
  return result.ok ? null : result.message;
}

function safeRealpath(target: string): string | null {
  try {
    return realpathSync(target);
  } catch {
    return null;
  }
}

function safeLstat(target: string): Stats | null {
  try {
    return lstatSync(target);
  } catch {
    return null;
  }
}

function gradeJsonSchema(workspace: string, config: JsonSchemaGraderConfig): GraderCheck {
  const workspaceRoot = safeRealpath(resolve(workspace));
  if (workspaceRoot === null) {
    return { detail: "workspace not found", name: "json_schema", pass: false };
  }
  // realpath resolves every symlink in the path, so a symlinked target or a symlinked parent
  // directory pointing outside the workspace is caught by the containment check below rather than
  // silently followed. safeRealpath returns null for a missing path or a broken symlink.
  const target = safeRealpath(resolve(workspaceRoot, config.file));
  if (target === null) {
    return { detail: `file not found: ${config.file}`, name: "json_schema", pass: false };
  }
  if (target !== workspaceRoot && !target.startsWith(workspaceRoot + sep)) {
    return { detail: `file escapes workspace: ${config.file}`, name: "json_schema", pass: false };
  }
  // The real path has no remaining symlinks; reject anything that is not a regular file (a FIFO or
  // device would otherwise block readFileSync indefinitely).
  const stats = safeLstat(target);
  if (stats === null || !stats.isFile()) {
    return { detail: `not a regular file: ${config.file}`, name: "json_schema", pass: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(target, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      detail: `invalid JSON in ${config.file}: ${message}`,
      name: "json_schema",
      pass: false,
    };
  }
  const compiled = compileSchema(config.schema);
  if (!compiled.ok) {
    return { detail: `invalid json_schema: ${compiled.message}`, name: "json_schema", pass: false };
  }
  if (compiled.validate(parsed)) {
    return { detail: `${config.file} matches schema`, name: "json_schema", pass: true };
  }
  const first = compiled.validate.errors?.[0];
  const location =
    first?.instancePath === undefined || first.instancePath === "" ? "(root)" : first.instancePath;
  return {
    detail: `${config.file} ${location} ${first?.message ?? "does not match schema"}`,
    name: "json_schema",
    pass: false,
  };
}

function gradeTsc(workspace: string): GraderCheck {
  if (!existsSync(join(workspace, "package.json"))) {
    writeFileSync(join(workspace, "package.json"), '{ "type": "module" }\n');
  }
  const nodeTypesDirectory = dirname(packageRequire.resolve("@types/node/package.json"));
  writeFileSync(
    join(workspace, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        lib: ["es2023"],
        module: "esnext",
        moduleResolution: "bundler",
        noEmit: true,
        noUncheckedIndexedAccess: true,
        strict: true,
        target: "es2023",
        typeRoots: [dirname(nodeTypesDirectory)],
        types: ["node"],
      },
    }),
  );
  // TypeScript 7 stopped exporting ./bin/tsc, so resolve the package root and join to the bin.
  const typescriptBinary = join(
    dirname(packageRequire.resolve("typescript/package.json")),
    "bin",
    "tsc",
  );
  const result = spawnSync(typescriptBinary, ["-p", workspace], {
    encoding: "utf8",
    timeout: 120_000,
  });
  return {
    detail: result.status === 0 ? "compiles strict" : (result.stdout ?? "").slice(0, 500),
    name: "tsc",
    pass: result.status === 0,
  };
}
