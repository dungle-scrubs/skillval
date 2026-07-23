import { describe, expect, it } from "vitest";
import { parseCodexTrace } from "../src/executors/codex.js";

const line = (value: unknown): string => JSON.stringify(value);

const agentMessage = (text: string): string =>
  line({ item: { text, type: "agent_message" }, type: "item.completed" });

const turnCompleted = line({
  type: "turn.completed",
  usage: { input_tokens: 100, output_tokens: 20 },
});

const commandExecution = (command: string): string =>
  line({ item: { command, type: "command_execution" }, type: "item.completed" });

describe("parseCodexTrace", () => {
  it("collects agent text, completion, and usage", () => {
    const stdout = [
      line({ type: "thread.started" }),
      agentMessage("working on it"),
      agentMessage("final answer"),
      turnCompleted,
    ].join("\n");

    const trace = parseCodexTrace(stdout, "orient");

    expect(trace.agentText).toBe("working on it\nfinal answer");
    expect(trace.completed).toBe(true);
    expect(trace.invoked).toBe(false);
    expect(trace.usage).toEqual({ input_tokens: 100, output_tokens: 20 });
  });

  it("conformance: records invocation evidence, or null when not triggered", () => {
    const stdout = [
      commandExecution("cat .agents/skills/orient/SKILL.md"),
      agentMessage("done"),
      turnCompleted,
    ].join("\n");

    const triggered = parseCodexTrace(stdout, "orient");
    expect(triggered.invoked).toBe(true);
    expect(triggered.invocationEvidence).toContain("command_execution");
    expect(triggered.invocationEvidence).toContain("orient/SKILL.md");

    const notTriggered = parseCodexTrace(stdout, "planner");
    expect(notTriggered.invoked).toBe(false);
    expect(notTriggered.invocationEvidence).toBeNull();
  });

  it("does not treat unrelated commands as skill invocations", () => {
    const stdout = [commandExecution("ls -la"), turnCompleted].join("\n");

    const trace = parseCodexTrace(stdout, "orient");

    expect(trace.invoked).toBe(false);
    expect(trace.invocationEvidence).toBeNull();
  });

  it("reports incomplete traces without turn.completed and survives malformed lines", () => {
    const stdout = ["not json", agentMessage("partial")].join("\n");

    const trace = parseCodexTrace(stdout, "orient");

    expect(trace.completed).toBe(false);
    expect(trace.agentText).toBe("partial");
  });
});
