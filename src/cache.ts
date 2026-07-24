/** Owns arm-result persistence and keeps cache-key construction private from the runner. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveStateDirectory } from "./config.js";
import type { ExecutorMetadata } from "./executors/types.js";
import type { ArmResult, EvalCase, RuntimeArm } from "./types.js";
import { sha256 } from "./utils.js";

// Bump this whenever execution or grading semantics change so old results cannot be reused.
// 13: instruction-file arms and the instructionHash cache-identity field.
export const RUNNER_VERSION = 13;

export interface ArmCacheIdentity {
  readonly arm: RuntimeArm;
  readonly evalCase: EvalCase;
  readonly executor: ExecutorMetadata;
  readonly fixtureHash?: string;
  // Content hash of the resolved instruction file this arm makes ambient, set only for instruction
  // targets. Two instruction cases can share identical case JSON (id, prompt, rule_text) while their
  // surrounding rules differ, so the seeded content - not just the case - must key the arm. Omitted
  // for skill targets, whose seeded set is captured by loadoutHash instead.
  readonly instructionHash?: string;
  // Order-independent hash of the set of skills seeded in this arm (see loadoutHash). The empty
  // baseline hashes an empty set, so it stays independent of any skill's content.
  readonly loadoutHash: string;
  // The target skill whose invocation should_trigger grades, set only for target-present arms
  // (solo, group). It disambiguates the group arms of two different targets that are both members
  // of the same loadout - their seeded sets, and so their loadoutHash, are identical, but the
  // target-specific trigger check is not. Omitted for baseline and peers, which do not grade the
  // target, so their results stay shareable across skills.
  readonly triggerTarget?: string;
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

  // The canonical content-addressed key for an arm identity. Two identities collide here exactly when
  // a real run would reuse one arm's stored result for the other, so a dry run can dedup identities it
  // has already scheduled without duplicating this derivation.
  public keyFor(identity: ArmCacheIdentity): string {
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
    // Appended conditionally and framed so fixture-free, single-arm identities keep stable keys and
    // a skill name can never be mistaken for a fixture hash.
    if (identity.fixtureHash !== undefined) parts.push(`fixture\0${identity.fixtureHash}`);
    if (identity.instructionHash !== undefined) {
      parts.push(`instruction\0${identity.instructionHash}`);
    }
    if (identity.triggerTarget !== undefined) parts.push(`target\0${identity.triggerTarget}`);
    return sha256(parts.join("\0"));
  }

  #path(identity: ArmCacheIdentity): string {
    return join(this.#stateDirectory, "cache", `${this.keyFor(identity)}.json`);
  }
}
