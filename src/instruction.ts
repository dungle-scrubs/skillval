/** Pure decisions for instruction-file arms: which executors apply and each arm's file variant. */
import type { AblationVariants } from "./ablate.js";
import type { InstructionFile } from "./discovery.js";
import type { RuntimeArm } from "./types.js";

// The three arms an instruction case always runs: single-rule ablation is group mode over one file,
// so an instruction case ignores the solo/baseline pair and runs solo, group, and peers.
export const INSTRUCTION_ARMS: readonly RuntimeArm[] = ["solo", "group", "peers"];

// Which real instruction filenames each executor reads ambiently in a repository, from measured
// behavior. Probed: claude reads CLAUDE.md ambiently but NOT a bare AGENTS.md (a rule in AGENTS.md
// reaches claude only when a sibling CLAUDE.md @imports it - that import path is resolved at the
// content layer, not this static matrix). codex reads AGENTS.md natively. pi reads both with
// AGENTS.md precedence (per pi's resource loader; not yet probed here - validate before relying on
// the pi column).
const EXECUTOR_AMBIENT_FILES: Record<string, readonly InstructionFile[]> = {
  claude: ["CLAUDE.md"],
  codex: ["AGENTS.md"],
  pi: ["AGENTS.md", "CLAUDE.md"],
};

// An instruction target is applicable to an executor when the executor reads at least one of the
// target's files ambiently. This static check is a coarse gate on the target's filenames; the
// precise per-case decision (does the executor's RESOLVED content, with @imports expanded, contain
// the rule span) is made when the arm is built. Not-applicable is reported as n/a, never pass/fail.
export function instructionApplicable(
  executorName: string,
  files: readonly InstructionFile[],
): boolean {
  const ambient = EXECUTOR_AMBIENT_FILES[executorName] ?? [];
  return files.some((file) => ambient.includes(file));
}

// The file whose content backs the ablation variants: prefer the portable AGENTS.md when present,
// otherwise CLAUDE.md. v1 targets are single-file in practice; this fixes the choice deterministically
// when both exist.
export function instructionSourceFile(
  files: readonly InstructionFile[],
): InstructionFile | undefined {
  if (files.includes("AGENTS.md")) return "AGENTS.md";
  if (files.includes("CLAUDE.md")) return "CLAUDE.md";
  return undefined;
}

// One of a target's instruction files, with its content read from disk.
export interface InstructionFileContent {
  readonly content: string;
  readonly file: InstructionFile;
}

// Resolves the instruction file that this executor reads natively AND that actually contains the
// rule span - the file the arm ablates and seeds. Returns undefined when the rule is not in this
// executor's ambient context, which the runner reports as n/a (never a pass or a fail).
//
// v1 grades a rule in the file the executor reads natively. A rule that reaches claude only through
// a CLAUDE.md `@import` of AGENTS.md is therefore n/a for claude in v1; cross-file import ablation
// is v2 (see the design doc).
export function resolveRuleFile(
  executorName: string,
  files: readonly InstructionFileContent[],
  ruleText: string,
): InstructionFile | undefined {
  if (ruleText === "") return undefined;
  // Precedence follows each executor's native reading order (pi reads AGENTS.md before CLAUDE.md).
  for (const candidate of EXECUTOR_AMBIENT_FILES[executorName] ?? []) {
    const match = files.find((entry) => entry.file === candidate);
    if (match?.content.includes(ruleText) === true) return candidate;
  }
  return undefined;
}

// The resolved instruction content an arm makes ambient. Instruction cases never run baseline; the
// solo, group, and peers arms are the single-rule ablation variants.
export function armInstructionContent(arm: RuntimeArm, variants: AblationVariants): string {
  switch (arm) {
    case "group":
      return variants.group;
    case "peers":
      return variants.peers;
    default:
      return variants.solo;
  }
}
