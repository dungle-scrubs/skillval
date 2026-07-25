import { CircleHelpIcon } from "lucide-react";
import type { ReasonSegment } from "../../src/report-model.js";
import { TERMS, type TermKey } from "../../src/report-terms.js";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

/**
 * A glossary term at point of use. The affordance is unmistakable: a primary-tinted chip with a
 * dotted underline and a help glyph, opening a rich popover that re-teaches the term - what it
 * means, how skillval computes it, and what to do about it.
 */
export function Term({ k, text }: { readonly k: TermKey; readonly text?: string }) {
  const term = TERMS[k];
  return (
    <Popover>
      <PopoverTrigger className="inline-flex cursor-pointer items-baseline gap-0.5 rounded-sm bg-primary/10 px-1 font-medium text-primary underline decoration-dotted decoration-primary/60 underline-offset-3 transition-colors hover:bg-primary/20 focus-visible:outline-2 focus-visible:outline-ring">
        {text ?? term.title}
        <CircleHelpIcon aria-hidden className="size-2.5 self-center opacity-70" />
      </PopoverTrigger>
      <PopoverContent className="w-96">
        <p className="font-mono text-[0.68rem] text-primary uppercase tracking-widest">
          terminology
        </p>
        <h3 className="mt-0.5 font-semibold text-base">{term.title}</h3>
        <dl className="mt-3 space-y-3">
          <TermSection label="What it means" value={term.what} />
          <TermSection label="How it is computed" value={term.how} />
          <TermSection label="What to do" value={term.act} />
        </dl>
      </PopoverContent>
    </Popover>
  );
}

function TermSection({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt className="font-semibold text-[0.68rem] text-muted-foreground uppercase tracking-wide">
        {label}
      </dt>
      <dd className="mt-0.5 text-sm leading-relaxed">{value}</dd>
    </div>
  );
}

/** Renders a report-model reason sentence, expanding term segments into popovers. */
export function ReasonText({ segments }: { readonly segments: readonly ReasonSegment[] }) {
  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === "term" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: static, order-stable segment list
          <Term k={segment.term} key={index} text={segment.text} />
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: static, order-stable segment list
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}
