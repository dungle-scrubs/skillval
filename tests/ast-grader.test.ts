import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CaseContractError, parseCaseValue } from "../src/case-contract.js";
import { runGraders } from "../src/graders.js";

const workspaces: string[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    rmSync(workspace, { force: true, recursive: true });
  }
});

function workspaceWith(file: string, source: string): string {
  const workspace = mkdtempSync(join(tmpdir(), "skillval-ast-"));
  workspaces.push(workspace);
  writeFileSync(join(workspace, file), source);
  return workspace;
}

// The lookalike the grader exists to split: an assert in a constructor guarding a PARAMETER is
// input validation; a this.-referencing guard in an operation is an internal invariant. Regex
// matches both; execution observes similar throws; structure separates them.
const INVARIANT_RULE = {
  all: [
    { has: { field: "condition", has: { pattern: "this.$PROP", stopBy: "end" } } },
    { has: { pattern: "throw $$$E", stopBy: "end" } },
  ],
  inside: {
    kind: "method_definition",
    not: { has: { field: "name", regex: "^constructor$" } },
    stopBy: "end",
  },
  kind: "if_statement",
};

const invariantImpl = `export class Semaphore {
  private held = 0;
  constructor(private readonly permits: number) {
    if (permits <= 0) throw new Error("permits must be positive");
  }
  release(): void {
    if (this.held === 0) throw new Error("invariant violated");
    this.held -= 1;
  }
}`;

const validationOnlyImpl = `export class Semaphore {
  private held = 0;
  constructor(private readonly permits: number) {
    if (permits <= 0) throw new Error("permits must be positive");
  }
  release(): void {
    this.held = Math.max(0, this.held - 1);
  }
}`;

describe("ast grader", () => {
  it("separates an internal invariant from constructor input validation", () => {
    const good = runGraders(
      { assert: { ast: { file: "impl.ts", must_match: [INVARIANT_RULE] } } },
      workspaceWith("impl.ts", invariantImpl),
    );
    expect(good[0]).toMatchObject({ name: "ast", pass: true });

    // The validation-only implementation still contains a throw and the word-shape a regex would
    // match, but no this.-referencing guard outside the constructor.
    const bad = runGraders(
      { assert: { ast: { file: "impl.ts", must_match: [INVARIANT_RULE] } } },
      workspaceWith("impl.ts", validationOnlyImpl),
    );
    expect(bad[0]?.pass).toBe(false);
    expect(bad[0]?.detail).toContain("must_match[0] matched nothing");
  });

  it("fails a forbidden structure with the offending file, line, and snippet", () => {
    const checks = runGraders(
      {
        assert: {
          ast: {
            file: "impl.ts",
            must_not_match: [{ pattern: "console.log($$$A)" }],
          },
        },
      },
      workspaceWith("impl.ts", 'export function noisy(): void {\n  console.log("debug");\n}\n'),
    );
    expect(checks[0]?.pass).toBe(false);
    expect(checks[0]?.detail).toContain("impl.ts:2");
    expect(checks[0]?.detail).toContain("console.log");
  });

  it("matches structure, not comments - the regex false-positive class disappears", () => {
    const checks = runGraders(
      {
        assert: {
          ast: { file: "impl.ts", must_not_match: [{ pattern: "console.log($$$A)" }] },
        },
      },
      workspaceWith(
        "impl.ts",
        '// console.log("only mentioned in a comment")\nexport const x = 1;\n',
      ),
    );
    expect(checks[0]?.pass).toBe(true);
  });

  it("fails cleanly on a missing file, a workspace escape, and an unsupported extension", () => {
    const missing = runGraders(
      { assert: { ast: { file: "gone.ts", must_match: [{ pattern: "x" }] } } },
      workspaceWith("impl.ts", "export const x = 1;\n"),
    );
    expect(missing[0]).toMatchObject({ name: "ast", pass: false });
    expect(missing[0]?.detail).toContain("file not found");

    const escaped = runGraders(
      { assert: { ast: { file: "../escape.ts", must_match: [{ pattern: "x" }] } } },
      workspaceWith("impl.ts", "export const x = 1;\n"),
    );
    expect(escaped[0]?.pass).toBe(false);

    const unsupported = runGraders(
      { assert: { ast: { file: "impl.go", must_match: [{ pattern: "x" }] } } },
      workspaceWith("impl.go", "package main\n"),
    );
    expect(unsupported[0]?.pass).toBe(false);
    expect(unsupported[0]?.detail).toContain("unsupported file extension");
  });

  it("reports an invalid rule as a grading failure, never a crash", () => {
    const checks = runGraders(
      {
        assert: {
          ast: { file: "impl.ts", must_match: [{ nonsense_key: true }] },
        },
      },
      workspaceWith("impl.ts", "export const x = 1;\n"),
    );
    expect(checks[0]?.pass).toBe(false);
    expect(checks[0]?.detail).toContain("must_match[0]");
  });

  it("fails malformed source instead of passing a forbidden-only case against garbage", () => {
    // tree-sitter recovers from syntax errors; without the ERROR-node check, this unparseable
    // file contains no forbidden structure and would pass.
    const checks = runGraders(
      {
        assert: {
          ast: { file: "impl.ts", must_not_match: [{ pattern: "console.log($$$A)" }] },
        },
      },
      workspaceWith("impl.ts", "export function {  = broken ("),
    );
    expect(checks[0]?.pass).toBe(false);
    expect(checks[0]?.detail).toContain("does not parse");
  });

  it("grades .jsx with the JavaScript grammar and .cts as TypeScript", () => {
    const jsx = runGraders(
      { assert: { ast: { file: "app.jsx", must_match: [{ pattern: "<Widget />" }] } } },
      workspaceWith("app.jsx", "export const App = () => <Widget />;\n"),
    );
    expect(jsx[0]).toMatchObject({ name: "ast", pass: true });

    const cts = runGraders(
      { assert: { ast: { file: "util.cts", must_match: [{ pattern: "module.exports = $V" }] } } },
      workspaceWith("util.cts", "const x: number = 1;\nmodule.exports = x;\n"),
    );
    expect(cts[0]).toMatchObject({ name: "ast", pass: true });
  });

  it("refuses oversized files instead of parsing them", () => {
    const checks = runGraders(
      { assert: { ast: { file: "big.ts", must_match: [{ pattern: "x" }] } } },
      workspaceWith("big.ts", `export const x = 1;\n${"// pad\n".repeat(900_000)}`),
    );
    expect(checks[0]?.pass).toBe(false);
    expect(checks[0]?.detail).toContain("too large");
  });
});

