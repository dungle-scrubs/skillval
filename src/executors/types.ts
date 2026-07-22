/** Defines the provider-neutral seam between trial orchestration and executor adapters. */
import type { Arm, EvalCase, Trace } from "../types.js";

export interface ExecutorMetadata {
  readonly model: string;
  readonly name: string;
  // The provider-configured thinking/effort level in effect for this run, or "default" when the
  // provider configuration does not set one. Captured, never controlled: skillval records what
  // the harness would do so results and cache identity are tied to it.
  readonly thinking: string;
  readonly version: string;
}

export interface TrialRequest {
  readonly arm: Arm;
  readonly evalCase: EvalCase;
  readonly home: string;
  readonly skillDirectory: string;
  readonly skillName: string;
  readonly workspace: string;
}

export interface Executor {
  readonly metadata: ExecutorMetadata;
  runTrial(request: TrialRequest): Trace;
}
