/** Implements pi-specific skill loading, arm isolation, invocation, and trace parsing. */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Trace } from "../types.js";
import { isRecord } from "../utils.js";
import type { Executor, ExecutorMetadata, TrialRequest } from "./types.js";

const TRIAL_TIMEOUT_MS = 15 * 60 * 1000;

export class PiExecutor implements Executor {
  public readonly metadata: ExecutorMetadata;

  public constructor(settingsDirectory = join(homedir(), ".pi")) {
    this.metadata = detectPi(settingsDirectory);
  }

  public runTrial(request: TrialRequest): Trace {
    // pi has first-class arm switches: --skill makes the evaluated skill discoverable alongside
    // the user's normal library (mirroring the other adapters), --no-skills hides every skill
    // from the baseline. No HOME or config redirection is needed.
    const arm = request.arm === "skill" ? ["--skill", request.skillDirectory] : ["--no-skills"];
    // Trigger cases are read-only via the tool allowlist; read also loads SKILL.md, so skill
    // invocation stays observable. Generation cases keep pi's default tool set - note pi has no
    // OS sandbox, so setup writes are only conventionally scoped to the workspace.
    const tools = request.evalCase.mode === "generation" ? [] : ["-t", "read"];
    const result = spawnSync(
      "pi",
      ["-p", "--mode", "json", "--no-session", ...arm, ...tools, request.evalCase.prompt],
      {
        cwd: request.workspace,
        encoding: "utf8",
        env: { ...process.env },
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
  return { model, name: "pi", thinking, version };
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
          JSON.stringify(block.arguments ?? "").includes(`${skillName}/SKILL.md`)
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
