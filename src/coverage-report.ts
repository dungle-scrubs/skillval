/**
 * Renders the eval-coverage matrix as one self-contained HTML file: the embedded React report app
 * hydrated with the coverage data. Presentation lives in report-ui/; rung copy shared with tests
 * lives in report-model.ts.
 */
import type { CoverageReport } from "./coverage.js";
import { renderReportShell } from "./report-shell.js";

export interface CoverageReportContext {
  readonly generatedAt: string;
}

export function renderCoverageReport(
  report: CoverageReport,
  context: CoverageReportContext,
): string {
  return renderReportShell(
    { context: { generatedAt: context.generatedAt }, kind: "coverage", report },
    "skillval coverage",
  );
}
