import { describe, expect, it } from "vitest";
import { CODEX_INVOCATION_DETECTION, parseCodexTrace } from "../src/executors/codex.js";

const line = (value: unknown): string => JSON.stringify(value);

const agentMessage = (text: string): string =>
  line({ item: { text, type: "agent_message" }, type: "item.completed" });

const turnCompleted = line({
  type: "turn.completed",
  usage: { input_tokens: 100, output_tokens: 20 },
});

const commandExecution = (command: string, exitCode?: number): string =>
  line({
    item: {
      command,
      ...(exitCode === undefined ? {} : { exit_code: exitCode }),
      type: "command_execution",
    },
    type: "item.completed",
  });

describe("parseCodexTrace", () => {
  it("reports heuristic invocation detection metadata", () => {
    expect(CODEX_INVOCATION_DETECTION).toBe("heuristic");
  });

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

  it("does not attribute a peer skill's SKILL.md read to the target", () => {
    // A group arm seeds peers alongside the target; reading "commit-orient" must not count as
    // invoking target "orient".
    const stdout = [
      commandExecution("cat .agents/skills/commit-orient/SKILL.md"),
      turnCompleted,
    ].join("\n");

    const trace = parseCodexTrace(stdout, "orient");

    expect(trace.invoked).toBe(false);
    expect(trace.invocationEvidence).toBeNull();
  });

  it("does not treat unrelated commands as skill invocations", () => {
    const stdout = [commandExecution("ls -la"), turnCompleted].join("\n");

    const trace = parseCodexTrace(stdout, "orient");

    expect(trace.invoked).toBe(false);
    expect(trace.invocationEvidence).toBeNull();
  });

  it("does not count a started-but-unfinished command as invocation", () => {
    // item.started carries the same command as its later item.completed; only completion proves
    // the read actually happened, and counting both would also double-report evidence.
    // Mirrors the real codex JSONL shape: a started item carries exit_code null, in_progress.
    const stdout = [
      line({
        item: {
          command: "cat .agents/skills/orient/SKILL.md",
          exit_code: null,
          status: "in_progress",
          type: "command_execution",
        },
        type: "item.started",
      }),
      turnCompleted,
    ].join("\n");

    expect(parseCodexTrace(stdout, "orient").invoked).toBe(false);
  });

  it("does not count a failed read as invocation", () => {
    // A command that exited nonzero (missing file, typo) never loaded the skill.
    const stdout = [commandExecution("cat .agents/skills/orient/SKILL.md", 1), turnCompleted].join(
      "\n",
    );

    expect(parseCodexTrace(stdout, "orient").invoked).toBe(false);
  });

  it("counts a completed exit-0 read, and tolerates a missing or null exit_code", () => {
    const withExit = parseCodexTrace(
      [commandExecution("cat .agents/skills/orient/SKILL.md", 0), turnCompleted].join("\n"),
      "orient",
    );
    expect(withExit.invoked).toBe(true);

    // Older codex JSONL without a numeric exit_code on the completed item still counts, unless
    // the item's status says the command failed.
    const withoutExit = parseCodexTrace(
      [commandExecution("cat .agents/skills/orient/SKILL.md"), turnCompleted].join("\n"),
      "orient",
    );
    expect(withoutExit.invoked).toBe(true);

    const nullExit = parseCodexTrace(
      [
        line({
          item: {
            command: "cat .agents/skills/orient/SKILL.md",
            exit_code: null,
            status: "completed",
            type: "command_execution",
          },
          type: "item.completed",
        }),
        turnCompleted,
      ].join("\n"),
      "orient",
    );
    expect(nullExit.invoked).toBe(true);

    const failedStatus = parseCodexTrace(
      [
        line({
          item: {
            command: "cat .agents/skills/orient/SKILL.md",
            exit_code: null,
            status: "failed",
            type: "command_execution",
          },
          type: "item.completed",
        }),
        turnCompleted,
      ].join("\n"),
      "orient",
    );
    expect(failedStatus.invoked).toBe(false);
  });

  it("counts a failed compound command whose read still loaded the skill", () => {
    // The aggregate exit status belongs to the whole command: here the cat succeeded and the
    // skill entered context before rg exited 1 on no-match, so the read must still count.
    const stdout = [
      commandExecution("cat .agents/skills/orient/SKILL.md && rg no-such-pattern src", 1),
      turnCompleted,
    ].join("\n");

    expect(parseCodexTrace(stdout, "orient").invoked).toBe(true);
  });

  it("reports incomplete traces without turn.completed and survives malformed lines", () => {
    const stdout = ["not json", agentMessage("partial")].join("\n");

    const trace = parseCodexTrace(stdout, "orient");

    expect(trace.completed).toBe(false);
    expect(trace.agentText).toBe("partial");
  });
});
