/** Produces single-rule ablation variants of an instruction file from a content-addressed span. */

// The three instruction-file variants that back the group-mode arms for one rule:
//   group = the whole file (the rule plus its in-file siblings, the rule's ambient loadout),
//   peers = the whole file minus the rule (the without-target control),
//   solo  = the rule alone (the rule with no siblings).
export interface AblationVariants {
  readonly group: string;
  readonly peers: string;
  readonly solo: string;
}

export class AblationError extends Error {
  public readonly code = "ABLATION_INVALID";

  public constructor(message: string) {
    super(message);
    this.name = "AblationError";
  }
}

// Splits an instruction file into single-rule ablation variants. The span is content-addressed and
// matched verbatim - authored indentation is part of the address, never trimmed - so a stale or
// ambiguous span fails loudly rather than ablating the wrong text. peers removes exactly the span
// and nothing else, so it differs from group by that span alone.
export function ablateRule(fileContent: string, ruleText: string): AblationVariants {
  if (ruleText === "") {
    throw new AblationError("rule_text is empty");
  }
  const span = locateSpan(fileContent, ruleText);
  return {
    group: fileContent,
    peers: removeOnce(fileContent, span),
    solo: span.endsWith("\n") ? span : `${span}\n`,
  };
}

// Resolves the exact span present in the file. The span must occur exactly once - counting
// overlapping positions, so a self-overlapping needle is still caught as ambiguous. A single
// trailing newline is tolerated because a YAML block scalar (rule_text: |) appends one; the newline
// is dropped only when the verbatim span is absent, never at the cost of a unique verbatim match.
function locateSpan(fileContent: string, ruleText: string): string {
  const candidates = ruleText.endsWith("\n") ? [ruleText, ruleText.slice(0, -1)] : [ruleText];
  for (const candidate of candidates) {
    const count = countOccurrences(fileContent, candidate);
    if (count === 1) return candidate;
    if (count > 1) {
      throw new AblationError(
        `rule_text appears ${count} times in the instruction file; it must be unique`,
      );
    }
  }
  throw new AblationError("rule_text does not appear in the instruction file");
}

// Counts occurrences including overlapping matches: uniqueness must reject a span that overlaps
// itself, so the search advances by one code unit rather than by the needle length.
function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + 1);
  }
  return count;
}

function removeOnce(haystack: string, needle: string): string {
  const index = haystack.indexOf(needle);
  return haystack.slice(0, index) + haystack.slice(index + needle.length);
}
