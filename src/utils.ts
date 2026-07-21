import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function walkFiles(root: string): string[] {
  const files: string[] = [];
  const skippedDirectories = new Set([".git", "node_modules"]);

  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (skippedDirectories.has(entry.name)) continue;
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
