import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { expandRoot, resolveConfigPath, resolveStateDirectory } from "../src/config.js";

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
});
