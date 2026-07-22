import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ArmCacheIdentity } from "../src/cache.js";
import { ArmCache, RUNNER_VERSION } from "../src/cache.js";
import { resolveFixture } from "../src/fixture.js";
import type { ArmResult, EvalCase } from "../src/types.js";

const directories: string[] = [];
const evalCase: EvalCase = {
  arms: ["skill", "baseline"],
  assert: { must_match: ["as const"] },
  id: "enum-question",
  mode: "trigger",
  prompt: "Should I use an enum?",
  should_trigger: true,
  trials: 1,
};
const identity: ArmCacheIdentity = {
  arm: "skill",
  evalCase,
  executor: { model: "model-a", name: "codex", version: "codex 1.0" },
  skillHash: "skill-hash",
};
const result: ArmResult = {
  arm: "skill",
  cached: false,
  pass: true,
  trials: [],
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("arm cache", () => {
  it("stores and returns a cached arm through its domain Interface", () => {
    const cache = createCache();

    cache.store(identity, result);

    expect(cache.lookup(identity)).toEqual({ ...result, cached: true });
  });

  it.each([
    ["skill hash", { ...identity, skillHash: "other-hash" }],
    ["case", { ...identity, evalCase: { ...evalCase, prompt: "Changed" } }],
    ["arm", { ...identity, arm: "baseline" as const }],
    ["executor name", { ...identity, executor: { ...identity.executor, name: "other" } }],
    ["executor version", { ...identity, executor: { ...identity.executor, version: "codex 2.0" } }],
    ["model", { ...identity, executor: { ...identity.executor, model: "model-b" } }],
    ["fixture hash", { ...identity, fixtureHash: "fixture-hash" }],
  ])("invalidates when %s changes", (_field, changedIdentity) => {
    const cache = createCache();
    cache.store(identity, result);

    expect(cache.lookup(changedIdentity)).toBeUndefined();
  });

  it("keeps the historical key and stored bytes for fixture-free identities", () => {
    // Golden pin: fixture support must not shift cache keys or stored JSON for existing cases,
    // so cached results from before the feature stay valid without a RUNNER_VERSION bump.
    const directory = mkdtempSync(join(tmpdir(), "skillval-cache-test-"));
    directories.push(directory);
    const cache = new ArmCache(directory);

    cache.store(identity, result);

    const legacyKey = createHash("sha256")
      .update(
        [
          String(RUNNER_VERSION),
          identity.skillHash,
          JSON.stringify(identity.evalCase),
          identity.arm,
          identity.executor.name,
          identity.executor.version,
          identity.executor.model,
        ].join("\0"),
      )
      .digest("hex");
    expect(readFileSync(join(directory, "cache", `${legacyKey}.json`), "utf8")).toBe(
      JSON.stringify(result),
    );
  });

  it("invalidates a fixture-backed arm when one fixture file byte changes", () => {
    const cache = createCache();
    const fixtureDirectory = mkdtempSync(join(tmpdir(), "skillval-cache-fixture-"));
    directories.push(fixtureDirectory);
    writeFileSync(join(fixtureDirectory, "notes.md"), "aaa");
    const fixture = { path: "." };
    const before = resolveFixture(fixture, fixtureDirectory);
    cache.store({ ...identity, fixtureHash: before?.hash }, result);

    writeFileSync(join(fixtureDirectory, "notes.md"), "aab");
    const after = resolveFixture(fixture, fixtureDirectory);

    expect(cache.lookup({ ...identity, fixtureHash: before?.hash })).toBeDefined();
    expect(cache.lookup({ ...identity, fixtureHash: after?.hash })).toBeUndefined();
  });
});

function createCache(): ArmCache {
  const directory = mkdtempSync(join(tmpdir(), "skillval-cache-test-"));
  directories.push(directory);
  return new ArmCache(directory);
}
