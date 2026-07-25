import { describe, expect, it } from "vitest";
import { computeCoverage } from "../src/coverage.js";
import { renderCoverageReport } from "../src/coverage-report.js";
import type { ReadyDiscoveredSkill } from "../src/discovery.js";

const context = { generatedAt: "2026-07-25T00:00:00.000Z" };

function skill(name: string, cases: ReadyDiscoveredSkill["evals"]["cases"]): ReadyDiscoveredSkill {
  return {
    caseCount: cases.length,
    class: "preference",
    evals: { cases, class: "preference", skill: name },
    hasSkillval: true,
    name,
    root: "/roots/alpha",
    skillDirectory: `/roots/alpha/${name}`,
    status: "ready",
    validationError: undefined,
  };
}

const report = computeCoverage([
  skill("observability", [
    {
      arms: ["solo", "baseline"],
      assert: { command_exit: { command: "true" } },
      id: "typed-errors",
      mode: "generation",
      prompt: "p",
    },
    { id: "fires", mode: "trigger", prompt: "p", should_trigger: true },
  ]),
]);

describe("renderCoverageReport", () => {
  const html = renderCoverageReport(report, context);

  it("gives every composition segment a tooltip explaining its rung", () => {
    // Both the hover tooltip (data-tip) and the accessible name carry the rung, the share, and
    // what the rung proves - the bar is readable without the legend.
    expect(html).toContain('data-tip="execution - 1 of 2 cases (50%). Runtime behavior');
    expect(html).toContain(
      'data-tip="trigger-only - 1 of 2 cases (50%). Proves invocation behavior',
    );
    expect(html).toMatch(/aria-label="execution - 1 of 2 cases/);
    // Segments are keyboard-reachable so the tooltip is not hover-only.
    expect(html).toContain('tabindex="0"');
  });

  it("renders the matrix row and case detail", () => {
    expect(html).toContain("observability");
    expect(html).toContain("typed-errors");
    expect(html).toContain("command_exit");
    expect(html).toContain("solo+baseline");
    // The rule column carries the audit's unit of account.
    expect(html).toContain("<th>Rule</th>");
  });

  it("renders discovery diagnostics and an explicit empty state", () => {
    const empty = renderCoverageReport(computeCoverage([], ["/roots/gone"]), context);
    expect(empty).toContain("No ready skills discovered");
    expect(empty).toContain("missing root");
    expect(empty).toContain("/roots/gone");
    expect(empty).not.toContain("every skill");
  });

  it("is a self-contained document with no scripts or external assets", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<style>");
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("escapes untrusted names so a skill name cannot inject markup", () => {
    const hostile = computeCoverage([
      skill('<img src=x onerror="1">', [
        { id: "case", mode: "trigger", prompt: "p", should_trigger: true },
      ]),
    ]);
    const rendered = renderCoverageReport(hostile, context);
    expect(rendered).not.toContain("<img src=x");
    expect(rendered).toContain("&lt;img src=x");
  });
});
