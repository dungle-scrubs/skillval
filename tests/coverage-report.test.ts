import { describe, expect, it } from "vitest";
import { computeCoverage } from "../src/coverage.js";
import { renderCoverageReport } from "../src/coverage-report.js";
import type { ReadyDiscoveredSkill } from "../src/discovery.js";
import { PAYLOAD_GLOBAL } from "../src/report-payload.js";

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

describe("renderCoverageReport", () => {
  const report = computeCoverage([
    skill("observability", [{ id: "fires", mode: "trigger", prompt: "p", should_trigger: true }]),
  ]);
  const html = renderCoverageReport(report, context);

  it("renders a self-contained shell hydrating the embedded app", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>skillval coverage</title>");
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain(`window.${PAYLOAD_GLOBAL} =`);
    expect(html).toContain('"kind":"coverage"');
    expect(html).not.toMatch(/src="https?:|href="https?:/);
  });

  it("embeds the coverage data for the app to render", () => {
    expect(html).toContain('"observability"');
    expect(html).toContain('"skillCount":1');
  });

  it("keeps hostile skill names inert inside the data script", () => {
    const hostile = renderCoverageReport(
      computeCoverage([
        skill("</script><img src=x onerror=alert(1)>", [
          { id: "case", mode: "trigger", prompt: "p", should_trigger: true },
        ]),
      ]),
      context,
    );
    expect(hostile).not.toContain("</script><img");
    expect(hostile).toContain("\\u003c/script\\u003e");
  });
});
