import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanSettings } from "../src/executors/claude.js";

const directories: string[] = [];
const withSettings = (settings: unknown): string => {
  const directory = mkdtempSync(join(tmpdir(), "skillval-settings-"));
  directories.push(directory);
  writeFileSync(join(directory, "settings.json"), JSON.stringify(settings));
  return directory;
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("cleanSettings", () => {
  it("keeps model, effortLevel, env, and apiKeyHelper", () => {
    const directory = withSettings({
      apiKeyHelper: "echo key",
      effortLevel: "high",
      env: { ANTHROPIC_BASE_URL: "https://example" },
      model: "sonnet",
    });

    expect(cleanSettings(directory)).toEqual({
      apiKeyHelper: "echo key",
      effortLevel: "high",
      env: { ANTHROPIC_BASE_URL: "https://example" },
      model: "sonnet",
    });
  });

  it("drops behavioral configuration that could act on one arm differently", () => {
    const directory = withSettings({
      effortLevel: "medium",
      enabledPlugins: ["some-plugin"],
      hooks: { PreToolUse: [{ matcher: "Skill" }] },
      model: "sonnet",
      permissions: { deny: ["Skill"] },
    });

    expect(cleanSettings(directory)).toEqual({ effortLevel: "medium", model: "sonnet" });
  });

  it("returns an empty object when no settings file is readable", () => {
    const directory = mkdtempSync(join(tmpdir(), "skillval-settings-"));
    directories.push(directory);

    expect(cleanSettings(directory)).toEqual({});
  });
});
