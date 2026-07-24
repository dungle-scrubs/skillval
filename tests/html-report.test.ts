import { describe, expect, it } from "vitest";
import { escapeHtml, renderHtmlReport } from "../src/html-report.js";
import type { RunReport } from "../src/runner.js";

const context = { generatedAt: "2026-07-24T00:00:00.000Z", reportPath: "/state/reports/abc.json" };

const executor = {
  invocationDetection: "heuristic" as const,
  model: "gpt-5.6-sol",
  name: "codex",
  thinking: "medium",
  version: "0.145.0",
};

function reportWith(findings: RunReport["instructions"]): RunReport {
  return { executor, instructions: findings, runHash: "abc", skills: {} };
}

describe("renderHtmlReport", () => {
  it("leads with the actionable rules and states why each one is flagged", () => {
    const html = renderHtmlReport(
      reportWith({
        "myapp:.": {
          directory: "/repo",
          findings: [
            {
              action: "delete",
              arms: [
                { arm: "solo", cached: false, pass: true, trials: [] },
                { arm: "group", cached: false, pass: true, trials: [] },
                { arm: "peers", cached: false, pass: true, trials: [] },
              ],
              caseId: "duplicate-rule",
              file: "AGENTS.md",
              rule: "duplicate-rule",
              span: "- Always use tabs.",
              verdict: "redundant",
            },
          ],
          id: "myapp:.",
        },
      }),
      context,
    );

    expect(html).toContain("What to change");
    expect(html).toContain("- Always use tabs.");
    expect(html).toContain("another rule in this file already covers it");
    expect(html).toContain("Delete");
    // The evidence stays inspectable next to the recommendation.
    expect(html).toContain("peers pass");
  });

  it("says so plainly when nothing needs changing", () => {
    const html = renderHtmlReport(
      reportWith({
        "myapp:.": {
          directory: "/repo",
          findings: [
            {
              action: "keep",
              arms: [{ arm: "group", cached: false, pass: true, trials: [] }],
              caseId: "load-bearing-rule",
              file: "AGENTS.md",
              rule: undefined,
              span: "- Keep it.",
              verdict: "load-bearing",
            },
          ],
          id: "myapp:.",
        },
      }),
      context,
    );

    expect(html).toContain("Nothing to change");
  });

  it("renders an n/a finding with its reason instead of a verdict", () => {
    const html = renderHtmlReport(
      reportWith({
        "myapp:.": {
          directory: "/repo",
          findings: [
            {
              action: "investigate",
              arms: [],
              caseId: "claude-only",
              file: "",
              naReason: "rule is not in a file codex reads ambiently",
              rule: undefined,
              span: "- Claude only.",
              verdict: "n/a",
            },
          ],
          id: "myapp:.",
        },
      }),
      context,
    );

    expect(html).toContain("n/a");
    expect(html).toContain("rule is not in a file codex reads ambiently");
    expect(html).toContain("no arms run");
  });

  it("is a self-contained document with no external asset references", () => {
    const html = renderHtmlReport(reportWith({}), context);

    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<style>");
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("escapes report content so a rule span cannot inject markup", () => {
    const html = renderHtmlReport(
      reportWith({
        "myapp:.": {
          directory: "/repo",
          findings: [
            {
              action: "delete",
              arms: [],
              caseId: "x",
              file: "AGENTS.md",
              rule: undefined,
              span: '<img src=x onerror="alert(1)">',
              verdict: "redundant",
            },
          ],
          id: "myapp:.",
        },
      }),
      context,
    );

    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });
});

describe("escapeHtml", () => {
  it("escapes every character that could break out of markup", () => {
    expect(escapeHtml(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&#39;");
  });
});
