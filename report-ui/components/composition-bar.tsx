import type { GraderRung } from "../../src/coverage.js";
import { RUNG_LABEL, RUNG_MEANING } from "../../src/report-model.js";
import { cn } from "../lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

const RUNG_ORDER: readonly GraderRung[] = ["ungraded", "trigger", "regex", "execution"];

const SEGMENT_CLASS: Readonly<Record<GraderRung, string>> = {
  execution: "bg-rung-execution",
  regex: "bg-rung-regex",
  trigger: "bg-rung-trigger",
  ungraded: "bg-rung-ungraded",
};

/** The stacked rung-composition bar; every segment explains itself on hover or focus. */
export function CompositionBar({
  counts,
  tall = false,
  total,
}: {
  readonly counts: Readonly<Record<GraderRung, number>>;
  readonly tall?: boolean;
  readonly total: number;
}) {
  if (total === 0) {
    return (
      <div aria-label="no cases" className="h-3.5 min-w-28 flex-1 rounded bg-border" role="img" />
    );
  }
  return (
    <div className={cn("flex min-w-28 flex-1 gap-0.5", tall ? "h-5" : "h-3.5")}>
      {RUNG_ORDER.filter((rung) => counts[rung] > 0).map((rung) => {
        const count = counts[rung];
        const tip = `${RUNG_LABEL[rung]} - ${count} of ${total} case${total === 1 ? "" : "s"} (${Math.round((100 * count) / total)}%). ${RUNG_MEANING[rung]}`;
        return (
          <Tooltip key={rung}>
            <TooltipTrigger
              aria-label={tip}
              className={cn(
                "min-w-1 cursor-pointer first:rounded-l last:rounded-r focus-visible:outline-2 focus-visible:outline-ring",
                SEGMENT_CLASS[rung],
              )}
              style={{ flexGrow: count }}
            />
            <TooltipContent>{tip}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
