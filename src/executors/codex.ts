/** Implements Codex-specific skill seeding, process isolation, invocation, and trace parsing. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Trace } from "../types.js";
import { isRecord, readsSkillMarkdown } from "../utils.js";
import {
  assertEffortSupported,
  type Executor,
  type ExecutorMetadata,
  type ExecutorOverrides,
  type SeededInstruction,
  type SeededSkill,
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
    seedSkills(request.workspace, request.seededSkills);
    seedInstruction(request.workspace, request.seededInstruction);
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
    // Every arm runs clean: an empty HOME hides HOME-discovered skills (~/.agents/skills), and
    // CODEX_HOME points at a clean copy that mirrors the real config and auth but excludes the
    // user's installed skills under ~/.codex/skills (which are discovered via CODEX_HOME, so a
    // globally installed skill - including the one under test - must not leak into an arm). The
    // only skills the model sees are the ones seeded into the workspace for this arm.
    const environment = {
      ...process.env,
      CODEX_HOME: prepareCleanCodexHome(request.home, this.#realHome),
      HOME: request.home,
    };
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

// A clean CODEX_HOME that mirrors only what authentication and model selection need - config.toml
// and auth.json, by symlink so token refreshes still reach the real file. Everything else is
// omitted on purpose: the skills and plugins directories and the state database that activates
// plugin-contributed skills, so no globally installed skill can leak into a trial through
// CODEX_HOME. config.toml is preserved whole because it also carries provider and auth routing;
// known limitation: if it registers skills explicitly via skills.config entries, those are not
// stripped (uncommon, and only a confound when the skill under test is one of them). Codex creates
// any caches or state it needs inside this throwaway home.
function prepareCleanCodexHome(home: string, realHome: string): string {
  const cleanHome = join(home, "codex-home");
  mkdirSync(cleanHome, { recursive: true });
  const realCodex = join(realHome, ".codex");
  for (const file of ["config.toml", "auth.json"]) {
    const source = join(realCodex, file);
    if (existsSync(source)) symlinkSync(source, join(cleanHome, file));
  }
  return cleanHome;
}

export function seedSkills(workspace: string, skills: readonly SeededSkill[]): void {
  // Skill installation paths are provider knowledge and intentionally stay inside this adapter.
  // An empty list (the baseline arm) seeds nothing, matching the no-skill comparison arm.
  if (skills.length === 0) return;
  const skillsRoot = join(workspace, ".agents/skills");
  mkdirSync(skillsRoot, { recursive: true });
  for (const skill of skills) {
    symlinkSync(skill.directory, join(skillsRoot, skill.name));
  }
}

// Writes the instruction arm's ambient file. The runner supplies the filename from per-executor
// resolution (codex reads AGENTS.md natively), so no filename translation happens here.
export function seedInstruction(workspace: string, instruction?: SeededInstruction): void {
  if (instruction === undefined) return;
  writeFileSync(join(workspace, instruction.filename), instruction.content);
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
      // Whole path segment so a peer skill named "commit-<name>" is not attributed to target
      // "<name>" in a group arm, while relative reads still match.
      readsSkillMarkdown(item.command, skillName)
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
