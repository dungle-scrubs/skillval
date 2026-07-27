import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { EVAL_DEFINITION_FILE } from "./executors/seed.js";

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

// Whether trace text reads the target skill's SKILL.md as a whole path segment. The skill name must
// sit at the start of a path or after a non-name character, so a peer named "commit-<name>" is not
// mistaken for target "<name>", while relative reads like "cat <name>/SKILL.md" still match.
export function readsSkillMarkdown(text: string, skillName: string): boolean {
  const escaped = skillName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^\\w-])${escaped}/SKILL\\.md`).test(text);
}

// Whether a structured file path (a tool call's actual path argument, not free command text) targets
// the skill's SKILL.md: the final two path segments must be exactly <skillName>/SKILL.md, so a
// sibling like SKILL.md.bak, a child path under SKILL.md, or a lookalike skill name never matches.
// Both separators are handled so a Windows-style path is recognized.
export function pathTargetsSkillMarkdown(path: string, skillName: string): boolean {
  const segments = path.split(/[/\\]+/).filter((segment) => segment !== "");
  return segments.length >= 2 && segments.at(-1) === "SKILL.md" && segments.at(-2) === skillName;
}

// Order-independent hash of the set of skills seeded in an arm. A set defines an arm, not an
// ordering, so members are framed then sorted. Each member frames both its name and its content
// hash, because skills install under their names: two identically-hashed skills with different
// names are different seeded environments. The count is included so the empty set (the no-skill
// baseline) is distinct, and every part is length-framed so concatenation is unambiguous.
export function loadoutHash(
  members: readonly { readonly contentHash: string; readonly name: string }[],
): string {
  const framed = [...members]
    .map(
      ({ contentHash, name }) => `${name.length}\0${name}\0${contentHash.length}\0${contentHash}`,
    )
    .sort()
    .join("\0");
  return sha256(`loadout\0${members.length}\0${framed}`);
}

// Directories that never contribute to content identity or workspace materialization.
export const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([".git", "node_modules"]);

// Whether `child` sits strictly inside `parent`, comparing whole path segments and accepting both
// separators. A `startsWith(parent + "/")` test is POSIX-only - it never matches a Windows path, so
// every staged file would stay in the graded text and the seeded-skill leak would return silently -
// and it also treats a lookalike sibling ("s-other" under "s") as contained.
export function pathContains(parent: string, child: string): boolean {
  const split = (path: string): string[] => path.split(/[/\\]+/).filter((part) => part !== "");
  const from = split(parent);
  const into = split(child);
  if (into.length <= from.length) return false;
  return from.every((part, index) => into[index] === part);
}

export function walkFiles(root: string, symlinks: string[] = []): string[] {
  const files: string[] = [];

  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const path = join(directory, entry.name);
      // A symlink is counted by neither branch below, so its target's bytes never reach the content
      // hash. Staging rejects symlinked skills - but staging runs AFTER the cache lookup, so a
      // symlink added to an already-cached skill would return the cached verdict and never be
      // rejected. Surfacing it here puts the rejection before the cache.
      if (entry.isSymbolicLink()) symlinks.push(path);
      else if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  }

  visit(root);
  return files.sort();
}

// Hashes what a trial can actually SEE, which is why the eval definition is excluded: it is never
// seeded (see stageSkill), and counting it would also bust every cached arm of a skill whenever any
// one of its cases is edited - the case JSON already keys each case's own arms.
export function skillContentHash(skillDirectory: string): string {
  const symlinks: string[] = [];
  const files = walkFiles(skillDirectory, symlinks);
  // Rejected HERE, not at staging time. A symlink's target contributes no bytes to this hash, so a
  // symlink added to an already-cached skill would leave the hash unchanged, return the cached
  // verdict, and never reach the staging check that rejects it. Hashing is upstream of the cache,
  // so this is the only place the rejection is reachable in every path.
  const [first] = symlinks;
  if (first !== undefined) {
    throw new Error(
      `${first} is a symlink; a skill must contain only regular files and directories, or its ` +
        "content hash cannot cover what the model reads",
    );
  }
  const parts = files
    .filter((file) => relative(skillDirectory, file) !== EVAL_DEFINITION_FILE)
    .map((file) => `${relative(skillDirectory, file)}\n${readFileSync(file, "utf8")}`);
  return sha256(parts.join("\0"));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
