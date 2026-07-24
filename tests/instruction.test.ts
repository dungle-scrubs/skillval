import { describe, expect, it } from "vitest";
import type { AblationVariants } from "../src/ablate.js";
import {
  armInstructionContent,
  INSTRUCTION_ARMS,
  instructionApplicable,
  instructionSourceFile,
  resolveRuleFile,
} from "../src/instruction.js";

describe("instructionApplicable", () => {
  it("makes an AGENTS.md target applicable to codex and pi but not claude (no bare-AGENTS.md read)", () => {
    expect(instructionApplicable("codex", ["AGENTS.md"])).toBe(true);
    expect(instructionApplicable("pi", ["AGENTS.md"])).toBe(true);
    expect(instructionApplicable("claude", ["AGENTS.md"])).toBe(false);
  });

  it("makes a CLAUDE.md-only target applicable to claude and pi but not codex", () => {
    expect(instructionApplicable("claude", ["CLAUDE.md"])).toBe(true);
    expect(instructionApplicable("pi", ["CLAUDE.md"])).toBe(true);
    expect(instructionApplicable("codex", ["CLAUDE.md"])).toBe(false);
  });

  it("makes a side-by-side pair applicable to every executor", () => {
    for (const executor of ["claude", "codex", "pi"]) {
      expect(instructionApplicable(executor, ["AGENTS.md", "CLAUDE.md"])).toBe(true);
    }
  });

  it("treats an unknown executor as not applicable", () => {
    expect(instructionApplicable("mystery", ["AGENTS.md"])).toBe(false);
  });
});

describe("instructionSourceFile", () => {
  it("prefers AGENTS.md when both files exist", () => {
    expect(instructionSourceFile(["AGENTS.md", "CLAUDE.md"])).toBe("AGENTS.md");
  });

  it("falls back to CLAUDE.md", () => {
    expect(instructionSourceFile(["CLAUDE.md"])).toBe("CLAUDE.md");
  });

  it("returns undefined when there is no instruction file", () => {
    expect(instructionSourceFile([])).toBeUndefined();
  });
});

describe("resolveRuleFile", () => {
  const files = [
    { content: "- portable rule\n", file: "AGENTS.md" as const },
    { content: "- claude-only rule\n", file: "CLAUDE.md" as const },
  ];

  it("resolves codex to AGENTS.md and never to CLAUDE.md", () => {
    expect(resolveRuleFile("codex", files, "- portable rule")).toBe("AGENTS.md");
    expect(resolveRuleFile("codex", files, "- claude-only rule")).toBeUndefined();
  });

  it("resolves claude to CLAUDE.md and not to a bare AGENTS.md rule", () => {
    expect(resolveRuleFile("claude", files, "- claude-only rule")).toBe("CLAUDE.md");
    expect(resolveRuleFile("claude", files, "- portable rule")).toBeUndefined();
  });

  it("lets pi read either file, preferring AGENTS.md", () => {
    expect(resolveRuleFile("pi", files, "- portable rule")).toBe("AGENTS.md");
    expect(resolveRuleFile("pi", files, "- claude-only rule")).toBe("CLAUDE.md");
  });

  it("returns undefined when the rule is in no file the executor reads", () => {
    expect(resolveRuleFile("codex", files, "- nonexistent rule")).toBeUndefined();
    expect(resolveRuleFile("mystery", files, "- portable rule")).toBeUndefined();
    expect(resolveRuleFile("codex", files, "")).toBeUndefined();
  });
});

describe("armInstructionContent", () => {
  const variants: AblationVariants = { group: "GROUP", peers: "PEERS", solo: "SOLO" };

  it("selects the ablation variant for each arm", () => {
    expect(armInstructionContent("solo", variants)).toBe("SOLO");
    expect(armInstructionContent("group", variants)).toBe("GROUP");
    expect(armInstructionContent("peers", variants)).toBe("PEERS");
  });

  it("runs the group-mode arm triple", () => {
    expect(INSTRUCTION_ARMS).toEqual(["solo", "group", "peers"]);
  });
});
