/** The data contract between the node-side shell renderers and the embedded React report app. */
import type { CoverageReport } from "./coverage.js";
import type { RunReport } from "./runner.js";

export interface RunPayload {
  readonly context: {
    readonly generatedAt: string;
    readonly reportPath: string;
    // "latest" is the stable alias page; "archive" is a hash-named immutable report, which must
    // not claim to be the latest run.
    readonly variant: "archive" | "latest";
  };
  readonly kind: "run";
  readonly report: RunReport;
}

export interface CoveragePayload {
  readonly context: { readonly generatedAt: string };
  readonly kind: "coverage";
  readonly report: CoverageReport;
}

export type ReportPayload = CoveragePayload | RunPayload;

// The property the shell writes and the app reads.
export const PAYLOAD_GLOBAL = "__SKILLVAL_REPORT__";
