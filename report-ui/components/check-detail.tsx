import type { Check } from "../../src/types.js";

/** A failing check's evidence: the pattern and the got: snippet, side by side and untruncated. */
export function CheckDetail({ check }: { readonly check: Check }) {
  return (
    <pre className="overflow-x-auto rounded-md border border-border bg-background px-3 py-2 text-xs leading-relaxed">
      <code className="whitespace-pre-wrap break-words font-mono">
        {check.name}: {check.detail}
      </code>
    </pre>
  );
}
