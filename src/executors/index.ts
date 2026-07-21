import type { SkillvalConfig } from "../config.js";
import { CodexExecutor } from "./codex.js";
import type { Executor } from "./types.js";

export function createExecutor(config: SkillvalConfig): Executor {
  switch (config.executor) {
    case "codex":
      return new CodexExecutor();
  }
}
