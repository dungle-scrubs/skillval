import { Provider as BalancerProvider } from "react-wrap-balancer";
import type { ReportPayload } from "../src/report-payload.js";
import { TooltipProvider } from "./components/ui/tooltip";
import { CoverageView } from "./views/coverage";
import { RunReportView } from "./views/run-report";

export function App({ payload }: { readonly payload: ReportPayload }) {
  return (
    <BalancerProvider>
      <TooltipProvider>
        {payload.kind === "run" ? (
          <RunReportView payload={payload} />
        ) : (
          <CoverageView payload={payload} />
        )}
      </TooltipProvider>
    </BalancerProvider>
  );
}
