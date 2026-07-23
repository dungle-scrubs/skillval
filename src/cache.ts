/** Owns arm-result persistence and keeps cache-key construction private from the runner. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveStateDirectory } from "./config.js";
import type { ExecutorMetadata } from "./executors/types.js";
import type { Arm, ArmResult, EvalCase } from "./types.js";
import { sha256 } from "./utils.js";

// Bump this whenever execution or grading semantics change so old results cannot be reused.
export const RUNNER_VERSION = 9;

export interface ArmCacheIdentity {
  readonly arm: Arm;
  readonly evalCase: EvalCase;
  readonly executor: ExecutorMetadata;
  readonly fixtureHash?: string;
  readonly skillHash: string;
}

export class ArmCache {
  readonly #stateDirectory: string;

  public constructor(stateDirectory = resolveStateDirectory()) {
    this.#stateDirectory = stateDirectory;
  }

  public lookup(identity: ArmCacheIdentity): ArmResult | undefined {
    const path = this.#path(identity);
    if (!existsSync(path)) return undefined;
    return { ...(JSON.parse(readFileSync(path, "utf8")) as ArmResult), cached: true };
  }

  public store(identity: ArmCacheIdentity, result: ArmResult): void {
    const path = this.#path(identity);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(result));
  }

  #path(identity: ArmCacheIdentity): string {
    // Every input that can change an arm result belongs in this identity. The baseline arm never
    // installs the skill, so its result cannot depend on skill content; excluding the skill hash
    // from the baseline key lets a baseline result survive skill edits, roughly halving recompute
    // on the iterate-a-skill-and-re-run loop.
    const skillComponent = identity.arm === "skill" ? identity.skillHash : "";
    const parts = [
      String(RUNNER_VERSION),
      skillComponent,
      JSON.stringify(identity.evalCase),
      identity.arm,
      identity.executor.name,
      identity.executor.version,
      identity.executor.model,
      identity.executor.thinking,
    ];
    // Appended conditionally so fixture-free identities keep their historical keys.
    if (identity.fixtureHash !== undefined) parts.push(identity.fixtureHash);
    const key = sha256(parts.join("\0"));
    return join(this.#stateDirectory, "cache", `${key}.json`);
  }
}
