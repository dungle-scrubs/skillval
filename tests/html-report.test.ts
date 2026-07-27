import { describe, expect, it } from "vitest";
import { escapeHtml, renderHtmlReport } from "../src/html-report.js";
import { PAYLOAD_GLOBAL } from "../src/report-payload.js";
import type { RunReport } from "../src/runner.js";

const context = { generatedAt: "2026-07-24T00:00:00.000Z", reportPath: "/state/reports/abc.json" };

const executor = {
  invocationDetection: "heuristic" as const,
  model: "gpt-5.6-sol",
  name: "codex",
  skillsRoot: ".agents/skills",
  thinking: "medium",
  version: "0.145.0",
};

function reportWith(skills: RunReport["skills"]): RunReport {
  return { executor, runHash: "abc", skills };
}

describe("renderHtmlReport", () => {
  const html = renderHtmlReport(reportWith({}), context);

  it("renders a self-contained shell hydrating the embedded app", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>skillval report</title>");
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain(`window.${PAYLOAD_GLOBAL} =`);
    // The app bundle and stylesheet are inlined; nothing references the network.
    expect(html).toContain("<style>");
    expect(html).not.toMatch(/src="https?:|href="https?:/);
  });

  it("embeds the payload kind and carries the variant through, defaulting to latest", () => {
    expect(html).toContain('"kind":"run"');
    expect(html).toContain('"variant":"latest"');
    const archive = renderHtmlReport(reportWith({}), { ...context, variant: "archive" });
    expect(archive).toContain('"variant":"archive"');
  });

  it("keeps hostile report content inert inside the data script", () => {
    const hostile = renderHtmlReport(
      reportWith({
        "</script><script>alert(1)</script>": {
          cases: [],
          class: "capability",
          contentHash: "deadbeef",
        },
      }),
      context,
    );
    // Angle brackets in the payload are unicode-escaped, so the data script cannot be closed
    // early and no markup from report content reaches the document.
    expect(hostile).not.toContain("</script><script>alert(1)</script>");
    expect(hostile).toContain("\\u003c/script\\u003e");
  });

  it("stamps the theme class before first paint and follows the system", () => {
    expect(html).toContain('classList.toggle("dark", media.matches)');
  });
});

describe("escapeHtml", () => {
  it("escapes every character that could break out of markup", () => {
    expect(escapeHtml(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&#39;");
  });
});
