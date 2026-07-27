/**
 * Stages a skill into a trial so the model sees the skill and nothing else.
 *
 * A skill directory holds its eval definition (`skillval.yml`) beside its SKILL.md, and seeding the
 * directory wholesale hands that file to the agent: the prompts, the must_match answers, and the
 * must_not_match traps. Only target-present arms are seeded, so the leak is ASYMMETRIC - the solo
 * arm can read the answer key while its baseline cannot, which inflates load-bearing verdicts in
 * exactly one direction. Every arm now gets a staged directory that mirrors the skill's real
 * contents by copy, minus the eval definition.
 */
import type { Dirent } from "node:fs";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isAlias, parseDocument, visit } from "yaml";
import { SKIPPED_DIRECTORIES } from "../utils.js";
import { ExecutorInfraError } from "./spawn.js";

// The eval definition is the test, not the skill. It is excluded from what a trial can see, and
// from the skill's content hash, because neither the model nor the cache should treat a change to
// the test as a change to the skill.
export const EVAL_DEFINITION_FILE = "skillval.yml";

const SKILL_FILE = "SKILL.md";

/**
 * Exactly what staging wrote, recorded as it was written.
 *
 * Teardown used to RECONSTRUCT this from the skill source at grading time, which is mutable: a
 * source file removed mid-trial left its staged copy behind to be graded as model output, and a
 * source file added mid-trial made teardown delete something staging never wrote. Recording the
 * truth once removes both, and `directories` distinguishes a directory staging created from one the
 * fixture supplied - only the former may be pruned.
 */
export interface StagedSkill {
  /** Absolute paths of files staging wrote. */
  readonly created: readonly string[];
  /** Absolute paths of directories staging created, outermost first. */
  readonly directories: readonly string[];
  readonly target: string;
}

// The leading `---` block of a SKILL.md, and the key that hides a skill from automatic invocation.
// Frontmatter is located structurally and its value parsed as YAML rather than text-matched: the
// value can be spelled True or TRUE, can carry a trailing comment, and the same line can appear in
// the BODY inside a fenced example, where rewriting it would change what the skill teaches.
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n/;
const OPT_OUT_KEY = "disable-model-invocation";

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
  // A byte-order mark before `---` would hide the frontmatter entirely, leaving the opt-out in
  // place and the arm silently unfalsifiable.
  const bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = bom === "" ? source : source.slice(1);
  const block = FRONTMATTER.exec(body);
  if (block === null) return { changed: false, text: source };
  const [matched, yaml = ""] = block;

  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(yaml, { keepSourceTokens: true });
  } catch {
    return { changed: false, text: source };
  }
  // Malformed frontmatter is left exactly as authored: rewriting something skillval cannot parse
  // is how a staging step corrupts a skill.
  if (document.errors.length > 0) return { changed: false, text: source };
  if (!document.has(OPT_OUT_KEY)) return { changed: false, text: source };
  // `get(key, true)` keeps the node, so an ALIAS value is visible rather than silently resolving to
  // something that is not `true`. `disable-model-invocation: *flag` where `flag` is true opts the
  // skill out for real, and returning early there left the skill hidden and the arm unfalsifiable.
  const node: unknown = document.get(OPT_OUT_KEY, true);
  const value: unknown = isAlias(node)
    ? node.resolve(document)?.toJSON()
    : document.get(OPT_OUT_KEY);
  if (value !== true) return { changed: false, text: source };
  // Refuse ONLY when the pair being removed OWNS an anchor that something else still references -
  // deleting that would leave a dangling alias and a skill that no longer parses. A raw text scan
  // for & or * was tried first and was far too broad: it rejected prose, comments and quoted
  // strings containing those characters, turning valid skills into hard staging failures. An
  // alias-VALUED opt-out is safe to remove, since dropping a reference never breaks its anchor.
  const anchor = isAlias(node) ? undefined : (node as { anchor?: string } | undefined)?.anchor;
  if (typeof anchor === "string" && anchor !== "") {
    let referenced = false;
    visit(document, {
      Alias(_key, alias) {
        if (alias.source === anchor) referenced = true;
      },
    });
    if (referenced) {
      throw new Error(
        `${OPT_OUT_KEY} carries the YAML anchor &${anchor}, which is referenced elsewhere in the ` +
          "frontmatter; removing it would leave a dangling alias",
      );
    }
  }

  document.delete(OPT_OUT_KEY);
  const rewritten = String(document).trimEnd();
  // Reparse what will actually be staged, so a transform that produced invalid YAML never reaches
  // the model.
  const verify = parseDocument(rewritten);
  if (verify.errors.length > 0 || verify.has(OPT_OUT_KEY)) {
    throw new Error(`removing ${OPT_OUT_KEY} produced frontmatter that no longer parses`);
  }
  const rebuilt = matched.replace(yaml, rewritten);
  return { changed: true, text: bom + body.replace(matched, rebuilt) };
}

