import { describe, expect, it } from "vitest";
import { CLAUDE_EFFORT_LEVELS } from "../src/executors/claude.js";
import { CODEX_EFFORT_LEVELS } from "../src/executors/codex.js";
import { PI_EFFORT_LEVELS } from "../src/executors/pi.js";
import { assertEffortSupported } from "../src/executors/types.js";

describe("assertEffortSupported", () => {
  it("accepts an effort in the vocabulary", () => {
    expect(() => assertEffortSupported("claude", "medium", CLAUDE_EFFORT_LEVELS)).not.toThrow();
  });

  it("treats an undefined effort as a no-op", () => {
    expect(() => assertEffortSupported("pi", undefined, PI_EFFORT_LEVELS)).not.toThrow();
  });

  it("rejects an effort outside the vocabulary and lists the valid levels", () => {
    expect(() => assertEffortSupported("claude", "minimal", CLAUDE_EFFORT_LEVELS)).toThrow(
      'claude does not support effort "minimal"; valid levels: low, medium, high, xhigh, max',
    );
  });
});

describe("per-executor effort vocabularies", () => {
  it("pins the codex, claude, and pi levels to their documented sets", () => {
    expect(CODEX_EFFORT_LEVELS).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(CLAUDE_EFFORT_LEVELS).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(PI_EFFORT_LEVELS).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
  });
});
