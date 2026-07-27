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
import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The eval definition is the test, not the skill. It is excluded from what a trial can see, and
// from the skill's content hash, because neither the model nor the cache should treat a change to
// the test as a change to the skill.
export const EVAL_DEFINITION_FILE = "skillval.yml";

const SKILL_FILE = "SKILL.md";

// Frontmatter key that hides a skill from automatic invocation. Matched on its own line inside the
// leading `---` block.
const DISABLE_MODEL_INVOCATION = /^disable-model-invocation:[ \t]*true[ \t]*\r?\n/m;

/**
 * Whether a SKILL.md opts out of automatic invocation, and the text with that opt-out removed.
 *
 * `disable-model-invocation: true` marks a skill the USER invokes deliberately (a slash command),
 * never one the model reaches for on its own. Claude Code honours that by withholding the skill
 * from the model entirely: it appears in no skill listing, no Skill tool call can name it, and its
 * body never enters the context. Verified by a controlled A/B - an identical skill staged with the
 * flag was never invoked and its instruction never followed, while without the flag the model
 * emitted a Skill tool_use and complied.
 *
 * That makes a seeded target-present arm identical to its own baseline, so every case on such a
 * skill is unfalsifiable on this executor. Since a case for a user-invoked skill is modelling a
 * user who ALREADY invoked it, staging drops the flag: the eval's question is whether the skill's
 * content changes behavior, not whether the model would have reached for it unprompted.
 *
 * The consequence for case authors: a `should_trigger: false` case on such a skill grades
 * automatic invocation, which production has switched off, so it can only report a problem that
 * cannot happen. Those cases are tautologies and belong in neither corpus.
 */
export function withoutInvocationOptOut(source: string): { changed: boolean; text: string } {
  const text = source.replace(DISABLE_MODEL_INVOCATION, "");
  return { changed: text !== source, text };
}

/**
 * Creates `<parent>/<name>` and links every child of the skill directory into it except the eval
 * definition. Children are linked individually rather than the directory being copied, so a
 * reference the skill loads on demand still resolves to the real file. SKILL.md is copied instead
 * of linked when it opts out of automatic invocation, so the staged copy can drop that opt-out
 * without touching the user's file.
 */
export function stageSkill(parent: string, name: string, skillDirectory: string): string {
  const target = join(parent, name);
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(skillDirectory)) {
    if (entry === EVAL_DEFINITION_FILE) continue;
    const source = join(skillDirectory, entry);
    if (entry === SKILL_FILE) {
      const staged = withoutInvocationOptOut(readFileSync(source, "utf8"));
      if (staged.changed) {
        writeFileSync(join(target, entry), staged.text);
        continue;
      }
    }
    symlinkSync(source, join(target, entry));
  }
  return target;
}
