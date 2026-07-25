import type { Check } from "../../src/types.js";
import { CheckEvidence } from "./check-evidence";

/** A failing check's evidence on a what-to-change card. */
export function CheckDetail({ check }: { readonly check: Check }) {
  return <CheckEvidence check={check} />;
}
