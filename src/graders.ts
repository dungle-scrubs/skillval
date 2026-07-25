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
import { dirname, extname, join, resolve, sep } from "node:path";
import { Lang, parse } from "@ast-grep/napi";
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
        "Shell command run in the workspace; the grader passes when it exits as expected. Trusted case input: this is arbitrary shell executed on the grading machine (see the README's Trust model section).",
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

// The ast grader decides STRUCTURAL facts about a produced file - where code sits and what it
// references - that regex cannot see and black-box execution cannot always separate (the
// validation-assert vs invariant-assert lookalike). Each entry is an ast-grep rule object
// (pattern / kind / regex / inside / has / all / any / not), evaluated against the parsed file:
// every must_match rule needs at least one match; any must_not_match match fails with the
// offending line. Pure parsing on the grading machine - no shell, so no --allow-shell gate.
export const astGraderSchema = Type.ReadonlyObject(
  Type.Object({
    file: Type.String({
      description: "Produced file, relative to the workspace, parsed for structural matching.",
      minLength: 1,
      pattern: String.raw`\S`,
    }),
    must_match: Type.Optional(
      Type.Readonly(
        Type.Array(Type.Record(Type.String(), Type.Unknown()), {
          description: "ast-grep rule objects that must each match at least once.",
          minItems: 1,
        }),
      ),
    ),
    must_not_match: Type.Optional(
      Type.Readonly(
        Type.Array(Type.Record(Type.String(), Type.Unknown()), {
          description: "ast-grep rule objects that must match nowhere.",
          minItems: 1,
        }),
      ),
    ),
  }),
  { additionalProperties: false },
);

export type AstGraderConfig = Static<typeof astGraderSchema>;

// The ast grader supports only generation cases, mirroring the produced-file graders.
export const AST_GRADER_MODES: readonly CaseMode[] = ["generation"];

