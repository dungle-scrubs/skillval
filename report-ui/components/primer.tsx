import { ChevronRightIcon } from "lucide-react";
import type * as React from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";

/** The collapsed 20-second refresher each page opens with. */
export function Primer({
  children,
  title,
}: {
  readonly children: React.ReactNode;
  readonly title: string;
}) {
  return (
    <Collapsible className="mb-5 rounded-lg border border-border bg-card">
      <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-1.5 px-3.5 py-2.5 text-left font-semibold text-muted-foreground text-sm hover:text-foreground data-[state=open]:border-border data-[state=open]:border-b data-[state=open]:text-foreground">
        <ChevronRightIcon className="size-4 text-primary transition-transform group-data-[state=open]:rotate-90" />
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2.5 px-3.5 py-3 text-sm leading-relaxed">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
