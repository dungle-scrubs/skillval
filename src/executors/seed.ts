/**
 * Stages a skill into a trial so the model sees the skill and nothing else.
 *
 * A skill directory holds its eval definition (`skillval.yml`) beside its SKILL.md, and seeding the
 * directory wholesale hands that file to the agent: the prompts, the must_match answers, and the
 * must_not_match traps. Only target-present arms are seeded, so the leak is ASYMMETRIC - the solo
 * arm can read the answer key while its baseline cannot, which inflates load-bearing verdicts in
 * exactly one direction. Every arm now gets a staged directory that mirrors the skill's real
 * contents by symlink, minus the eval definition.
 */
import { mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";

// The eval definition is the test, not the skill. It is excluded from what a trial can see, and
// from the skill's content hash, because neither the model nor the cache should treat a change to
// the test as a change to the skill.
export const EVAL_DEFINITION_FILE = "skillval.yml";

/**
 * Creates `<parent>/<name>` and links every child of the skill directory into it except the eval
 * definition. Children are linked individually rather than the directory being copied, so a
 * reference the skill loads on demand still resolves to the real file.
 */
export function stageSkill(parent: string, name: string, skillDirectory: string): string {
  const target = join(parent, name);
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(skillDirectory)) {
    if (entry === EVAL_DEFINITION_FILE) continue;
    symlinkSync(join(skillDirectory, entry), join(target, entry));
  }
  return target;
}