interface GradableCase {
  readonly assert?: {
    readonly ast?: AstGraderConfig;
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
  // Graders run least-mutating first: ast and json_schema only read, command_exit may write, and
  // gradeTsc injects package.json/tsconfig.json. Reading produced files before any grader can
  // rewrite them keeps a combined case deterministic.
  if (evalCase.assert?.ast !== undefined) {
    checks.push(gradeAst(workspace, evalCase.assert.ast));
  }
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

// Languages the ast grader parses, by produced-file extension - aligned with ast-grep's own
// extension table (jsx belongs to the JavaScript grammar, which parses JSX; tsx has its own).
// An unsupported extension is a clean failure at case-load time, never a crash.
const AST_LANGUAGES: Readonly<Record<string, Lang>> = {
  ".cjs": Lang.JavaScript,
  ".css": Lang.Css,
  ".cts": Lang.TypeScript,
  ".htm": Lang.Html,
  ".html": Lang.Html,
  ".js": Lang.JavaScript,
  ".jsx": Lang.JavaScript,
  ".mjs": Lang.JavaScript,
  ".mts": Lang.TypeScript,
  ".ts": Lang.TypeScript,
  ".tsx": Lang.Tsx,
  ".xhtml": Lang.Html,
};

// Inference reads the AUTHORED file path, so what the case says is what gets parsed - the
// realpath target is used only for containment and reading.
export function astLanguageFor(file: string): Lang | undefined {
  return AST_LANGUAGES[extname(file).toLowerCase()];
}

// Case parsing calls this so an unusable rule is a case-authoring error surfaced before any paid
// trial, mirroring jsonSchemaCompileError. ast-grep validates rule structure eagerly, so probing
// a one-character source exercises the full rule compiler.
export function astRuleError(file: string, rule: Record<string, unknown>): string | null {
  const language = astLanguageFor(file);
  if (language === undefined) {
    return `unsupported file extension for ast grading: ${file}`;
  }
  try {
    parse(language, "x")
      .root()
      .find({ rule } as never);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// Beyond this size, parsing and matching stop being cheap deterministic checks; produced files a
// case should grade structurally are orders of magnitude smaller.
const AST_MAX_FILE_BYTES = 5 * 1024 * 1024;

function gradeAst(workspace: string, config: AstGraderConfig): GraderCheck {
  const workspaceRoot = safeRealpath(resolve(workspace));
  if (workspaceRoot === null) {
    return { detail: "workspace not found", name: "ast", pass: false };
  }
  // Same containment discipline as json_schema: realpath resolves symlinks so a link pointing
  // outside the workspace is rejected rather than silently followed.
  const target = safeRealpath(resolve(workspaceRoot, config.file));
  if (target === null) {
    return { detail: `file not found: ${config.file}`, name: "ast", pass: false };
  }
  if (target !== workspaceRoot && !target.startsWith(workspaceRoot + sep)) {
    return { detail: `file escapes workspace: ${config.file}`, name: "ast", pass: false };
  }
  const stats = safeLstat(target);
  if (stats === null || !stats.isFile()) {
    return { detail: `not a regular file: ${config.file}`, name: "ast", pass: false };
  }
  if (stats.size > AST_MAX_FILE_BYTES) {
    return {
      detail: `file too large for ast grading (${stats.size} bytes > ${AST_MAX_FILE_BYTES}): ${config.file}`,
      name: "ast",
      pass: false,
    };
  }
  const language = astLanguageFor(config.file);
  if (language === undefined) {
    return {
      detail: `unsupported file extension for ast grading: ${config.file}`,
      name: "ast",
      pass: false,
    };
  }
  const source = readFileSync(target, "utf8");
  let root: ReturnType<ReturnType<typeof parse>["root"]>;
  try {
    root = parse(language, source).root();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { detail: `failed to parse ${config.file}: ${message}`, name: "ast", pass: false };
  }
  const find = (rule: Record<string, unknown>, label: string) => {
    try {
      return root.find({ rule } as never);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`invalid ast rule (${label}): ${message}`);
    }
  };
  try {
    // tree-sitter recovers from syntax errors instead of throwing, leaving ERROR nodes in the
    // tree. A tree with errors must fail: a forbidden-only case would otherwise pass against
    // garbage simply because the prohibited structure did not survive parsing. (Limitation:
    // recovery can also INSERT missing nodes without an ERROR node; structural grading assumes
    // parseable output, and pairing with tsc closes the remainder for TypeScript.)
    const parseError = find({ kind: "ERROR" }, "syntax check");
    if (parseError !== null) {
      const line = parseError.range().start.line + 1;
      return {
        detail: `${config.file} does not parse (syntax error at line ${line}); structural rules were not evaluated | got: ${source.slice(0, 400)}`,
        name: "ast",
        pass: false,
      };
    }
    for (const [index, rule] of (config.must_match ?? []).entries()) {
      if (find(rule, `must_match[${index}]`) === null) {
        // Carry a got: excerpt of what was actually parsed, mirroring the regex checks - without
        // it, an unmatched rule against a deleted workspace is undiagnosable from the report.
        return {
          detail: `ast must_match[${index}] matched nothing: ${JSON.stringify(rule).slice(0, 200)} | got: ${source.slice(0, 400)}`,
          name: "ast",
          pass: false,
        };
      }
    }
    for (const [index, rule] of (config.must_not_match ?? []).entries()) {
      const first = find(rule, `must_not_match[${index}]`);
      if (first !== null) {
        const line = first.range().start.line + 1;
        return {
          detail: `ast must_not_match[${index}] matched at ${config.file}:${line}: ${first.text().slice(0, 120)}`,
          name: "ast",
          pass: false,
        };
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { detail: message, name: "ast", pass: false };
  }
  return {
    detail: `${config.file} satisfies ${(config.must_match?.length ?? 0) + (config.must_not_match?.length ?? 0)} structural rule(s)`,
    name: "ast",
    pass: true,
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
