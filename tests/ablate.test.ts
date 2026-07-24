import { describe, expect, it } from "vitest";
import { AblationError, ablateRule } from "../src/ablate.js";

const FILE = `# Conventions

- Use \`as const\` objects, never TypeScript enums.
- Name booleans with an \`is\`/\`has\` prefix.
- Prefer \`const\` objects for any fixed set of values.
`;

describe("ablateRule", () => {
  it("keeps the whole file as the group variant", () => {
    const variants = ablateRule(FILE, "- Name booleans with an `is`/`has` prefix.");
    expect(variants.group).toBe(FILE);
  });

  it("removes exactly the span and nothing else for the peers variant", () => {
    const span = "- Name booleans with an `is`/`has` prefix.";
    const variants = ablateRule(FILE, span);
    expect(variants.peers).toBe(FILE.replace(span, ""));
    expect(variants.peers).not.toContain("is`/`has` prefix");
    expect(variants.peers).toContain("Use `as const`");
    expect(variants.peers).toContain("Prefer `const` objects");
  });

  it("returns the rule alone as the solo variant, with a trailing newline", () => {
    const variants = ablateRule(FILE, "- Prefer `const` objects for any fixed set of values.");
    expect(variants.solo).toBe("- Prefer `const` objects for any fixed set of values.\n");
  });

  it("matches the span verbatim, preserving indentation and not touching a different line", () => {
    const file = "- top level rule\n  - indented rule\n";
    const variants = ablateRule(file, "  - indented rule");
    expect(variants.peers).toBe("- top level rule\n\n");
    expect(variants.peers).toContain("- top level rule");
  });

  it("tolerates a single YAML block-scalar trailing newline on the span", () => {
    const file = "- rule one\n- rule two\n";
    const variants = ablateRule(file, "- rule one\n");
    expect(variants.peers).toBe("- rule two\n");
  });

  it("does not rewrite unrelated blank runs elsewhere in the file", () => {
    const file = "keep\n\n\n\nfenced block\n\nremove me\n";
    const variants = ablateRule(file, "remove me\n");
    // The pre-existing 4-newline run above is preserved; only the span is removed.
    expect(variants.peers).toBe("keep\n\n\n\nfenced block\n\n");
  });

  it("fails loudly when the span is absent", () => {
    expect(() => ablateRule(FILE, "a rule that is not present")).toThrow(AblationError);
    expect(() => ablateRule(FILE, "a rule that is not present")).toThrow("does not appear");
  });

  it("fails loudly when the span is ambiguous", () => {
    const file = "duplicate line\nduplicate line\n";
    expect(() => ablateRule(file, "duplicate line")).toThrow("appears 2 times");
  });

  it("catches a self-overlapping ambiguous span", () => {
    expect(() => ablateRule("aaa", "aa")).toThrow("must be unique");
  });

  it("rejects an empty span", () => {
    expect(() => ablateRule(FILE, "")).toThrow("empty");
  });
});
