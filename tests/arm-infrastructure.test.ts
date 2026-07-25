import { describe, expect, it } from "vitest";
import { collectArmTrials, finalizeArm } from "../src/runner.js";
import type { TrialResult } from "../src/types.js";

const graded = (pass: boolean): TrialResult => ({
  checks: [{ detail: "x", name: "must_match", pass }],
  pass,
  usage: undefined,
});

const infra = (): TrialResult => ({
  checks: [{ detail: "output too large", name: "infrastructure", pass: false }],
  infrastructure: true,
  pass: false,
  usage: undefined,
});

describe("finalizeArm", () => {
  it("marks an all-infrastructure arm uncacheable and non-graded", () => {
    const { cache, result } = finalizeArm("solo", [infra(), infra()]);
    expect(cache).toBe(false);
    expect(result.infrastructure).toBe(true);
    expect(result.pass).toBe(false);
  });

  it("votes only on graded trials, ignoring interleaved infrastructure failures", () => {
    // Two graded passes plus an infra failure: the infra trial must not drag the majority to fail.
    const { cache, result } = finalizeArm("solo", [graded(true), infra(), graded(true)]);
    expect(cache).toBe(true);
    expect(result.infrastructure).toBeUndefined();
    expect(result.pass).toBe(true);
  });

  it("caches a normal graded arm", () => {
    const { cache, result } = finalizeArm("baseline", [graded(true)]);
    expect(cache).toBe(true);
    expect(result.pass).toBe(true);
  });
});

describe("collectArmTrials", () => {
  it("does not escalate when every trial is an infrastructure failure", () => {
    let calls = 0;
    const trials = collectArmTrials(1, () => {
      calls += 1;
      return infra();
    });
    // One configured trial, no graded disagreement to escalate on, no runaway loop.
    expect(calls).toBe(1);
    expect(trials).toHaveLength(1);
  });

  it("caps total trials at five even when infrastructure failures block agreement", () => {
    // Graded trials disagree (so escalation is wanted) but infra trials keep arriving; the total must
    // still be bounded, never an infinite loop.
    const script: TrialResult[] = [graded(true), graded(false), infra(), infra(), infra(), infra()];
    let index = 0;
    const trials = collectArmTrials(2, () => script[index++] ?? infra());
    expect(trials.length).toBe(5);
  });

  it("escalates on graded disagreement", () => {
    const script: TrialResult[] = [graded(true), graded(false), graded(true)];
    let index = 0;
    const trials = collectArmTrials(2, () => script[index++] ?? graded(true));
    expect(trials.length).toBeGreaterThan(2);
  });
});
