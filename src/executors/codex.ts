/** Implements Codex-specific skill seeding, process isolation, invocation, and trace parsing. */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Trace } from "../types.js";
import { isRecord } from "../utils.js";
import {
  assertEffortSupported,
  type Executor,
  type ExecutorMetadata,
  type ExecutorOverrides,
  type TrialRequest,
} from "./types.js";

const TRIAL_TIMEOUT_MS = 15 * 60 * 1000;

// codex forwards model_reasoning_effort straight to the Responses API without local validation, so
// these are the API's supported reasoning.effort values. Per-model support is a subset the API
// enforces itself. Verified against codex 0.145.0 (the API reports this exact set).
export const CODEX_EFFORT_LEVELS: readonly string[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
export const CODEX_INVOCATION_DETECTION: ExecutorMetadata["invocationDetection"] = "heuristic";

export class CodexExecutor implements Executor {
  public readonly metadata: ExecutorMetadata;
  readonly #overrides: ExecutorOverrides;
  readonly #realHome: string;

  public constructor(overrides: ExecutorOverrides = {}, realHome = homedir()) {
    assertEffortSupported("codex", overrides.effort, CODEX_EFFORT_LEVELS);
    this.#overrides = overrides;
    this.#realHome = realHome;
    const detected = detectCodex(realHome);
    this.metadata = {
      ...detected,
      model: overrides.model ?? detected.model,
      thinking: overrides.effort ?? detected.thinking,
    };
  }

  public runTrial(request: TrialRequest): Trace {
    if (request.arm === "skill") seedSkill(request);
    const sandbox = request.evalCase.mode === "generation" ? "workspace-write" : "read-only";
    // Config overrides take precedence over config.toml, so the chosen model/effort apply to both
    // arms. The value portion is parsed as TOML, so a JSON-quoted string is a valid TOML string.
    const selection: string[] = [];
    if (this.#overrides.model !== undefined) {
      selection.push("-c", `model=${JSON.stringify(this.#overrides.model)}`);
    }
    if (this.#overrides.effort !== undefined) {
      selection.push("-c", `model_reasoning_effort=${JSON.stringify(this.#overrides.effort)}`);
    }
    // Baselines need the real Codex configuration for authentication and model selection, but an
    // empty HOME prevents globally installed skills from influencing the comparison arm.
    const environment =
      request.arm === "baseline"
        ? {
            ...process.env,
            CODEX_HOME: join(this.#realHome, ".codex"),
            HOME: request.home,
          }
        : { ...process.env };
    const result = spawnSync(
      "codex",
      [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--ephemeral",
        ...selection,
        "-s",
        sandbox,
        "-C",
        request.workspace,
        request.evalCase.prompt,
      ],
      {
        encoding: "utf8",
        env: environment,
        maxBuffer: 64 * 1024 * 1024,
        timeout: TRIAL_TIMEOUT_MS,
      },
    );
    if (result.status !== 0) {
      throw new Error(`codex exec exited ${result.status}: ${result.stderr?.slice(-500)}`);
    }

    return parseCodexTrace(result.stdout, request.skillName);
  }
}

function seedSkill(request: TrialRequest): void {
  // Skill installation paths are provider knowledge and intentionally stay inside this adapter.
  const skillsRoot = join(request.workspace, ".agents/skills");
  mkdirSync(skillsRoot, { recursive: true });
  symlinkSync(request.skillDirectory, join(skillsRoot, request.skillName));
}

export function detectCodex(realHome = homedir()): ExecutorMetadata {
  const version = spawnSync("codex", ["--version"], { encoding: "utf8" }).stdout?.trim() ?? "";
  if (version === "") throw new Error("codex CLI not found on PATH");
  const configuration = readFileSync(join(realHome, ".codex/config.toml"), "utf8");
  const model = configuration.match(/^model\s*=\s*"([^"]+)"/m)?.[1] ?? "default";
  const thinking =
    configuration.match(/^model_reasoning_effort\s*=\s*"([^"]+)"/m)?.[1] ?? "default";
  return {
    invocationDetection: CODEX_INVOCATION_DETECTION,
    model,
    name: "codex",
    thinking,
    version,
  };
}

export function parseCodexTrace(stdout: string, skillName: string): Trace {
  let completed = false;
  let invoked = false;
  let invocationEvidence: string | null = null;
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
    const item = isRecord(event.item) ? event.item : undefined;
    if (
      item?.type === "command_execution" &&
      typeof item.command === "string" &&
      item.command.includes(`${skillName}/SKILL.md`)
    ) {
      invoked = true;
      invocationEvidence ??= `command_execution: ${item.command}`;
    }
    if (
      event.type === "item.completed" &&
      item?.type === "agent_message" &&
      typeof item.text === "string"
    ) {
      texts.push(item.text);
    }
    if (event.type === "turn.completed") {
      completed = true;
      usage = event.usage;
    }
  }

  return { agentText: texts.join("\n"), completed, invocationEvidence, invoked, usage };
}
