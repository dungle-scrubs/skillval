/** Classifies a group-mode case from its three arm results into a single plain-language verdict. */

export type Verdict = "inconclusive" | "interference" | "load-bearing" | "prune" | "redundant";

// User-facing wording, used in the report and the run summary. Kept plain on purpose.
export const VERDICT_TEXT: Record<Verdict, string> = {
  inconclusive: "inconclusive - see the arm results",
  interference: "interferes with your other skills",
  "load-bearing": "works and is needed here",
  prune: "not needed at all",
  redundant: "redundant - another skill already does it",
};

// The four verdicts that drive action, from the pass/fail of the three arms:
//   solo   = the skill alone,  group = the skill within the loadout,  peers = the loadout minus it.
// Interference keys on the skill working alone but not within the loadout - but only when the
// target's presence is what makes the difference. If the peers arm is meaningful and also fails, the
// loadout breaks the case without the target at all, so blaming the target ("interferes with your
// other skills") points at the wrong skill; that is left inconclusive - the finding is about the
// peers, not this skill. When peers pass, or the peers arm is a vacuous trigger-only arm (below),
// solo-vs-group still isolates the target, so interference stands.
//
// The load-bearing / redundant / prune verdicts compare group against peers, so they are only
// trustworthy when the peers arm was actually graded on the case's behavior. For a pure trigger-only
// case (should_trigger and nothing else) the peers arm has no behavioral check - the target-specific
// trigger check is skipped when the target is absent - so a completed peers trace passes vacuously.
// peersMeaningful is false there, and any non-interference outcome is left inconclusive rather than
// misreported as redundant or a no-op. Any unmatched combination is inconclusive too.
export function groupVerdict(
  solo: boolean,
  group: boolean,
  peers: boolean,
  peersMeaningful: boolean,
): Verdict {
  if (solo && !group) {
    // Peers meaningful and also failing means the loadout breaks the case on its own; the target is
    // not the culprit, so do not attribute interference to it.
    if (peersMeaningful && !peers) return "inconclusive";
    return "interference";
  }
  if (!peersMeaningful) return "inconclusive";
  if (group && !peers) return "load-bearing";
  // prune before redundant: if the skill fails alone, "not needed at all" fits better than
  // "another skill already does it" (which implies the skill is itself capable).
  if (!solo && peers) return "prune";
  if (group && peers) return "redundant";
  return "inconclusive";
}
