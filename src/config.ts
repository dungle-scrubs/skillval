import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { isRecord } from "./utils.js";

export interface SkillvalConfig {
  readonly executor: "codex";
  readonly roots: readonly string[];
}

export interface ConfigPathOptions {
  readonly cliPath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly home?: string;
}

export class ConfigError extends Error {
  public readonly code: string;

  public constructor(message: string, code = "CONFIG_ERROR") {
    super(message);
    this.code = code;
    this.name = "ConfigError";
  }
}

export function resolveConfigPath(options: ConfigPathOptions = {}): string {
  const environment = options.environment ?? process.env;
  const home = options.home ?? homedir();
  const selected =
    options.cliPath ??
    environment.SKILLVAL_CONFIG ??
    (environment.XDG_CONFIG_HOME
      ? resolve(environment.XDG_CONFIG_HOME, "skillval/config.yml")
      : resolve(home, ".config/skillval/config.yml"));
  return resolve(expandHome(selected, home));
}

export function expandRoot(root: string, home = homedir()): string {
  return resolve(expandHome(root, home));
}

export function loadConfig(path: string, home = homedir()): SkillvalConfig {
  if (!existsSync(path)) {
    throw new ConfigError(`config file not found: ${path}`, "CONFIG_NOT_FOUND");
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`invalid YAML in ${path}: ${detail}`, "CONFIG_YAML_INVALID");
  }

  if (!isRecord(parsed)) {
    throw new ConfigError(`${path} must contain a YAML mapping`);
  }
  if (!Array.isArray(parsed.roots) || parsed.roots.some((root) => typeof root !== "string")) {
    throw new ConfigError(`${path} roots must be an array of paths`);
  }
  if (parsed.executor !== "codex") {
    throw new ConfigError(`${path} executor must be "codex"`);
  }

  return {
    executor: parsed.executor,
    roots: parsed.roots.map((root) => expandRoot(String(root), home)),
  };
}

export function resolveStateDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  return environment.XDG_STATE_HOME
    ? resolve(environment.XDG_STATE_HOME, "skillval")
    : resolve(home, ".local/state/skillval");
}

function expandHome(value: string, home: string): string {
  const withTilde =
    value === "~" ? home : value.startsWith("~/") ? `${home}${value.slice(1)}` : value;
  return withTilde.replaceAll(String.raw`\${HOME}`, home).replaceAll("$HOME", home);
}
