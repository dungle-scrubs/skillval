/** Collects normalized trace and evaluation result shapes shared across runtime modules. */
import type { Arm } from "./case-contract.js";

export type { Arm, CaseAssert, EvalCase, Fixture, SkillEvals } from "./case-contract.js";

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
  readonly arm: Arm;
  readonly cached: boolean;
  readonly pass: boolean;
  readonly trials: readonly TrialResult[];
}

export interface CaseResult {
  readonly arms: readonly ArmResult[];
  readonly id: string;
  readonly noop: boolean;
  readonly pass: boolean;
  readonly rule: string | undefined;
}

export interface Trace {
  readonly agentText: string;
  readonly completed: boolean;
  readonly invoked: boolean;
  readonly usage: unknown;
}
