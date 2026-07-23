import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArmCache } from "../src/cache.js";
import type { ExecutorMetadata } from "../src/executors/types.js";
import type { SeededMember } from "../src/runner.js";
import { armCacheIdentity, computePlan, seededSkillsForArm } from "../src/runner.js";
import type { ArmResult, EvalCase } from "../src/types.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

function createCache(): ArmCache {
  const directory = mkdtempSync(join(tmpdir(), "skillval-plan-test-"));
  directories.push(directory);
  return new ArmCache(directory);
}

const metadata: ExecutorMetadata = {
  invocationDetection: "heuristic",
  model: "model-a",
  name: "codex",
  thinking: "medium",
  version: "codex 1.0",
};

const makeCase = (over: Partial<EvalCase> & { id: string }): EvalCase =>
  ({ mode: "generation", prompt: "p", ...over }) as EvalCase;

const skillInput = (name: string, cases: EvalCase[]) => ({
  contentHash: `hash-${name}`,
  skill: { evals: { cases }, name, skillDirectory: `/root/${name}` } as never,
});

const opts = { caseFilter: undefined, skipBaseline: false, useCache: true };

describe("computePlan", () => {
  it("counts an uncached solo-only case as one arm and its trial count", () => {
    const plan = computePlan(
      [skillInput("alpha", [makeCase({ id: "c1", trials: 1 })])],
      undefined,
      metadata,
      createCache(),
      opts,
    );

    expect(plan.armsToRun).toBe(1);
    expect(plan.armsCached).toBe(0);
    expect(plan.armsReused).toBe(0);
    expect(plan.trialsMin).toBe(1);
    expect(plan.trialsMax).toBe(1);
    expect(plan.skills[0]?.cases[0]?.arms).toEqual([
      { arm: "solo", cached: false, reused: false, trialsMax: 1, trialsMin: 1 },
    ]);
  });

  it("includes the baseline arm unless skip-baseline is set", () => {
    const cases = [makeCase({ arms: ["solo", "baseline"], id: "c1", trials: 1 })];

    expect(
      computePlan([skillInput("a", cases)], undefined, metadata, createCache(), opts).armsToRun,
    ).toBe(2);
    expect(
      computePlan([skillInput("a", cases)], undefined, metadata, createCache(), {
        ...opts,
        skipBaseline: true,
      }).armsToRun,
    ).toBe(1);
  });

  it("predicts escalation: a multi-trial arm runs its count and may reach 5", () => {
    const plan = computePlan(
      [skillInput("a", [makeCase({ id: "c1", trials: 3 })])],
      undefined,
      metadata,
      createCache(),
      opts,
    );

    expect(plan.trialsMin).toBe(3);
    expect(plan.trialsMax).toBe(5);
  });

  it("runs all three arms in group mode when the target has peers", () => {
    const loadout = {
      members: [
        { contentHash: "hash-a", directory: "/root/a", name: "a" },
        { contentHash: "hash-b", directory: "/root/b", name: "b" },
      ] as SeededMember[],
      name: "lo",
    };
    const plan = computePlan(
      [skillInput("a", [makeCase({ id: "c1", trials: 1 })])],
      loadout,
      metadata,
      createCache(),
      opts,
    );

    expect(plan.skills[0]?.cases[0]?.arms.map((arm) => arm.arm)).toEqual([
      "solo",
      "group",
      "peers",
    ]);
    expect(plan.armsToRun).toBe(3);
    expect(plan.armsReused).toBe(0);
    expect(plan.trialsMin).toBe(3);
  });

  it("reuses the group arm from solo when the target has no peers", () => {
    const loadout = {
      members: [{ contentHash: "hash-a", directory: "/root/a", name: "a" }] as SeededMember[],
      name: "lo",
    };
    const plan = computePlan(
      [skillInput("a", [makeCase({ id: "c1", trials: 1 })])],
      loadout,
      metadata,
      createCache(),
      opts,
    );

    // solo runs, group is reused (no peers), peers runs against the empty without-target set.
    expect(plan.armsToRun).toBe(2);
    expect(plan.armsReused).toBe(1);
    const group = plan.skills[0]?.cases[0]?.arms.find((arm) => arm.arm === "group");
    expect(group).toEqual({
      arm: "group",
      cached: false,
      reused: true,
      trialsMax: 0,
      trialsMin: 0,
    });
  });

  it("marks an arm cached and runs no trials for it when the cache holds its result", () => {
    const cache = createCache();
    const evalCase = makeCase({ id: "c1", trials: 2 });
    const target: SeededMember = { contentHash: "hash-a", directory: "/root/a", name: "a" };
    const identity = armCacheIdentity(
      "solo",
      evalCase,
      metadata,
      undefined,
      "a",
      seededSkillsForArm("solo", target, []),
    );
    const stored: ArmResult = { arm: "solo", cached: false, pass: true, trials: [] };
    cache.store(identity, stored);

    const plan = computePlan([skillInput("a", [evalCase])], undefined, metadata, cache, opts);

    expect(plan.armsCached).toBe(1);
    expect(plan.armsToRun).toBe(0);
    expect(plan.trialsMin).toBe(0);
    expect(plan.skills[0]?.cases[0]?.arms[0]?.cached).toBe(true);
  });

  it("ignores the cache when use-cache is off, so a stored arm still counts as to-run", () => {
    const cache = createCache();
    const evalCase = makeCase({ id: "c1", trials: 1 });
    const target: SeededMember = { contentHash: "hash-a", directory: "/root/a", name: "a" };
    cache.store(armCacheIdentity("solo", evalCase, metadata, undefined, "a", [target]), {
      arm: "solo",
      cached: false,
      pass: true,
      trials: [],
    });

    const plan = computePlan([skillInput("a", [evalCase])], undefined, metadata, cache, {
      ...opts,
      useCache: false,
    });

    expect(plan.armsCached).toBe(0);
    expect(plan.armsToRun).toBe(1);
  });

  it("counts only the case selected by the case filter", () => {
    const plan = computePlan(
      [skillInput("a", [makeCase({ id: "keep", trials: 1 }), makeCase({ id: "drop", trials: 1 })])],
      undefined,
      metadata,
      createCache(),
      { ...opts, caseFilter: "keep" },
    );

    expect(plan.skills[0]?.cases.map((entry) => entry.id)).toEqual(["keep"]);
    expect(plan.armsToRun).toBe(1);
  });
});
