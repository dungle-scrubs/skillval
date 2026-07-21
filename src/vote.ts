import type { TrialResult } from "./types.js";

export function clampedTrialCount(configured: number | undefined): number {
  return Math.min(5, Math.max(1, configured ?? 1));
}

export function hasMajority(trials: readonly Pick<TrialResult, "pass">[]): boolean {
  const passes = trials.filter((trial) => trial.pass).length;
  return passes * 2 > trials.length;
}

export function shouldEscalate(trials: readonly Pick<TrialResult, "pass">[]): boolean {
  return new Set(trials.map((trial) => trial.pass)).size > 1 && trials.length < 5;
}
