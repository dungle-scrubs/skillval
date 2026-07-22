import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyFixture,
  FixtureSetupError,
  fixtureIdentityHash,
  resolveFixture,
  selectFixture,
} from "../src/fixture.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("selectFixture", () => {
  it("uses the suite default when the case declares none", () => {
    const suite = { path: "fixtures/base" };

    expect(selectFixture(undefined, suite)).toBe(suite);
  });

  it("replaces the suite default entirely with the case fixture", () => {
    const suite = { path: "fixtures/base", setup: ["echo suite"] };
    const perCase = { setup: ["echo case"] };

    expect(selectFixture(perCase, suite)).toBe(perCase);
  });
});

describe("resolveFixture", () => {
  it("returns undefined without a fixture", () => {
    expect(resolveFixture(undefined, "/base")).toBeUndefined();
  });

  it("resolves the path relative to the base directory", () => {
    const base = createTempDirectory("skillval-fixture-base-");
    mkdirSync(join(base, "fixtures", "repo"), { recursive: true });

    const resolved = resolveFixture({ path: "fixtures/repo" }, base);

    expect(resolved?.directory).toBe(join(base, "fixtures", "repo"));
    expect(resolved?.setup).toEqual([]);
  });
});

describe("fixtureIdentityHash", () => {
  it("changes when one fixture file byte changes", () => {
    const fixture = createTempDirectory("skillval-fixture-hash-");
    writeFileSync(join(fixture, "file.txt"), "aaa");
    const before = fixtureIdentityHash(fixture, []);

    writeFileSync(join(fixture, "file.txt"), "aab");

    expect(fixtureIdentityHash(fixture, [])).not.toBe(before);
  });

  it("changes when a setup command changes", () => {
    expect(fixtureIdentityHash(undefined, ["git init"])).not.toBe(
      fixtureIdentityHash(undefined, ["git init -b main"]),
    );
  });

  it("ignores .git and node_modules contents", () => {
    const fixture = createTempDirectory("skillval-fixture-hash-");
    writeFileSync(join(fixture, "file.txt"), "content");
    const before = fixtureIdentityHash(fixture, []);

    mkdirSync(join(fixture, ".git"));
    writeFileSync(join(fixture, ".git", "config"), "ignored");
    mkdirSync(join(fixture, "node_modules"));
    writeFileSync(join(fixture, "node_modules", "dep.js"), "ignored");

    expect(fixtureIdentityHash(fixture, [])).toBe(before);
  });
});

describe("applyFixture", () => {
  it("copies fixture contents into the workspace, excluding .git and node_modules", () => {
    const fixture = createTempDirectory("skillval-fixture-src-");
    const workspace = createTempDirectory("skillval-fixture-ws-");
    const home = createTempDirectory("skillval-fixture-home-");
    writeFileSync(join(fixture, "notes.md"), "base\n");
    mkdirSync(join(fixture, "src"));
    writeFileSync(join(fixture, "src", "index.ts"), "export {};\n");
    mkdirSync(join(fixture, ".git"));
    writeFileSync(join(fixture, ".git", "config"), "excluded");
    mkdirSync(join(fixture, "node_modules"));
    writeFileSync(join(fixture, "node_modules", "dep.js"), "excluded");

    applyFixture({ directory: fixture, hash: "unused", setup: [] }, workspace, home);

    expect(readFileSync(join(workspace, "notes.md"), "utf8")).toBe("base\n");
    expect(readFileSync(join(workspace, "src", "index.ts"), "utf8")).toBe("export {};\n");
    expect(existsSync(join(workspace, ".git"))).toBe(false);
    expect(existsSync(join(workspace, "node_modules"))).toBe(false);
  });

  it("runs setup commands in the workspace and captures their output", () => {
    const workspace = createTempDirectory("skillval-fixture-ws-");
    const home = createTempDirectory("skillval-fixture-home-");

    const results = applyFixture(
      { directory: undefined, hash: "unused", setup: ["printf staged > staged.txt", "pwd"] },
      workspace,
      home,
    );

    expect(readFileSync(join(workspace, "staged.txt"), "utf8")).toBe("staged");
    expect(results).toHaveLength(2);
    expect(results[1]?.exitCode).toBe(0);
    expect(results[1]?.stdout.trim()).toBe(realpathSync(workspace));
  });

  it("fails with a FixtureSetupError carrying results when a command exits non-zero", () => {
    const workspace = createTempDirectory("skillval-fixture-ws-");
    const home = createTempDirectory("skillval-fixture-home-");
    const fixture = {
      directory: undefined,
      hash: "unused",
      setup: ["echo before", "printf oops >&2; exit 3", "echo never-runs"],
    };

    let caught: unknown;
    try {
      applyFixture(fixture, workspace, home);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(FixtureSetupError);
    const setupError = caught as FixtureSetupError;
    expect(setupError.message).toContain("fixture setup failed");
    expect(setupError.message).toContain("exit code 3");
    expect(setupError.results).toHaveLength(2);
    expect(setupError.results[1]?.exitCode).toBe(3);
    expect(setupError.results[1]?.stderr).toBe("oops");
  });
});

function createTempDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}
