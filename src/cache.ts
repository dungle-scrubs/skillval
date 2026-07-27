/** Owns arm-result persistence and keeps cache-key construction private from the runner. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveStateDirectory } from "./config.js";
import type { ExecutorMetadata } from "./executors/types.js";
import type { ArmResult, EvalCase, RuntimeArm } from "./types.js";
import { sha256 } from "./utils.js";

// Bump this whenever execution or grading semantics change so old results cannot be reused.
// 13: instruction-file arms and the instructionHash cache-identity field.
// 14: agent stdout captured with a 256MB cap; overflow/timeout recorded as an infrastructure
//     failure instead of a content result, changing the verdict of large-output trials.
// 15: trigger detection changed - pi is structured (read toolCall path only; other tools
//     mentioning the path no longer count), codex counts only completed exit-0 commands - so
//     cached should_trigger results could decode differently.
// 16: provider-availability failures (quota, rate limit, auth) classify as infrastructure
//     instead of content run-failures, so such trials change outcome and must not be reused.
// 17: skills are staged without their eval definition, so a target-present arm can no longer read
//     its own prompts and asserts - an asymmetric leak that inflated load-bearing verdicts.
// 18: an agent CLI exiting nonzero WITHOUT completing a turn is infrastructure, not a content
//     failure. Version 16 only caught provider failures that announce themselves in text; an exit
//     with an empty stderr announced nothing and was cached as a FAIL the model never earned.
// 19: staging strips `disable-model-invocation: true` from SKILL.md. Claude Code withholds such a
//     skill from the model entirely, so a target-present arm was identical to its own baseline and
//     every case on those skills was unfalsifiable - their cached verdicts measured nothing.
// 20: skills are staged by COPY, not symlink. codex does not discover a skill whose SKILL.md is a
//     symlink, so every codex target-present arm was identical to its own baseline and no codex
//     verdict on a seeded skill measured anything.
// 21: staged skills are excluded from the graded text. Copy-staging (20) put the skill's own
//     SKILL.md in the workspace, so generation mode graded skillval's input as model output - a
//     must_not_match trap fired on the skill's prose, and a must_match could pass on text the
//     model never wrote.
// 22: staged skills are REMOVED from the workspace before grading. Version 21 excluded them from
//     the regex graders only; command_exit, ast and tsc still received the raw workspace, so a
//     case asserting on the whole tree (e.g. `test -z "$(find . -type f)"`) saw skillval's own
//     staged files in every target-present arm.
// 23: three review findings that change what a trial sees or how it is keyed. Staging now skips
//     .git and node_modules so it stages exactly what skillContentHash counts (content the model
//     could read without changing the cache key was a stale-verdict bug); the invocation opt-out is
//     removed by parsing frontmatter as YAML, so True/TRUE and trailing comments are honoured and a
//     fenced example in the body is never rewritten.
// 24: four more review findings. A trial with no completed turn is infrastructure whatever the
//     exit status (a ZERO exit with a truncated trace was graded as content and cached); a staging
//     failure before the model runs is infrastructure rather than a FAIL voting against the skill;
//     and staged-path exclusion/teardown now uses the ACTIVE executor's root instead of every
//     known root, which could delete model output living under another executor's path.
// 25: pi's agent_end alone no longer counts as a completed turn. Verified against a live pi trace:
//     assistant messages carry stopReason and agent_end carries willRetry, so an aborted, errored
//     or to-be-retried turn was being graded as a content result.
// 26: second-review fixes that change what a trial sees. pi now classifies an incomplete turn as
//     infrastructure regardless of exit status (its JSON mode exits 0 on an errored turn, so the
//     v25 stopReason check was never reached); staging applies its skip filter at every depth
//     rather than only the top level; and a symlink inside a skill is rejected instead of staged,
//     because walkFiles counts neither a link nor its target and external content could change
//     what the model reads without changing the cache key.
// 27: teardown removes only the files staging wrote, so a fixture file or model output living
//     inside the staged skill directory survives to be graded; and pi's completion check became an
//     allow-list of gradeable stop reasons, so an unfamiliar or missing reason fails closed as
//     infrastructure instead of being graded as content and cached.
// 28: the invocation opt-out is removed through the YAML document rather than by deleting a
//     physical line. A quoted key parsed as the property but survived the line delete, so staging
//     reported a change while writing byte-identical text and the arm stayed hidden; a leading BOM
//     hid the frontmatter entirely; and anchors now raise instead of risking a dangling alias.
// 29: third-review fixes. Teardown now deletes from an immutable manifest staging records as it
//     writes, with lstat guards - it previously RECONSTRUCTED the list from mutable source state
//     and would follow a model-planted symlink out of the workspace. Symlinked skills are rejected
//     at hash time, upstream of the cache, so adding one to a cached skill can no longer return a
//     stale verdict. An alias-valued opt-out is now detected. pi's allow-list matches pi's real
//     normalized reasons rather than raw provider spellings.
// 30: grading runs against a SNAPSHOT of the workspace instead of deleting staged files out of it.
//     Deleting could not be made safe - identifying what to remove by pathname, in a tree the model
//     rewrites, meant an intermediate symlink was already followed by the time the leaf was checked.
//     A staged file is now omitted from the snapshot only while its bytes still match what staging
//     wrote, so an edited one is graded as the output it is, and symlinks are never reproduced.
// 31: staging lifecycle is returned separately from the provider trace, so an adapter can no
//     longer compile while silently omitting it and causing its own seeded input to be graded; and
//     a skill whose content hash cannot be taken (a symlinked one) is reported as an INVALID skill
//     at discovery rather than throwing mid-run and aborting every other skill with it.
// 32: the invocation opt-out is spliced out by its own source byte range instead of the document
//     being re-serialized. String(document) normalized flow spacing, rewrote comment whitespace and
//     could change the value of a trailing |+ block scalar - a staging step silently editing a
//     skill it was only asked to read.
// 33: the graded tree is a FAITHFUL copy with staged files removed, standing at the workspace's own
//     path. The previous selective copy was lossy in exactly the ways that manufacture false
//     failures - a model's own empty directory vanished, and a symlink a fixture was told to create
//     was erased - and grading under a different prefix broke generated files carrying absolute
//     paths. Escaping links are dropped, internal ones kept, absolute internal ones repointed.
export const RUNNER_VERSION = 35;

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
