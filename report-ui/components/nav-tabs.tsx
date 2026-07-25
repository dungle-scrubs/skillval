import { cn } from "../lib/utils";

const tabClass =
  "rounded-t-lg border border-border border-b-0 px-3 py-1.5 font-semibold text-sm no-underline";

/**
 * The two-page nav. Relative links within the reports directory (works from file://); an archived
 * hash-named report never claims to be the latest run.
 */
export function NavTabs({ active }: { readonly active: "coverage" | "run" | "run-archive" }) {
  return (
    <nav aria-label="report pages" className="mt-4 flex gap-1">
      {active === "run" ? (
        <ActiveTab>Latest run</ActiveTab>
      ) : (
        <LinkTab href="latest.html">Latest run</LinkTab>
      )}
      {active === "run-archive" ? <ActiveTab>This run (archived)</ActiveTab> : null}
      {active === "coverage" ? (
        <ActiveTab>Coverage</ActiveTab>
      ) : (
        <LinkTab href="coverage.html">Coverage</LinkTab>
      )}
    </nav>
  );
}

function ActiveTab({ children }: { readonly children: React.ReactNode }) {
  return (
    <span aria-current="page" className={cn(tabClass, "bg-card text-primary")}>
      {children}
    </span>
  );
}

function LinkTab({
  children,
  href,
}: {
  readonly children: React.ReactNode;
  readonly href: string;
}) {
  return (
    <a
      className={cn(tabClass, "cursor-pointer text-muted-foreground hover:text-foreground")}
      href={href}
    >
      {children}
    </a>
  );
}
