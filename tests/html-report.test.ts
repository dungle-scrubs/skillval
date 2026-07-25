import { describe, expect, it } from "vitest";
import { escapeHtml, renderHtmlReport, skillCaseAction } from "../src/html-report.js";
import type { RunReport } from "../src/runner.js";
import type { ArmResult, CaseResult, Check, RuntimeArm } from "../src/types.js";

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

function skillReport(cases: readonly CaseResult[]): RunReport {
  return {
    executor,
    runHash: "abc",
    skills: { "my-skill": { cases, class: "capability", contentHash: "deadbeef" } },
  };
}

function armOf(
  arm: RuntimeArm,
  pass: boolean,
  checks: readonly Check[] = [],
  infrastructure?: boolean,
): ArmResult {
  return {
    arm,
    cached: false,
    ...(infrastructure === undefined ? {} : { infrastructure }),
    pass,
    trials: checks.length === 0 && !pass ? [] : [{ checks, pass, usage: null }],
  };
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

  it("renders an inconclusive case as inconclusive, its infra arm labeled, never as a no-op", () => {
    const html = renderHtmlReport(
      {
        executor,
        runHash: "abc",
        skills: {
          "my-skill": {
            cases: [
              {
                arms: [
                  {
                    arm: "solo",
                    cached: false,
                    infrastructure: true,
                    pass: false,
                    trials: [],
                  },
                  { arm: "baseline", cached: false, pass: true, trials: [] },
                ],
                id: "overflow-case",
                inconclusive: true,
                noop: false,
                pass: false,
                rule: undefined,
              },
            ],
            class: "capability",
            contentHash: "deadbeef",
          },
        },
      },
      context,
    );

    expect(html).toContain("inconclusive");
    // The ungraded arm is labeled infra, not shown as a graded fail.
    expect(html).toContain("solo infra");
    expect(html).not.toContain("solo fail");
    expect(html).not.toContain("FAIL");
    // The skills table never marks the case as a no-op (the term glossary panels are excluded:
    // they define the word no-op for the whole page and are always present).
    const skillsStart = html.indexOf("<h2>Skills</h2>");
    const skillsTable = html.slice(skillsStart, html.indexOf("</section>", skillsStart));
    expect(skillsTable).not.toContain("no-op");
  });

  it("renders the report nav with Latest run active and a link to coverage", () => {
    const html = renderHtmlReport(reportWith({}), context);

    expect(html).toContain('aria-current="page"');
    expect(html).toContain("Latest run");
    expect(html).toContain('href="coverage.html"');
  });

  it("never lets an archived report claim to be the latest run", () => {
    const html = renderHtmlReport(reportWith({}), { ...context, variant: "archive" });

    // The archive's own tab is active; Latest run stays a live link to the alias.
    expect(html).toContain("This run (archived)");
    expect(html).toContain('href="latest.html"');
    expect(html).not.toContain(
      '<span class="tab tab-active" aria-current="page">Latest run</span>',
    );
  });

  it("gives every quick-view a dialog role, an accessible name, and managed focus", () => {
    const html = renderHtmlReport(reportWith({}), context);

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-labelledby="term-no-op-title"');
    expect(html).toMatch(/<button class="qv-close"[^>]*autofocus>/);
  });

  it("opens with the collapsed 20-second primer", () => {
    const html = renderHtmlReport(reportWith({}), context);

    expect(html).toContain('<details class="primer">');
    expect(html).toContain("How skillval decides - 20-second refresher");
    expect(html).toContain("Every dotted term on this page opens a refresher.");
  });

  it("renders a prune-candidate card naming baseline and no-op when both arms pass", () => {
    const html = renderHtmlReport(
      skillReport([
        {
          arms: [
            armOf("solo", true, [{ detail: "matched /tabs/", name: "must_match", pass: true }]),
            armOf("baseline", true),
          ],
          id: "noop-case",
          inconclusive: false,
          noop: true,
          pass: true,
          rule: undefined,
        },
      ]),
      context,
    );

    expect(html).toContain("What to change - skills");
    expect(html).toContain("Prune candidate");
    // The reason teaches the chain through term buttons for baseline and no-op.
    expect(html).toContain(
      'popovertarget="term-baseline" type="button">baseline</button> produced the behavior without the skill',
    );
    expect(html).toContain('popovertarget="term-no-op" type="button">no-op</button> on this model');
    expect(html).toContain("Verify on a second model before pruning.");
  });

  it("explains a group-inconclusive verdict without blaming a passing group arm", () => {
    // The group arm PASSED; the verdict is inconclusive because the solo arm was never graded.
    // The card must not claim the deciding arm failed, and its evidence must reach the arm that
    // actually caused the verdict.
    const html = renderHtmlReport(
      skillReport([
        {
          arms: [
            armOf("solo", false, [
              {
                detail: "agent output exceeded the capture limit",
                name: "infrastructure",
                pass: false,
              },
            ]),
            armOf("group", true, [{ detail: "matched /x/", name: "must_match", pass: true }]),
            armOf("peers", true),
          ],
          id: "solo-infra-case",
          inconclusive: false,
          loadout: { name: "everyday", verdict: "inconclusive" },
          noop: false,
          pass: true,
          rule: undefined,
        },
      ]),
      context,
    );

    expect(html).toContain("did not form a conclusive pattern");
    expect(html).not.toContain("failed its checks");
    expect(html).toContain("agent output exceeded the capture limit");
  });

  it("renders an investigate card with the failing check's evidence inline", () => {
    const html = renderHtmlReport(
      skillReport([
        {
          arms: [
            armOf("solo", false, [
              { detail: 'pattern /foo/ | got: "bar"', name: "must_match", pass: false },
            ]),
          ],
          id: "fail-case",
          inconclusive: false,
          noop: false,
          pass: false,
          rule: "always-foo",
        },
      ]),
      context,
    );

    expect(html).toContain("Investigate");
    expect(html).toContain("failed its checks");
    // The failing check's detail (escaped) sits inline in the card.
    expect(html).toContain("must_match: pattern /foo/ | got: &quot;bar&quot;");
    // The card links to the full-evidence popover for the case.
    expect(html).toContain('popovertarget="case-1"');
    expect(html).toContain('id="case-1"');
    expect(html).toContain("Full evidence");
  });

  it("renders a rerun card for an inconclusive case", () => {
    const html = renderHtmlReport(
      skillReport([
        {
          arms: [armOf("solo", false, [], true)],
          id: "overflow-case",
          inconclusive: true,
          noop: false,
          pass: false,
          rule: undefined,
        },
      ]),
      context,
    );

    expect(html).toContain("Rerun");
    expect(html).toContain("rerun to grade fresh");
    expect(html).toContain('popovertarget="term-inconclusive"');
  });

  it("renders the term panels exactly once and stays script-free", () => {
    const html = renderHtmlReport(reportWith({}), context);

    expect(html.match(/id="term-no-op"/g)?.length).toBe(1);
    expect(html.match(/id="term-baseline"/g)?.length).toBe(1);
    expect(html).not.toMatch(/<script/i);
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

  it("escapes a hostile check detail inside the card evidence and the popover", () => {
    const html = renderHtmlReport(
      skillReport([
        {
          arms: [
            armOf("solo", false, [
              { detail: '<img src=x onerror="alert(1)">', name: "must_match", pass: false },
            ]),
          ],
          id: "hostile-case",
          inconclusive: false,
          noop: false,
          pass: false,
          rule: undefined,
        },
      ]),
      context,
    );

    expect(html).not.toContain("<img");
    expect(html).toContain("must_match: &lt;img src=x");
  });
});

describe("skillCaseAction", () => {
  it("maps group verdicts to their actions", () => {
    const base: Omit<CaseResult, "loadout"> = {
      arms: [],
      id: "c",
      inconclusive: false,
      noop: false,
      pass: true,
      rule: undefined,
    };
    expect(skillCaseAction({ ...base, loadout: { name: "l", verdict: "load-bearing" } })).toBe(
      "keep",
    );
    expect(skillCaseAction({ ...base, loadout: { name: "l", verdict: "prune" } })).toBe(
      "prune-candidate",
    );
    expect(skillCaseAction({ ...base, loadout: { name: "l", verdict: "redundant" } })).toBe(
      "review",
    );
    expect(skillCaseAction({ ...base, loadout: { name: "l", verdict: "interference" } })).toBe(
      "review",
    );
    expect(skillCaseAction({ ...base, loadout: { name: "l", verdict: "inconclusive" } })).toBe(
      "investigate",
    );
    expect(
      skillCaseAction({
        ...base,
        inconclusive: true,
        loadout: { name: "l", verdict: "inconclusive" },
      }),
    ).toBe("rerun");
  });

  it("maps solo results to their actions", () => {
    const base: CaseResult = {
      arms: [],
      id: "c",
      inconclusive: false,
      noop: false,
      pass: true,
      rule: undefined,
    };
    expect(skillCaseAction({ ...base, inconclusive: true, pass: false })).toBe("rerun");
    expect(skillCaseAction({ ...base, pass: false })).toBe("investigate");
    expect(skillCaseAction({ ...base, noop: true })).toBe("prune-candidate");
    expect(
      skillCaseAction({
        ...base,
        arms: [
          { arm: "solo", cached: false, pass: true, trials: [] },
          { arm: "baseline", cached: false, pass: false, trials: [] },
        ],
      }),
    ).toBe("keep");
    expect(skillCaseAction(base)).toBe("ok");
  });
});

describe("escapeHtml", () => {
  it("escapes every character that could break out of markup", () => {
    expect(escapeHtml(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&#39;");
  });
});
