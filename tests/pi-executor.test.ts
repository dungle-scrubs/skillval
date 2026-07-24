import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PI_INVOCATION_DETECTION, parsePiTrace, prepareCleanPiHome } from "../src/executors/pi.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

const makeDir = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "skillval-pi-test-"));
  temporaryDirectories.push(directory);
  return directory;
};

describe("prepareCleanPiHome", () => {
  it("mirrors auth and model files but never the global instruction files", () => {
    const realAgentDirectory = makeDir();
    const home = makeDir();
    for (const file of ["auth.json", "settings.json", "models.json", "auth-profiles.json"]) {
      writeFileSync(join(realAgentDirectory, file), "{}");
    }
    // A user-global AGENTS.md/CLAUDE.md would otherwise enter every arm and could make the peers
    // arm pass, misreporting the target rule as redundant.
    writeFileSync(join(realAgentDirectory, "AGENTS.md"), "- global rule\n");
    writeFileSync(join(realAgentDirectory, "CLAUDE.md"), "- global rule\n");
    mkdirSync(join(realAgentDirectory, "extensions"));

    const clean = prepareCleanPiHome(home, realAgentDirectory);

    expect(existsSync(join(clean, "auth.json"))).toBe(true);
    expect(existsSync(join(clean, "settings.json"))).toBe(true);
    expect(existsSync(join(clean, "models.json"))).toBe(true);
    expect(existsSync(join(clean, "auth-profiles.json"))).toBe(true);
    expect(existsSync(join(clean, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(clean, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(clean, "extensions"))).toBe(false);
  });

  it("is idempotent across the arms of one trial home", () => {
    const realAgentDirectory = makeDir();
    const home = makeDir();
    writeFileSync(join(realAgentDirectory, "auth.json"), "{}");

    expect(prepareCleanPiHome(home, realAgentDirectory)).toBe(
      prepareCleanPiHome(home, realAgentDirectory),
    );
  });
});

const line = (value: unknown): string => JSON.stringify(value);

const agentEnd = (messages: unknown[]): string =>
  line({ messages, type: "agent_end", willRetry: false });

const usage = { input: 100, output: 20, totalTokens: 120 };

describe("parsePiTrace", () => {
  it("reports heuristic invocation detection metadata", () => {
    expect(PI_INVOCATION_DETECTION).toBe("heuristic");
  });

  it("collects assistant text and usage from the agent_end transcript", () => {
    const stdout = [
      line({ type: "session", version: 3 }),
      line({ type: "message_update", message: { role: "assistant" } }),
      agentEnd([
        { content: [{ text: "prompt", type: "text" }], role: "user" },
        { content: [{ text: "looking around", type: "text" }], role: "assistant", usage },
        { content: [{ text: "the answer", type: "text" }], role: "assistant", usage },
      ]),
    ].join("\n");

    const trace = parsePiTrace(stdout, "orient");

    expect(trace.agentText).toBe("looking around\nthe answer");
    expect(trace.completed).toBe(true);
    expect(trace.invoked).toBe(false);
    expect(trace.usage).toEqual(usage);
  });

  it("detects skill invocation from a read toolCall targeting SKILL.md", () => {
    const stdout = agentEnd([
      {
        content: [
          {
            arguments: { path: "/home/user/skills/orient/SKILL.md" },
            id: "call_1",
            name: "read",
            type: "toolCall",
          },
        ],
        role: "assistant",
      },
    ]);

    expect(parsePiTrace(stdout, "orient").invoked).toBe(true);
    expect(parsePiTrace(stdout, "planner").invoked).toBe(false);
  });

  it("conformance: records invocation evidence, or null when not triggered", () => {
    const stdout = agentEnd([
      {
        content: [
          {
            arguments: { path: "/home/user/skills/orient/SKILL.md" },
            id: "call_1",
            name: "read",
            type: "toolCall",
          },
        ],
        role: "assistant",
      },
    ]);

    const triggered = parsePiTrace(stdout, "orient");
    expect(triggered.invoked).toBe(true);
    expect(triggered.invocationEvidence).toContain("read toolCall");
    expect(triggered.invocationEvidence).toContain("SKILL.md");

    const notTriggered = parsePiTrace(stdout, "planner");
    expect(notTriggered.invoked).toBe(false);
    expect(notTriggered.invocationEvidence).toBeNull();
  });

  it("does not attribute a peer skill's SKILL.md read to the target", () => {
    const stdout = agentEnd([
      {
        content: [
          {
            arguments: { path: "/home/user/skills/commit-orient/SKILL.md" },
            id: "call_1",
            name: "read",
            type: "toolCall",
          },
        ],
        role: "assistant",
      },
    ]);

    expect(parsePiTrace(stdout, "orient").invoked).toBe(false);
  });

  it("ignores tool results and user messages when collecting text", () => {
    const stdout = agentEnd([
      { content: [{ text: "file contents here", type: "text" }], role: "user" },
      { content: [{ text: "summary", type: "text" }], role: "assistant" },
    ]);

    expect(parsePiTrace(stdout, "orient").agentText).toBe("summary");
  });

  it("reports incomplete traces without agent_end and survives malformed lines", () => {
    const stdout = ["No API key found for zai.", line({ type: "message_end" })].join("\n");

    const trace = parsePiTrace(stdout, "orient");

    expect(trace.completed).toBe(false);
    expect(trace.agentText).toBe("");
  });
});