describe("ast grader case-load validation", () => {
  const caseWith = (assert: Record<string, unknown>, mode = "generation") => ({
    cases: [{ assert, id: "case", mode, prompt: "p" }],
    class: "capability",
    skill: "s",
  });

  it("rejects an invalid rule at case-load time, before any paid trial", () => {
    expect(() =>
      parseCaseValue(
        caseWith({ ast: { file: "impl.ts", must_match: [{ nonsense_key: true }] } }),
        "skillval.yml",
      ),
    ).toThrow(CaseContractError);
    expect(() =>
      parseCaseValue(
        caseWith({ ast: { file: "impl.ts", must_match: [{ nonsense_key: true }] } }),
        "skillval.yml",
      ),
    ).toThrow(/invalid ast must_match\[0\]/);
  });

  it("rejects trigger mode, empty rule sets, and traversal paths at load", () => {
    expect(() =>
      parseCaseValue(
        caseWith({ ast: { file: "impl.ts", must_match: [{ pattern: "x" }] } }, "trigger"),
        "skillval.yml",
      ),
    ).toThrow(/does not support trigger mode/);
    expect(() => parseCaseValue(caseWith({ ast: { file: "impl.ts" } }), "skillval.yml")).toThrow(
      /needs must_match or must_not_match/,
    );
    expect(() =>
      parseCaseValue(
        caseWith({ ast: { file: "../escape.ts", must_match: [{ pattern: "x" }] } }),
        "skillval.yml",
      ),
    ).toThrow(/inside the workspace/);
  });
});

describe("ast grader languages", () => {
  it("grades tsx files with the tsx language", () => {
    const checks = runGraders(
      {
        assert: {
          ast: { file: "app.tsx", must_match: [{ pattern: "<Provider>$$$C</Provider>" }] },
        },
      },
      workspaceWith("app.tsx", "export const App = () => <Provider><Child /></Provider>;\n"),
    );
    expect(checks[0]).toMatchObject({ name: "ast", pass: true });
  });
});
