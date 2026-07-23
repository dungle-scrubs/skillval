/** Implements Claude Code-specific skill seeding, config isolation, invocation, and parsing. */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Trace } from "../types.js";
import { isRecord } from "../utils.js";
import type { Executor, ExecutorMetadata, TrialRequest } from "./types.js";

const TRIAL_TIMEOUT_MS = 15 * 60 * 1000;

export class ClaudeExecutor implements Executor {
  public readonly metadata: ExecutorMetadata;
  readonly #realConfigDirectory: string;

  public constructor(realConfigDirectory = defaultConfigDirectory()) {
    this.#realConfigDirectory = realConfigDirectory;
    this.metadata = detectClaude(realConfigDirectory);
  }

  public runTrial(request: TrialRequest): Trace {
    if (request.arm === "skill") seedSkill(request);
    // Trigger cases stay read-only but must allow the Skill tool itself, or invocation is blocked
    // before it can be observed. Generation cases auto-approve edits inside the workspace.
    const permissions =
      request.evalCase.mode === "generation"
        ? ["--permission-mode", "acceptEdits"]
        : ["--permission-mode", "dontAsk", "--allowedTools", "Read,Glob,Grep,Skill"];
    // Baselines keep authentication but must not see user-level skills: an empty config
    // directory hides them (macOS credentials live in the Keychain; elsewhere the credentials
    // file is copied across so authentication survives the redirect).
    const environment =
      request.arm === "baseline"
        ? {
            ...process.env,
            CLAUDE_CONFIG_DIR: prepareBaselineConfig(request.home, this.#realConfigDirectory),
          }
        : { ...process.env };
    const result = spawnSync(
      "claude",
      [
        "-p",
        request.evalCase.prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        "--no-session-persistence",
        ...permissions,
      ],
      {
        cwd: request.workspace,
        encoding: "utf8",
        env: environment,
        maxBuffer: 64 * 1024 * 1024,
        timeout: TRIAL_TIMEOUT_MS,
      },
    );
    if (result.status !== 0) {
      throw new Error(`claude -p exited ${result.status}: ${result.stderr?.slice(-500)}`);
    }

    return parseClaudeTrace(result.stdout, request.skillName);
  }
}

function defaultConfigDirectory(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

function seedSkill(request: TrialRequest): void {
  // Skill installation paths are provider knowledge and intentionally stay inside this adapter.
  const skillsRoot = join(request.workspace, ".claude/skills");
  mkdirSync(skillsRoot, { recursive: true });
  symlinkSync(request.skillDirectory, join(skillsRoot, request.skillName));
}

function prepareBaselineConfig(home: string, realConfigDirectory: string): string {
  const configDirectory = join(home, "claude-config");
  mkdirSync(configDirectory, { recursive: true });
  const credentials = join(realConfigDirectory, ".credentials.json");
  if (existsSync(credentials)) {
    copyFileSync(credentials, join(configDirectory, ".credentials.json"));
  }
  return configDirectory;
}

export function detectClaude(realConfigDirectory = defaultConfigDirectory()): ExecutorMetadata {
  const version = spawnSync("claude", ["--version"], { encoding: "utf8" }).stdout?.trim() ?? "";
  if (version === "") throw new Error("claude CLI not found on PATH");
  let model = "default";
  let thinking = "default";
  try {
    const settings: unknown = JSON.parse(
      readFileSync(join(realConfigDirectory, "settings.json"), "utf8"),
    );
    if (isRecord(settings)) {
      if (typeof settings.model === "string") model = settings.model;
      if (typeof settings.effort === "string") thinking = settings.effort;
    }
  } catch {
    // No readable settings file; the account default model applies.
  }
  return { model, name: "claude", thinking, version };
}

export function parseClaudeTrace(stdout: string, skillName: string): Trace {
  let completed = false;
  let invoked = false;
  let invocationEvidence: string | null = null;
  let resultText = "";
  const texts: string[] = [];
  let usage: unknown;

  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;
    if (
      event.type === "assistant" &&
      isRecord(event.message) &&
      Array.isArray(event.message.content)
    ) {
      for (const block of event.message.content) {
        if (!isRecord(block)) continue;
        if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
        if (
          block.type === "tool_use" &&
          block.name === "Skill" &&
          JSON.stringify(block.input ?? "").includes(skillName)
        ) {
          invoked = true;
          invocationEvidence ??= `Skill tool_use: ${JSON.stringify(block.input ?? null)}`;
        }
      }
    }
    if (event.type === "result") {
      completed = event.is_error === false;
      usage = event.usage;
      if (typeof event.result === "string") resultText = event.result;
    }
  }

  return {
    agentText: texts.length > 0 ? texts.join("\n") : resultText,
    completed,
    invocationEvidence,
    invoked,
    usage,
  };
}
