/** Implements pi-specific skill loading, arm isolation, invocation, and trace parsing. */
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

// pi normalizes thinking across every model via pi-ai, from `pi --thinking`.
export const PI_EFFORT_LEVELS: readonly string[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];
export const PI_INVOCATION_DETECTION: ExecutorMetadata["invocationDetection"] = "heuristic";

// Every arm runs clean: --no-skills hides the user's global skill library, and a repeatable --skill
// seeds exactly this arm's set on top. pi loads explicit --skill paths even under --no-skills
// (verified against pi's resource loader), so the empty baseline sees no skills and the solo arm
// sees only the target.
export function piSkillArgs(seededSkills: readonly SeededSkill[]): string[] {
  const args = ["--no-skills"];
  for (const skill of seededSkills) args.push("--skill", skill.directory);
  return args;
}

// Files that carry authentication and model selection, safe to mirror into a clean agent directory.
// Everything else is omitted on purpose - in particular the global AGENTS.md/CLAUDE.md that pi would
// otherwise load into every arm, and the extensions and prompts directories, which are behavioral.
const PI_CLEAN_FILES: readonly string[] = [
  "auth.json",
  "auth-profiles.json",
  "models.json",
  "settings.json",
];

// A clean PI_CODING_AGENT_DIR holding only auth and model configuration, by symlink so token
// refreshes still reach the real files. Any global instruction file in the real directory is left
// behind, which is the point.
export function prepareCleanPiHome(
  home: string,
  realAgentDirectory = defaultPiAgentDirectory(),
): string {
  const cleanDirectory = join(home, "pi-agent");
  mkdirSync(cleanDirectory, { recursive: true });
  for (const file of PI_CLEAN_FILES) {
    const source = join(realAgentDirectory, file);
    const destination = join(cleanDirectory, file);
    if (existsSync(source) && !existsSync(destination)) symlinkSync(source, destination);
  }
  return cleanDirectory;
}

function defaultPiAgentDirectory(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi");
}

// Writes the instruction arm's ambient file. The runner supplies the filename from per-executor
// resolution (pi reads both names, AGENTS.md first), so no filename translation happens here.
export function seedInstruction(workspace: string, instruction?: SeededInstruction): void {
  if (instruction === undefined) return;
  writeFileSync(join(workspace, instruction.filename), instruction.content);
}

export class PiExecutor implements Executor {
  public readonly metadata: ExecutorMetadata;
  readonly #overrides: ExecutorOverrides;

  public constructor(
    overrides: ExecutorOverrides = {},
    settingsDirectory = join(homedir(), ".pi"),
  ) {
    assertEffortSupported("pi", overrides.effort, PI_EFFORT_LEVELS);
    this.#overrides = overrides;
    const detected = detectPi(settingsDirectory);
    this.metadata = {
      ...detected,
      model: overrides.model ?? detected.model,
      thinking: overrides.effort ?? detected.thinking,
    };
  }

  public runTrial(request: TrialRequest): Trace {
    seedInstruction(request.workspace, request.seededInstruction);
    // Clean skill loading (see piSkillArgs): --no-skills hides the user's library, --skill seeds
    // this arm's set. Instruction-file isolation is handled separately, below.
    const arm = piSkillArgs(request.seededSkills);
    // pi expresses effort as a thinking level; the requested model and thinking pass through here.
    const selection: string[] = [];
    if (this.#overrides.model !== undefined) selection.push("--model", this.#overrides.model);
    if (this.#overrides.effort !== undefined) selection.push("--thinking", this.#overrides.effort);
    // Trigger cases are read-only via the tool allowlist; read also loads SKILL.md, so skill
    // invocation stays observable. Generation cases keep pi's default tool set - note pi has no
    // OS sandbox, so setup writes are only conventionally scoped to the workspace.
    const tools = request.evalCase.mode === "generation" ? [] : ["-t", "read"];
    // Every arm runs clean: pi discovers AGENTS.md/CLAUDE.md from its agent directory as well as the
    // workspace, and a user-global instruction file there would enter every arm identically - a
    // global rule duplicating the target rule would make the peers arm pass and misreport the target
    // as redundant. Redirect the agent directory (and HOME) at a clean per-trial copy carrying only
    // auth and model selection, so the workspace instruction file is the only ambient one.
    const environment = {
      ...process.env,
      HOME: request.home,
      PI_CODING_AGENT_DIR: prepareCleanPiHome(request.home),
    };
    const result = spawnSync(
      "pi",
      [
        "-p",
        "--mode",
        "json",
        "--no-session",
        ...selection,
        ...arm,
        ...tools,
        request.evalCase.prompt,
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
      throw new Error(`pi -p exited ${result.status}: ${result.stderr?.slice(-500)}`);
    }

    const trace = parsePiTrace(result.stdout, request.skillName);
    if (!trace.completed && /no api key/i.test(result.stdout)) {
      throw new Error(
        "pi found no API key for its configured provider; export the provider key " +
          "(e.g. ZAI_API_KEY) in the environment running skillval",
      );
    }
    return trace;
  }
}

export function detectPi(settingsDirectory = join(homedir(), ".pi")): ExecutorMetadata {
  const version = spawnSync("pi", ["--version"], { encoding: "utf8" }).stdout?.trim() ?? "";
  if (version === "") throw new Error("pi CLI not found on PATH");
  let model = "default";
  let thinking = "default";
  try {
    const settings: unknown = JSON.parse(
      readFileSync(join(settingsDirectory, "settings.json"), "utf8"),
    );
    if (isRecord(settings)) {
      if (typeof settings.defaultModel === "string") {
        model =
          typeof settings.defaultProvider === "string"
            ? `${settings.defaultProvider}/${settings.defaultModel}`
            : settings.defaultModel;
      }
      if (typeof settings.defaultThinkingLevel === "string") {
        thinking = settings.defaultThinkingLevel;
      }
    }
  } catch {
    // No readable settings file; pi's own default model applies.
  }
  return {
    invocationDetection: PI_INVOCATION_DETECTION,
    model,
    name: "pi",
    thinking,
    version,
  };
}

export function parsePiTrace(stdout: string, skillName: string): Trace {
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
    // agent_end carries the complete transcript, so it is the single authoritative source.
    if (event.type !== "agent_end" || !Array.isArray(event.messages)) continue;
    completed = true;
    for (const message of event.messages) {
      if (!isRecord(message) || message.role !== "assistant") continue;
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (!isRecord(block)) continue;
        if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
        if (
          block.type === "toolCall" &&
          // Whole path segment so a peer skill named "commit-<name>" is not attributed to target
          // "<name>" in a group arm, while relative reads still match.
          readsSkillMarkdown(JSON.stringify(block.arguments ?? ""), skillName)
        ) {
          invoked = true;
          const name = typeof block.name === "string" ? block.name : "toolCall";
          invocationEvidence ??= `${name} toolCall: ${JSON.stringify(block.arguments ?? null)}`;
        }
      }
      usage = message.usage ?? usage;
    }
  }

  return { agentText: texts.join("\n"), completed, invocationEvidence, invoked, usage };
}
