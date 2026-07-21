export type Arm = "baseline" | "skill";

export interface CaseAssert {
  readonly graders?: readonly string[];
  readonly must_match?: readonly string[];
  readonly must_not_match?: readonly string[];
}

export interface EvalCase {
  readonly arms?: readonly Arm[];
  readonly assert?: CaseAssert;
  readonly id: string;
  readonly mode: "generation" | "trigger";
  readonly prompt: string;
  readonly rule?: string;
  readonly should_trigger?: boolean;
  readonly trials?: number;
  readonly type?: "capability" | "preference";
}

export interface SkillEvals {
  readonly cases: readonly EvalCase[];
  readonly class: "capability" | "preference";
  readonly skill: string;
}

export interface Check {
  readonly detail: string;
  readonly name: string;
  readonly pass: boolean;
}

export interface TrialResult {
  readonly checks: readonly Check[];
  readonly pass: boolean;
  readonly usage: unknown;
}

export interface ArmResult {
  readonly arm: string;
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
