/** Implements Codex-specific skill seeding, process isolation, invocation, and trace parsing. */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Trace } from "../types.js";
import { isRecord } from "../utils.js";
import type { Executor, ExecutorMetadata, TrialRequest } from "./types.js";

const TRIAL_TIMEOUT_MS = 15 * 60 * 1000;

export class CodexExecutor implements Executor {
  public readonly metadata: ExecutorMetadata;
  readonly #realHome: string;

  public constructor(realHome = homedir()) {
    this.#realHome = realHome;
    this.metadata = detectCodex(realHome);
  }

  public runTrial(request: TrialRequest): Trace {
    if (request.arm === "skill") seedSkill(request);
    const sandbox = request.evalCase.mode === "generation" ? "workspace-write" : "read-only";
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
  return { model, name: "codex", thinking, version };
}

export function parseCodexTrace(stdout: string, skillName: string): Trace {
  let completed = false;
  let invoked = false;
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

  return { agentText: texts.join("\n"), completed, invoked, usage };
}
