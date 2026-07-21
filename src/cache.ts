import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveStateDirectory } from "./config.js";
import type { ArmResult, EvalCase } from "./types.js";
import { sha256 } from "./utils.js";

export const RUNNER_VERSION = 5;

export function armCacheKey(
  skillHash: string,
  evalCase: EvalCase,
  arm: string,
  codexVersion: string,
  codexModel: string,
): string {
  return sha256(
    [
      String(RUNNER_VERSION),
      skillHash,
      JSON.stringify(evalCase),
      arm,
      codexVersion,
      codexModel,
    ].join("\0"),
  );
}

export function cachedArm(
  key: string,
  stateDirectory = resolveStateDirectory(),
): ArmResult | undefined {
  const path = join(stateDirectory, "cache", `${key}.json`);
  if (!existsSync(path)) return undefined;
  return { ...(JSON.parse(readFileSync(path, "utf8")) as ArmResult), cached: true };
}

export function storeArm(
  key: string,
  result: ArmResult,
  stateDirectory = resolveStateDirectory(),
): void {
  const path = join(stateDirectory, "cache", `${key}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(result));
}
