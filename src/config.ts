/** Resolves configuration and state paths, then loads validated configuration values. */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Check as checkSchema, Errors as schemaErrors } from "typebox/value";
import { parse as parseYaml } from "yaml";
import type { ConfigFile } from "./config-contract.js";
import { configFileSchema } from "./config-contract.js";

export type SkillvalConfig = ConfigFile;

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

  if (!checkSchema(configFileSchema, parsed)) {
    const [firstError] = schemaErrors(configFileSchema, parsed);
    const location = firstError?.instancePath.replaceAll("/", ".").replace(/^\./, "");
    const subject = location === undefined || location === "" ? path : `${path} ${location}`;
    throw new ConfigError(`${subject} ${firstError?.message ?? "is invalid"}`);
  }

  return {
    executor: parsed.executor,
    ...(parsed.loadouts === undefined ? {} : { loadouts: parsed.loadouts }),
    roots: parsed.roots.map((root) => expandRoot(root, home)),
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
