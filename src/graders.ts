/** Owns the deterministic grader catalog, mode support, and grader implementations. */
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

type CaseMode = "generation" | "trigger";

interface GradableCase {
  readonly assert?: {
    readonly graders?: readonly GraderName[];
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
  return (evalCase.assert?.graders ?? []).map((name) => graders[name].run(workspace));
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
  const typescriptBinary = packageRequire.resolve("typescript/bin/tsc");
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
