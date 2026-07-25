import { describe, expect, it } from "vitest";
import { caseOutcome, collectArmTrials, finalizeArm } from "../src/runner.js";
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

describe("caseOutcome", () => {
  it("marks the case inconclusive when the deciding arm was never graded", () => {
    const outcome = caseOutcome("infra", "pass", true);
    expect(outcome.inconclusive).toBe(true);
    expect(outcome.pass).toBe(false);
    // The exact PR #37 scenario: a passing baseline beside an ungraded solo arm must not surface a
    // spurious prune candidate.
    expect(outcome.noop).toBe(false);
  });

  it("grades pass, fail, and no-op normally when the deciding arm was graded", () => {
    expect(caseOutcome("pass", "fail", true)).toEqual({
      inconclusive: false,
      noop: false,
      pass: true,
    });
    expect(caseOutcome("fail", "pass", true)).toEqual({
      inconclusive: false,
      noop: true,
      pass: false,
    });
  });

  it("does not claim a no-op from an ungraded or unmeaningful control arm", () => {
    expect(caseOutcome("pass", "infra", true).noop).toBe(false);
    expect(caseOutcome("pass", "pass", false).noop).toBe(false);
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