/**
 * Creates `<parent>/<name>` and COPIES every child of the skill directory into it except the eval
 * definition.
 *
 * Copied, not symlinked, because codex does not discover a skill whose SKILL.md is a symlink: a
 * symlinked skill produced no file read and no skill mention at all, while the same skill copied
 * into place was read and followed. Every codex target-present arm was therefore identical to its
 * own baseline. Claude is unaffected - it resolves symlinked skills normally (observed invoking on
 * 31 of 55 graded trigger trials while staging still symlinked) - but staging is shared, so it
 * copies for everyone rather than branching per executor.
 *
 * SKILL.md is written rather than copied so the staged text can drop the automatic-invocation
 * opt-out without touching the user's file.
 */
/**
 * Copies a directory tree, applying the same exclusions and the same symlink rule as
 * `skillContentHash`, so what the model can read and what the cache key covers are identical.
 *
 * Symlinks are rejected rather than followed. `walkFiles` counts neither a symlink nor its target,
 * while `cpSync` preserves symlinks by default, so a link into a mutable location outside the skill
 * would change what the model reads without changing its content hash - a stale cached verdict with
 * no symptom. Fixtures already reject symlinks; skills now match. No skill in the reference corpus
 * uses one.
 */
function symlinkRejected(path: string): Error {
  return new Error(
    `${path} is a symlink; a skill must contain only regular files and directories, or its ` +
      "content hash cannot cover what the model reads",
  );
}

function copyTree(
  source: string,
  destination: string,
  created: string[],
  directories: string[],
): void {
  const entries = readdirSync(source, { withFileTypes: true });
  if (!existsSync(destination)) directories.push(destination);
  mkdirSync(destination, { recursive: true });
  for (const entry of entries) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isSymbolicLink()) throw symlinkRejected(from);
    if (entry.isDirectory()) {
      copyTree(from, to, created, directories);
      continue;
    }
    if (entry.isFile()) {
      copyFileSync(from, to);
      created.push(to);
    }
  }
}

/**
 * The paths staging creates for a skill, relative to its staged directory.
 *
 * Derived from the source with the same filters staging applies, so it needs no state and cannot
 * drift from what was actually written. The runner uses it to tear down EXACTLY what the harness
 * put there: deleting the staged directory wholesale would also destroy a fixture file that lived
 * at that path, or anything the model itself wrote inside it, and a solo arm that loses its own
 * output fails while its baseline passes - which reads as a no-op and a prune candidate.
 */
export function stagedRelativePaths(skillDirectory: string): string[] {
  const paths: string[] = [];
  const walk = (directory: string, prefix: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      if (prefix === "" && entry.name === EVAL_DEFINITION_FILE) continue;
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(directory, entry.name), relative);
      else if (entry.isFile()) paths.push(relative);
    }
  };
  walk(skillDirectory, "");
  return paths;
}

export function stageSkill(parent: string, name: string, skillDirectory: string): StagedSkill {
  try {
    return stage(parent, name, skillDirectory);
  } catch (error) {
    // Staging happens BEFORE the model runs, so nothing about the skill has been tested when it
    // fails. Permissions, ENOSPC, a dangling symlink or a special file would otherwise surface as
    // an ordinary Error, be recorded as a failing `run` check, and vote against the skill - the
    // same class of false verdict that crashes and provider outages already raise as typed
    // infrastructure. Copy staging introduced many more of these failure modes than symlinking.
    throw new ExecutorInfraError(
      `staging ${name} failed before the trial ran: ${error instanceof Error ? error.message : String(error)}`,
      "staging-failed",
    );
  }
}

function stage(parent: string, name: string, skillDirectory: string): StagedSkill {
  const target = join(parent, name);
  const created: string[] = [];
  const directories: string[] = [];
  if (!existsSync(target)) directories.push(target);
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(skillDirectory, { withFileTypes: true })) {
    if (entry.name === EVAL_DEFINITION_FILE) continue;
    // Exactly what skillContentHash ignores. Staging content the cache key cannot see is a
    // stale-verdict bug: a .git or node_modules under a skill would change what the model reads
    // without changing its identity, and an unbounded node_modules also makes every trial a large
    // recursive copy.
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const source = join(skillDirectory, entry.name);
    const destination = join(target, entry.name);
    if (entry.isSymbolicLink()) throw symlinkRejected(source);
    if (entry.name === SKILL_FILE) {
      writeFileSync(destination, withoutInvocationOptOut(readFileSync(source, "utf8")).text);
      created.push(destination);
      continue;
    }
    // Directories are walked entry by entry rather than handed to a recursive cpSync, so the skip
    // filter applies at EVERY depth: cpSync would copy references/node_modules, which walkFiles -
    // and so skillContentHash - excludes at every depth.
    if (entry.isDirectory()) copyTree(source, destination, created, directories);
    else if (entry.isFile()) {
      copyFileSync(source, destination);
      created.push(destination);
    }
  }
  return { created, directories, target };
}
