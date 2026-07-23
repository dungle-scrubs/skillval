import { describe, expect, it } from "vitest";
import type { ReadyDiscoveredSkill } from "../src/discovery.js";
import { assertPiGenerationAcknowledged } from "../src/runner.js";

const skill = (name: string, cases: { id: string; mode: "generation" | "trigger" }[]) =>
  ({ evals: { cases }, name }) as unknown as ReadyDiscoveredSkill;

const generationSuite = [skill("s", [{ id: "gen", mode: "generation" }])];
const triggerSuite = [skill("s", [{ id: "trig", mode: "trigger" }])];

describe("assertPiGenerationAcknowledged", () => {
  it("refuses an unacknowledged pi generation case", () => {
    expect(() => assertPiGenerationAcknowledged("pi", generationSuite, undefined, false)).toThrow(
      "--allow-unsandboxed-pi",
    );
  });

  it("allows pi generation cases once acknowledged", () => {
    expect(() =>
      assertPiGenerationAcknowledged("pi", generationSuite, undefined, true),
    ).not.toThrow();
  });

  it("allows pi trigger-only suites without acknowledgement", () => {
    expect(() =>
      assertPiGenerationAcknowledged("pi", triggerSuite, undefined, false),
    ).not.toThrow();
  });

  it("does not gate non-pi executors", () => {
    expect(() =>
      assertPiGenerationAcknowledged("codex", generationSuite, undefined, false),
    ).not.toThrow();
    expect(() =>
      assertPiGenerationAcknowledged("claude", generationSuite, undefined, false),
    ).not.toThrow();
  });

  it("ignores generation cases filtered out of the run", () => {
    const mixed = [
      skill("s", [
        { id: "trig", mode: "trigger" },
        { id: "gen", mode: "generation" },
      ]),
    ];

    expect(() => assertPiGenerationAcknowledged("pi", mixed, "trig", false)).not.toThrow();
    expect(() => assertPiGenerationAcknowledged("pi", mixed, "gen", false)).toThrow(
      "--allow-unsandboxed-pi",
    );
  });
});
