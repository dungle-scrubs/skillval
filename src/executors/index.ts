/** Registers executor adapters and creates them from validated configuration names. */
import { ClaudeExecutor } from "./claude.js";
import { CodexExecutor } from "./codex.js";
import { PiExecutor } from "./pi.js";
import type { Executor, ExecutorOverrides } from "./types.js";

const executorFactories = {
  claude: (overrides: ExecutorOverrides): Executor => new ClaudeExecutor(overrides),
  codex: (overrides: ExecutorOverrides): Executor => new CodexExecutor(overrides),
  pi: (overrides: ExecutorOverrides): Executor => new PiExecutor(overrides),
};

// Both the configuration schema and factory derive from this registry.
export type ExecutorName = keyof typeof executorFactories;
export const EXECUTOR_NAMES = Object.keys(executorFactories) as ExecutorName[];

export function createExecutor(name: ExecutorName, overrides: ExecutorOverrides = {}): Executor {
  return executorFactories[name](overrides);
}
