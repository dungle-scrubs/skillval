import { JSDOM, VirtualConsole } from "jsdom";
import { describe, expect, it } from "vitest";
import { computeCoverage } from "../src/coverage.js";
import { renderCoverageReport } from "../src/coverage-report.js";
import { renderHtmlReport } from "../src/html-report.js";
import type { RunReport } from "../src/runner.js";

// Executes a rendered report file end to end: the real embedded bundle (from the committed
// generated asset), the payload global, and the mount script all run inside jsdom - the
// integration the component tests bypass. This is the test that catches a bundle that cannot
// boot in a browser (e.g. an unresolved process.env.NODE_ENV in lib mode).
async function hydrate(html: string): Promise<{ text: string; errors: readonly string[] }> {
  const errors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => {
    errors.push(String(error));
  });
  const dom = new JSDOM(html, {
    beforeParse(window) {
      // jsdom has no matchMedia; the theme script feature-checks it, and Radix may query it.
      // biome-ignore lint/suspicious/noExplicitAny: jsdom window shim
      (window as any).matchMedia ??= () => ({
        addEventListener: () => undefined,
        addListener: () => undefined,
        matches: false,
        removeEventListener: () => undefined,
        removeListener: () => undefined,
      });
    },
    pretendToBeVisual: true,
    runScripts: "dangerously",
    virtualConsole,
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  return { errors, text: dom.window.document.getElementById("root")?.textContent ?? "" };
}

const executor = {
  invocationDetection: "heuristic" as const,
  model: "gpt-5.6-sol",
  name: "codex",
  thinking: "medium",
  version: "0.145.0",
};

describe("rendered report files boot the embedded app", () => {
  it("hydrates the coverage page", async () => {
    const report = computeCoverage([
      {
        caseCount: 1,
        class: "preference",
        evals: {
          cases: [{ id: "fires", mode: "trigger", prompt: "p", should_trigger: true }],
          class: "preference",
          skill: "observability",
        },
        hasSkillval: true,
        name: "observability",
        root: "/roots/alpha",
        skillDirectory: "/roots/alpha/observability",
        status: "ready",
        validationError: undefined,
      },
    ]);
    const { errors, text } = await hydrate(
      renderCoverageReport(report, { generatedAt: "2026-07-25T00:00:00.000Z" }),
    );

    expect(errors).toEqual([]);
    expect(text).toContain("Eval coverage");
    expect(text).toContain("observability");
    expect(text).toContain("Latest run");
  });

  it("hydrates the run page", async () => {
    const report: RunReport = { executor, runHash: "abc", skills: {} };
    const { errors, text } = await hydrate(
      renderHtmlReport(report, {
        generatedAt: "2026-07-25T00:00:00.000Z",
        reportPath: "/x.json",
      }),
    );

    expect(errors).toEqual([]);
    expect(text).toContain("Evaluation report");
    expect(text).toContain("Coverage");
  });
});
