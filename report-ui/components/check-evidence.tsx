import type { Check } from "../../src/types.js";

/**
 * Structured rendering for a check's detail string. The graders emit recognizable shapes -
 * "pattern | got: <text>" from regex checks, "... evidence=<command>" from trigger checks - and
 * splitting them into labeled chips and code blocks reads far better than one mono run.
 */
export function CheckEvidence({ check }: { readonly check: Check }) {
  return (
    <div className="grid gap-1 rounded-md border border-border bg-background px-3 py-2">
      <span className="font-mono font-semibold text-[0.68rem] text-muted-foreground uppercase tracking-wide">
        {check.name}
      </span>
      <DetailBody detail={check.detail} />
    </div>
  );
}

/** The same structured body, without the card chrome - for table cells. */
export function DetailBody({ detail }: { readonly detail: string }) {
  const gotIndex = detail.indexOf(" | got: ");
  if (gotIndex >= 0) {
    return (
      <div className="grid gap-1">
        <code className="w-fit max-w-full whitespace-pre-wrap break-words font-mono text-xs">
          {detail.slice(0, gotIndex)}
        </code>
        <div className="grid gap-0.5">
          <span className="text-[0.65rem] text-muted-foreground uppercase tracking-wide">got</span>
          <CodeBlock text={detail.slice(gotIndex + " | got: ".length)} />
        </div>
      </div>
    );
  }
  const evidenceIndex = detail.indexOf("evidence=");
  if (evidenceIndex >= 0) {
    return (
      <div className="grid gap-1">
        <span className="font-mono text-xs">{detail.slice(0, evidenceIndex).trim()}</span>
        <div className="grid gap-0.5">
          <span className="text-[0.65rem] text-muted-foreground uppercase tracking-wide">
            evidence
          </span>
          <CodeBlock text={detail.slice(evidenceIndex + "evidence=".length)} />
        </div>
      </div>
    );
  }
  return <CodeBlock text={detail} />;
}

function CodeBlock({ text }: { readonly text: string }) {
  return (
    <pre className="overflow-x-auto rounded-md border border-border bg-muted/60 px-2.5 py-1.5">
      <code className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
        {text}
      </code>
    </pre>
  );
}
