/** Owns arm-result persistence and keeps cache-key construction private from the runner. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveStateDirectory } from "./config.js";
import type { ExecutorMetadata } from "./executors/types.js";
import type { Arm, ArmResult, EvalCase } from "./types.js";
import { sha256 } from "./utils.js";

// Bump this whenever execution or grading semantics change so old results cannot be reused.
export const RUNNER_VERSION = 10;

export interface ArmCacheIdentity {
  readonly arm: Arm;
  readonly evalCase: EvalCase;
  readonly executor: ExecutorMetadata;
  readonly fixtureHash?: string;
  // Order-independent hash of the set of skills seeded in this arm (see loadoutHash). The empty
  // baseline hashes an empty set, so it stays independent of any skill's content.
  readonly loadoutHash: string;
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
    // Every input that can change an arm result belongs in this identity. loadoutHash captures the
    // exact set of skills seeded in this arm, so an arm's key changes precisely when its membership
    // or a member's content changes - and the empty baseline (no skills seeded) stays independent
    // of any skill's content, which is why editing a skill never busts its baseline.
    const parts = [
      String(RUNNER_VERSION),
      identity.loadoutHash,
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
