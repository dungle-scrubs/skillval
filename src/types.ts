/** Collects normalized trace and evaluation result shapes shared across runtime modules. */
import type { Arm } from "./case-contract.js";
import type { Verdict } from "./verdict.js";

export type { Arm, CaseAssert, EvalCase, Fixture, SkillEvals } from "./case-contract.js";

// Arms a run can produce. Case files declare only the solo/baseline pair (Arm); group mode adds the
// group and peers arms, which are generated from --loadout and never authored in a case file.
export type RuntimeArm = Arm | "group" | "peers";

export interface Check {
  readonly detail: string;
  readonly name: string;
  readonly pass: boolean;
}

export interface FixtureCommandResult {
  readonly command: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stderr: string;
  readonly stdout: string;
}

export interface TrialResult {
  readonly checks: readonly Check[];
  readonly fixtureSetup?: readonly FixtureCommandResult[];
  readonly pass: boolean;
  readonly usage: unknown;
}

export interface ArmResult {
  readonly arm: RuntimeArm;
  readonly cached: boolean;
  readonly pass: boolean;
  readonly trials: readonly TrialResult[];
}

// Present only for group-mode cases: which loadout was used and the derived verdict.
export interface LoadoutResult {
  readonly name: string;
  readonly verdict: Verdict;
}

export interface CaseResult {
  readonly arms: readonly ArmResult[];
  readonly id: string;
  readonly loadout?: LoadoutResult;
  readonly noop: boolean;
  readonly pass: boolean;
  readonly rule: string | undefined;
}

export interface Trace {
  readonly agentText: string;
  readonly completed: boolean;
  /** The trace evidence that proved skill invocation, or null when none was detected. */
  readonly invocationEvidence: string | null;
  readonly invoked: boolean;
  readonly usage: unknown;
}
