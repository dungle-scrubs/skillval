import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runGraders } from "../src/graders.js";

const workspaces: string[] = [];

const makeWorkspace = (files: Record<string, string>): string => {
  const workspace = mkdtempSync(join(tmpdir(), "skillval-graders-"));
  workspaces.push(workspace);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(workspace, name), content);
  }
  return workspace;
};

const objectSchema = {
  properties: { name: { type: "string" } },
  required: ["name"],
  type: "object",
};

afterEach(() => {
  while (workspaces.length > 0) {
    const workspace = workspaces.pop();
    if (workspace !== undefined) rmSync(workspace, { force: true, recursive: true });
  }
});

describe("json_schema grader", () => {
  it("passes when the produced file satisfies the schema", () => {
    const workspace = makeWorkspace({ "out.json": JSON.stringify({ name: "kevin" }) });

    const checks = runGraders(
      { assert: { json_schema: { file: "out.json", schema: objectSchema } } },
      workspace,
    );

    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ name: "json_schema", pass: true });
  });

  it("fails and names the instance path when the file violates the schema", () => {
    const workspace = makeWorkspace({ "out.json": JSON.stringify({ name: 42 }) });

    const [check] = runGraders(
      { assert: { json_schema: { file: "out.json", schema: objectSchema } } },
      workspace,
    );

    expect(check?.pass).toBe(false);
    expect(check?.detail).toContain("/name");
  });

  it("fails when a required property is missing", () => {
    const workspace = makeWorkspace({ "out.json": JSON.stringify({ other: true }) });

    const [check] = runGraders(
      { assert: { json_schema: { file: "out.json", schema: objectSchema } } },
      workspace,
    );

    expect(check?.pass).toBe(false);
    expect(check?.detail).toContain("name");
  });

  it("fails cleanly when the target file is missing", () => {
    const workspace = makeWorkspace({});

    const [check] = runGraders(
      { assert: { json_schema: { file: "out.json", schema: objectSchema } } },
      workspace,
    );

    expect(check?.pass).toBe(false);
    expect(check?.detail).toContain("file not found");
  });

  it("fails cleanly when the target file is not valid JSON", () => {
    const workspace = makeWorkspace({ "out.json": "{ not json" });

    const [check] = runGraders(
      { assert: { json_schema: { file: "out.json", schema: objectSchema } } },
      workspace,
    );

    expect(check?.pass).toBe(false);
    expect(check?.detail).toContain("invalid JSON");
  });

  it("validates draft 2020-12 keywords such as prefixItems", () => {
    const schema = {
      items: false,
      prefixItems: [{ type: "string" }, { type: "number" }],
      type: "array",
    };
    const pass = makeWorkspace({ "out.json": JSON.stringify(["a", 1]) });
    const fail = makeWorkspace({ "out.json": JSON.stringify(["a", 1, "extra"]) });

    expect(
      runGraders({ assert: { json_schema: { file: "out.json", schema } } }, pass)[0],
    ).toMatchObject({
      pass: true,
    });
    expect(
      runGraders({ assert: { json_schema: { file: "out.json", schema } } }, fail)[0]?.pass,
    ).toBe(false);
  });

  it("refuses a workspace-escaping relative path", () => {
    const workspace = makeWorkspace({});

    const [check] = runGraders(
      { assert: { json_schema: { file: "../escape.json", schema: objectSchema } } },
      workspace,
    );

    expect(check?.pass).toBe(false);
    expect(check?.detail).toMatch(/file not found|escapes workspace/);
  });

  it("refuses to follow a symlink that resolves outside the workspace", () => {
    const outside = mkdtempSync(join(tmpdir(), "skillval-outside-"));
    workspaces.push(outside);
    writeFileSync(join(outside, "secret.json"), JSON.stringify({ name: "leaked" }));
    const workspace = makeWorkspace({});
    symlinkSync(join(outside, "secret.json"), join(workspace, "out.json"));

    const [check] = runGraders(
      { assert: { json_schema: { file: "out.json", schema: objectSchema } } },
      workspace,
    );

    expect(check?.pass).toBe(false);
    expect(check?.detail).toContain("escapes workspace");
  });

  it("rejects a symlinked target that stays inside the workspace but points at a non-file", () => {
    const workspace = makeWorkspace({});
    symlinkSync(workspace, join(workspace, "out.json"));

    const [check] = runGraders(
      { assert: { json_schema: { file: "out.json", schema: objectSchema } } },
      workspace,
    );

    expect(check?.pass).toBe(false);
    expect(check?.detail).toContain("not a regular file");
  });

  it("accepts boolean JSON Schemas (false rejects, true accepts)", () => {
    const workspace = makeWorkspace({ "out.json": JSON.stringify({ any: "value" }) });

    expect(
      runGraders({ assert: { json_schema: { file: "out.json", schema: false } } }, workspace)[0]
        ?.pass,
    ).toBe(false);
    expect(
      runGraders({ assert: { json_schema: { file: "out.json", schema: true } } }, workspace)[0]
        ?.pass,
    ).toBe(true);
  });

  it("runs json_schema before mutating graders such as tsc", () => {
    const workspace = makeWorkspace({ "out.json": JSON.stringify({ name: "kevin" }) });

    const checks = runGraders(
      { assert: { graders: ["tsc"], json_schema: { file: "out.json", schema: objectSchema } } },
      workspace,
    );

    expect(checks[0]?.name).toBe("json_schema");
    expect(checks.map((check) => check.name)).toContain("tsc");
  });

  it("runs alongside named graders and returns no json_schema check when unconfigured", () => {
    const workspace = makeWorkspace({});

    expect(runGraders({ assert: {} }, workspace)).toHaveLength(0);
    expect(runGraders({}, workspace)).toHaveLength(0);
  });
});
