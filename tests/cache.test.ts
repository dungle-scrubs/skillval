import { describe, expect, it } from "vitest";
import { armCacheKey } from "../src/cache.js";
import type { EvalCase } from "../src/types.js";

const evalCase: EvalCase = {
  arms: ["skill", "baseline"],
  assert: { must_match: ["as const"] },
  id: "enum-question",
  mode: "trigger",
  prompt: "Should I use an enum?",
  should_trigger: true,
  trials: 1,
};

describe("arm cache keys", () => {
  it("is stable for identical inputs", () => {
    const first = armCacheKey("skill-hash", evalCase, "skill", "codex 1.0", "model-a");
    const second = armCacheKey("skill-hash", evalCase, "skill", "codex 1.0", "model-a");

    expect(first).toBe(second);
    expect(first).toBe("66f7cb0fbbc84ac1aea7376db29aad02fb416cd2f52a67f250d9f18ea2709614");
  });

  it("changes for each execution identity input", () => {
    const original = armCacheKey("skill-hash", evalCase, "skill", "codex 1.0", "model-a");

    expect(armCacheKey("other-hash", evalCase, "skill", "codex 1.0", "model-a")).not.toBe(original);
    expect(armCacheKey("skill-hash", evalCase, "baseline", "codex 1.0", "model-a")).not.toBe(
      original,
    );
    expect(armCacheKey("skill-hash", evalCase, "skill", "codex 2.0", "model-a")).not.toBe(original);
    expect(armCacheKey("skill-hash", evalCase, "skill", "codex 1.0", "model-b")).not.toBe(original);
  });
});
