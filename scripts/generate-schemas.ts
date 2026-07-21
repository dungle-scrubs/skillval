/** Materializes and verifies the published JSON Schemas from executable TypeBox contracts. */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { skillEvalsSchema } from "../src/case-contract.js";
import { configFileSchema } from "../src/config-contract.js";

const schemas = [
  ["schemas/config.schema.json", configFileSchema],
  ["schemas/skillval.schema.json", skillEvalsSchema],
] as const;

for (const [relativePath, schema] of schemas) {
  const schemaPath = resolve(relativePath);
  const generated = formatJson(`${JSON.stringify(schema, null, 2)}\n`, relativePath);
  if (process.argv.includes("--check")) {
    if (readFileSync(schemaPath, "utf8") !== generated) {
      throw new Error(`${relativePath} is stale; run pnpm schema`);
    }
  } else {
    writeFileSync(schemaPath, generated);
  }
}

function formatJson(source: string, path: string): string {
  // Format before comparing so schema:check is a byte-for-byte freshness check against committed
  // files and does not disagree with the repository's formatter.
  const result = spawnSync("pnpm", ["exec", "biome", "format", "--stdin-file-path", path], {
    encoding: "utf8",
    input: source,
  });
  if (result.status !== 0) {
    throw new Error(`failed to format ${path}: ${result.stderr}`);
  }
  return result.stdout;
}
