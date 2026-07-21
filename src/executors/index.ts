/** Registers executor adapters and creates them from validated configuration names. */
import { CodexExecutor } from "./codex.js";
import type { Executor } from "./types.js";

const executorFactories = {
  codex: (): Executor => new CodexExecutor(),
};

// Both the configuration schema and factory derive from this registry.
export type ExecutorName = keyof typeof executorFactories;
export const EXECUTOR_NAMES = Object.keys(executorFactories) as ExecutorName[];

export function createExecutor(name: ExecutorName): Executor {
  return executorFactories[name]();
}
