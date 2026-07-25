/**
 * Renders a run report as one self-contained HTML file: the embedded React report app hydrated
 * with this run's data. All presentation (what-to-change cards, glossary popovers, evidence
 * sidebar) lives in report-ui/; derivation logic shared with tests lives in report-model.ts.
 */
import { renderReportShell } from "./report-shell.js";
import type { RunReport } from "./runner.js";

export interface HtmlReportContext {
  readonly generatedAt: string;
  readonly reportPath: string;
  // "latest" renders the alias page (Latest run is the active tab); "archive" renders a hash-named
  // immutable report, which must not claim to be the latest - it gets a "This run (archived)" tab
  // with Latest run as a live link. Defaults to "latest".
  readonly variant?: "archive" | "latest";
}

export function renderHtmlReport(report: RunReport, context: HtmlReportContext): string {
  return renderReportShell(
    {
      context: {
        generatedAt: context.generatedAt,
        reportPath: context.reportPath,
        variant: context.variant ?? "latest",
      },
      kind: "run",
      report,
    },
    "skillval report",
  );
}

// Kept for the shell and any templating outside React's escaping (React handles all report
// content); also used directly by tests.
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
