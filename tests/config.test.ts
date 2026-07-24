import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { expandRoot, loadConfig, resolveConfigPath, resolveStateDirectory } from "../src/config.js";

describe("configuration paths", () => {
  it("uses CLI, environment, XDG, then default precedence", () => {
    const home = "/Users/example";
    const environment = {
      SKILLVAL_CONFIG: "/env/config.yml",
      XDG_CONFIG_HOME: "/xdg/config",
    };

    expect(resolveConfigPath({ cliPath: "/cli/config.yml", environment, home })).toBe(
      "/cli/config.yml",
    );
    expect(resolveConfigPath({ environment, home })).toBe("/env/config.yml");
    expect(resolveConfigPath({ environment: { XDG_CONFIG_HOME: "/xdg/config" }, home })).toBe(
      "/xdg/config/skillval/config.yml",
    );
    expect(resolveConfigPath({ environment: {}, home })).toBe(
      "/Users/example/.config/skillval/config.yml",
    );
  });

  it("expands tilde and HOME references in roots", () => {
    const home = "/Users/example";

    expect(expandRoot("~/dev/skills", home)).toBe("/Users/example/dev/skills");
    expect(expandRoot("$HOME/dev/skills", home)).toBe("/Users/example/dev/skills");
    expect(expandRoot(String.raw`\${HOME}/dev/skills`, home)).toBe("/Users/example/dev/skills");
    expect(expandRoot("relative/skills", home)).toBe(resolve("relative/skills"));
  });

  it("resolves state under XDG or the home fallback", () => {
    expect(resolveStateDirectory({ XDG_STATE_HOME: "/state" }, "/Users/example")).toBe(
      "/state/skillval",
    );
    expect(resolveStateDirectory({}, "/Users/example")).toBe(
      "/Users/example/.local/state/skillval",
    );
  });

  it("loads configuration through the executable schema contract", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "skillval-config-test-"));
    const path = resolve(directory, "config.yml");
    writeFileSync(path, "executor: codex\nroots: [~/skills]\n");

    try {
      expect(loadConfig(path, "/Users/example")).toEqual({
        executor: "codex",
        roots: ["/Users/example/skills"],
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("expands tilde and HOME references in projects", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "skillval-config-test-"));
    const path = resolve(directory, "config.yml");
    writeFileSync(path, "executor: codex\nprojects: [~/dev/first, $HOME/dev/second]\nroots: []\n");

    try {
      expect(loadConfig(path, "/Users/example")).toEqual({
        executor: "codex",
        projects: ["/Users/example/dev/first", "/Users/example/dev/second"],
        roots: [],
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("carries exclude patterns through verbatim without path expansion", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "skillval-config-test-"));
    const path = resolve(directory, "config.yml");
    writeFileSync(path, "executor: codex\nexclude: [impeccable, vendor-*]\nroots: [~/skills]\n");

    try {
      expect(loadConfig(path, "/Users/example")).toEqual({
        exclude: ["impeccable", "vendor-*"],
        executor: "codex",
        roots: ["/Users/example/skills"],
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects unknown configuration fields", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "skillval-config-test-"));
    const path = resolve(directory, "config.yml");
    writeFileSync(path, "executor: codex\nroots: []\nlegacy: true\n");

    try {
      expect(() => loadConfig(path)).toThrow(/additional properties/i);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
