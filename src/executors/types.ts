/** Defines the provider-neutral seam between trial orchestration and executor adapters. */
import type { EvalCase, RuntimeArm, Trace } from "../types.js";

export interface ExecutorMetadata {
  // Records how the adapter decides the invoked trigger signal: "structured" means a dedicated
  // tool-use event names the skill; "heuristic" means command or argument text is string-matched
  // for <skill>/SKILL.md, so trigger rates are not directly comparable across executors.
  readonly invocationDetection: "structured" | "heuristic";
  readonly model: string;
  readonly name: string;
  // The thinking/effort level in effect for this run, or "default" when neither an override nor the
  // provider configuration sets one. When --effort is passed it holds the requested level; otherwise
  // it records what the harness would do. Either way it is tied to results and cache identity.
  readonly thinking: string;
  readonly version: string;
}

// Per-run model and effort selection. skillval passes these through to the harness verbatim; each
// adapter validates the effort against its own vocabulary and applies both to the invocation.
export interface ExecutorOverrides {
  readonly effort?: string;
  readonly model?: string;
}

// Fail fast, before any trial spawns, when a requested effort is not in an adapter's vocabulary.
// Model support for a given effort is finer-grained and version-specific, so the harness validates
// the (model, effort) pair itself; skillval owns only the stable per-adapter effort vocabulary.
export function assertEffortSupported(
  executor: string,
  effort: string | undefined,
  allowed: readonly string[],
): void {
  if (effort !== undefined && !allowed.includes(effort)) {
    throw new Error(
      `${executor} does not support effort "${effort}"; valid levels: ${allowed.join(", ")}`,
    );
  }
}

// A skill to install for a trial: its discovery name and the directory holding its SKILL.md.
export interface SeededSkill {
  readonly directory: string;
  readonly name: string;
}

// The instruction file to make ambient for an instruction-target arm: the resolved single-rule
// ablation variant, plus the filename the executor reads natively (AGENTS.md for codex/pi, CLAUDE.md
// for claude). The runner picks the filename from per-executor resolution, so the adapter only writes.
export interface SeededInstruction {
  readonly content: string;
  readonly filename: string;
}

export interface TrialRequest {
  readonly arm: RuntimeArm;
  readonly evalCase: EvalCase;
  readonly home: string;
  // The instruction file this arm makes ambient, for instruction targets. Undefined for skill
  // targets, which seed skills instead.
  readonly seededInstruction?: SeededInstruction;
  // Every skill made discoverable for this arm. The skill arm seeds the target; the baseline arm
  // seeds none. Loadout mode seeds a set. Adapters install exactly this list and nothing else.
  readonly seededSkills: readonly SeededSkill[];
  // The target skill under test, used for trigger detection regardless of what else is seeded.
  readonly skillName: string;
  readonly workspace: string;
}

export interface Executor {
  readonly metadata: ExecutorMetadata;
  runTrial(request: TrialRequest): Trace;
}
