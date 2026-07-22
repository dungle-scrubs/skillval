/** Registers executor adapters and creates them from validated configuration names. */
import { ClaudeExecutor } from "./claude.js";
import { CodexExecutor } from "./codex.js";
import { PiExecutor } from "./pi.js";
import type { Executor } from "./types.js";

const executorFactories = {
  claude: (): Executor => new ClaudeExecutor(),
  codex: (): Executor => new CodexExecutor(),
  pi: (): Executor => new PiExecutor(),
};

// Both the configuration schema and factory derive from this registry.
export type ExecutorName = keyof typeof executorFactories;
export const EXECUTOR_NAMES = Object.keys(executorFactories) as ExecutorName[];

export function createExecutor(name: ExecutorName): Executor {
  return executorFactories[name]();
}
