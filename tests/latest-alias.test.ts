import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeLatestReportAlias } from "../src/runner.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

const makeDir = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "skillval-latest-"));
  directories.push(directory);
  return directory;
};

describe("writeLatestReportAlias", () => {
  it("creates the alias and returns its path", () => {
    const directory = makeDir();

    const path = writeLatestReportAlias(directory, "<p>first</p>");

    expect(path).toBe(join(directory, "latest.html"));
    expect(readFileSync(path, "utf8")).toBe("<p>first</p>");
  });

  it("replaces an existing alias with the new content", () => {
    const directory = makeDir();
    writeLatestReportAlias(directory, "<p>first</p>");

    writeLatestReportAlias(directory, "<p>second</p>");

    expect(readFileSync(join(directory, "latest.html"), "utf8")).toBe("<p>second</p>");
  });

  it("leaves no staging file behind", () => {
    const directory = makeDir();

    writeLatestReportAlias(directory, "<p>content</p>");

    expect(readdirSync(directory)).toEqual(["latest.html"]);
  });

  it("does not create an alias in a directory it was never asked to touch", () => {
    // htmlReport: false skips the whole HTML path in the runner; the alias writer itself never
    // runs, so a stale alias is possible and documented. This guards the helper's scope: writing
    // one directory must not touch another.
    const written = makeDir();
    const untouched = makeDir();

    writeLatestReportAlias(written, "<p>content</p>");

    expect(existsSync(join(untouched, "latest.html"))).toBe(false);
  });
});
