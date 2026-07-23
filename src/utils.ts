import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
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

export function walkFiles(root: string): string[] {
  const files: string[] = [];

  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  }

  visit(root);
  return files.sort();
}

export function skillContentHash(skillDirectory: string): string {
  const parts = walkFiles(skillDirectory).map(
    (file) => `${relative(skillDirectory, file)}\n${readFileSync(file, "utf8")}`,
  );
  return sha256(parts.join("\0"));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
