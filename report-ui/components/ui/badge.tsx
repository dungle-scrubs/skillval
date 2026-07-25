import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../../lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-sm border px-1.5 py-0.5 font-semibold text-[0.7rem] uppercase tracking-wide",
  {
    defaultVariants: { variant: "muted" },
    variants: {
      variant: {
        destructive: "border-destructive/50 text-destructive",
        keep: "border-success/50 text-success",
        muted: "border-border text-muted-foreground",
        primary: "border-primary/50 text-primary",
        warn: "border-warning/50 text-warning",
      },
    },
  },
);

function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} data-slot="badge" {...props} />
  );
}

export { Badge, badgeVariants };
