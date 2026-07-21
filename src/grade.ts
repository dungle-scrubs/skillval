import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import type { Check, EvalCase, Trace } from "./types.js";
import { walkFiles } from "./utils.js";

const INJECTED_FILES = new Set(["package.json", "tsconfig.json"]);
const packageRequire = createRequire(import.meta.url);

export function gradeTrial(
  evalCase: EvalCase,
  arm: string,
  trace: Trace,
  workspace: string,
): Check[] {
  const checks: Check[] = [];

  checks.push({
    detail: trace.completed ? "turn.completed seen" : "no turn.completed in trace",
    name: "trace",
    pass: trace.completed,
  });

  if (evalCase.should_trigger !== undefined && arm === "skill") {
    checks.push({
      detail: `invoked=${trace.invoked}, expected=${evalCase.should_trigger}`,
      name: "trigger",
      pass: trace.invoked === evalCase.should_trigger,
    });
  }

  const gradedText =
    evalCase.mode === "generation"
      ? walkFiles(workspace)
          .filter((file) => !INJECTED_FILES.has(relative(workspace, file)))
          .map((file) => `=== ${relative(workspace, file)} ===\n${readFileSync(file, "utf8")}`)
          .join("\n")
      : trace.agentText;

  for (const pattern of evalCase.assert?.must_match ?? []) {
    const pass = new RegExp(pattern, "m").test(gradedText);
    checks.push({
      detail: pass ? pattern : `${pattern} | got: ${gradedText.slice(0, 400)}`,
      name: "must_match",
      pass,
    });
  }
  for (const pattern of evalCase.assert?.must_not_match ?? []) {
    checks.push({
      detail: pattern,
      name: "must_not_match",
      pass: !new RegExp(pattern, "m").test(gradedText),
    });
  }

  if (evalCase.mode === "generation" && (evalCase.assert?.graders ?? []).includes("tsc")) {
    checks.push(gradeTsc(workspace));
  }
  return checks;
}

function gradeTsc(workspace: string): Check {
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
