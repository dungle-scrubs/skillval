import { describe, expect, it } from "vitest";
import { CLAUDE_INVOCATION_DETECTION, parseClaudeTrace } from "../src/executors/claude.js";

const line = (value: unknown): string => JSON.stringify(value);

const resultEvent = line({
  is_error: false,
  result: "final answer",
  type: "result",
  usage: { input_tokens: 10, output_tokens: 5 },
});

describe("parseClaudeTrace", () => {
  it("reports structured invocation detection metadata", () => {
    expect(CLAUDE_INVOCATION_DETECTION).toBe("structured");
  });

  it("collects assistant text, completion, and usage", () => {
    const stdout = [
      line({ subtype: "init", type: "system" }),
      line({
        message: { content: [{ text: "working on it", type: "text" }] },
        type: "assistant",
      }),
      line({
        message: { content: [{ text: "final answer", type: "text" }] },
        type: "assistant",
      }),
      resultEvent,
    ].join("\n");

    const trace = parseClaudeTrace(stdout, "orient");

    expect(trace.agentText).toBe("working on it\nfinal answer");
    expect(trace.completed).toBe(true);
    expect(trace.invoked).toBe(false);
    expect(trace.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  it("detects Skill tool invocations naming the evaluated skill", () => {
    const stdout = [
      line({
        message: {
          content: [{ id: "t1", input: { command: "orient" }, name: "Skill", type: "tool_use" }],
        },
        type: "assistant",
      }),
      resultEvent,
    ].join("\n");

    expect(parseClaudeTrace(stdout, "orient").invoked).toBe(true);
    expect(parseClaudeTrace(stdout, "planner").invoked).toBe(false);
  });

  it("conformance: records invocation evidence, or null when not triggered", () => {
    const stdout = [
      line({
        message: {
          content: [{ id: "t1", input: { command: "orient" }, name: "Skill", type: "tool_use" }],
        },
        type: "assistant",
      }),
      resultEvent,
    ].join("\n");

    const triggered = parseClaudeTrace(stdout, "orient");
    expect(triggered.invoked).toBe(true);
    expect(triggered.invocationEvidence).toContain("Skill tool_use");
    expect(triggered.invocationEvidence).toContain("orient");

    const notTriggered = parseClaudeTrace(stdout, "planner");
    expect(notTriggered.invoked).toBe(false);
    expect(notTriggered.invocationEvidence).toBeNull();
  });

  it("does not treat other tool uses as skill invocations", () => {
    const stdout = [
      line({
        message: {
          content: [
            { id: "t1", input: { file_path: "/w/orient.md" }, name: "Read", type: "tool_use" },
          ],
        },
        type: "assistant",
      }),
      resultEvent,
    ].join("\n");

    expect(parseClaudeTrace(stdout, "orient").invoked).toBe(false);
  });

  it("falls back to the result text when no assistant text blocks streamed", () => {
    const trace = parseClaudeTrace(resultEvent, "orient");

    expect(trace.agentText).toBe("final answer");
  });

  it("reports incomplete traces and survives malformed lines", () => {
    const stdout = ["not json", line({ type: "assistant", message: { content: "oops" } })].join(
      "\n",
    );

    const trace = parseClaudeTrace(stdout, "orient");

    expect(trace.completed).toBe(false);
    expect(trace.agentText).toBe("");
  });

  it("treats an errored result as incomplete", () => {
    const stdout = line({ is_error: true, result: null, type: "result" });

    expect(parseClaudeTrace(stdout, "orient").completed).toBe(false);
  });
});
