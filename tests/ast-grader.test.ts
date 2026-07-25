import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
