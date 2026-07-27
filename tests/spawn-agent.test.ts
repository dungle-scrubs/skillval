import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { describe, expect, it } from "vitest";
import {
  ExecutorInfraError,
  spawnAgent,
  throwIfProviderUnavailable,
  throwNeverGraded,
} from "../src/executors/spawn.js";

// Drive a real child (node) rather than a real agent CLI: the classification logic under test is
// process-outcome handling, and a trivial node one-liner exercises every branch deterministically.
const node = (script: string): { args: readonly string[]; command: string } => ({
  args: ["-e", script],
  command: execPath,
});

describe("spawnAgent", () => {
  it("captures stdout and status for a normal run", () => {
    const result = spawnAgent({ ...node("process.stdout.write('hello')"), env: process.env });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("hello");
    expect(result.signal).toBeNull();
  });

  it("raises an output-too-large infra error when the cap is exceeded", () => {
    let thrown: unknown;
    try {
      spawnAgent({
        ...node("process.stdout.write('x'.repeat(50000))"),
        env: process.env,
        maxOutputBytes: 1000,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ExecutorInfraError);
    expect((thrown as ExecutorInfraError).kind).toBe("output-too-large");
  });

  it("does not misclassify a large-output nonzero exit as overflow (ENOBUFS is the only signal)", () => {
    // Just under the cap, then exit nonzero: Node returns a normal {status, error: undefined} with
    // no ENOBUFS, so this is a genuine error exit and must pass through, not be called overflow.
    const result = spawnAgent({
      ...node("process.stdout.write('x'.repeat(9500)); process.exit(1)"),
      env: process.env,
      maxOutputBytes: 10000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout.length).toBe(9500);
  });

  it("does not misclassify a genuine small-output nonzero exit as overflow", () => {
    const result = spawnAgent({
      ...node("process.stderr.write('boom'); process.exit(2)"),
      env: process.env,
      maxOutputBytes: 1000,
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toBe("boom");
  });

  it("raises a timeout infra error when the run exceeds its budget", () => {
    let thrown: unknown;
    try {
      spawnAgent({
        ...node("setTimeout(() => {}, 5000)"),
        env: process.env,
        timeoutMs: 200,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ExecutorInfraError);
    expect((thrown as ExecutorInfraError).kind).toBe("timeout");
  });
});

describe("throwIfProviderUnavailable", () => {
  it("classifies quota, rate-limit, and auth refusals as infrastructure", () => {
    for (const output of [
      "You've hit your usage limit. Visit settings to purchase more credits",
      "429 Too Many Requests",
      "error: invalid api key provided",
      "rate limited, retry later",
    ]) {
      expect(() => throwIfProviderUnavailable("codex", output)).toThrow(ExecutorInfraError);
    }
  });

  it("lets ordinary agent failures pass through to the executor's own error", () => {
    expect(() =>
      throwIfProviderUnavailable("codex", "error: model refused to complete the task"),
    ).not.toThrow();
    expect(() => throwIfProviderUnavailable("pi", "TypeError: x is not a function")).not.toThrow();
  });
});

describe("throwNeverGraded", () => {
  it("names the exit status, the signal, and an empty stderr", () => {
    // The exact live shape that motivated this path: opus exiting 1 with nothing on stderr. The
    // message has to say something, or the ledger shows a blank reason for a discarded trial.
    expect(() => throwNeverGraded("claude -p", 1, null, "")).toThrow(
      /claude -p exited 1 without completing a turn: \(no output\)/,
    );
    expect(() => throwNeverGraded("pi -p", null, "SIGKILL", "oom")).toThrow(
      /pi -p died on SIGKILL without completing a turn: oom/,
    );
  });

  it("is typed as infrastructure so the runner excludes it from the vote and never caches it", () => {
    let thrown: unknown;
    try {
      throwNeverGraded("claude -p", 1, null, "");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ExecutorInfraError);
    expect((thrown as ExecutorInfraError).kind).toBe("process-failed");
  });
});

describe("spawnAgent process-group containment", () => {
  it("kills a writer the agent backgrounded before returning", async () => {
    // The model does not need the CLI to daemonize: one bash call running
    // `(sleep N; write) &` outlives the turn and mutates the workspace WHILE the tree is being
    // snapshotted and graded. spawnSync returns as soon as the CLI exits, so without the group
    // wrapper nothing stands between that writer and the graded tree.
    const directory = mkdtempSync(join(tmpdir(), "skillval-group-test-"));
    const marker = join(directory, "written-after-the-turn.txt");

    const result = spawnAgent({
      args: ["-c", `(sleep 2; touch ${marker}) & echo done`],
      command: "sh",
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(result.stdout).toContain("done");
    expect(result.status).toBe(0);

    // Well past the writer's delay: if the group survived, the file is there.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(existsSync(marker)).toBe(false);
    rmSync(directory, { force: true, recursive: true });
  }, 15_000);

  it("classifies a CLI that cannot be started as infrastructure, with a reason", () => {
    // spawnSync used to surface ENOENT itself. It now spawns node - which always exists - so the
    // real failure happens one level down, and the wrapper swallowing it turned a missing CLI into
    // a silent exit 1 with empty stderr: an unexplained failure that reaches the executors looking
    // like the agent ran and failed.
    let thrown: unknown;
    try {
      spawnAgent({
        args: [],
        command: "skillval-definitely-not-a-real-binary-xyz",
        env: { PATH: process.env.PATH ?? "" },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ExecutorInfraError);
    expect((thrown as ExecutorInfraError).kind).toBe("process-failed");
    // Names the command that could not start, not the wrapper that reported it.
    expect((thrown as Error).message).toContain("skillval-definitely-not-a-real-binary-xyz");
  });

  it("kills the group when the agent is killed for exceeding its timeout", async () => {
    // The timeout path reaps through a different mechanism than a normal exit: spawnSync signals
    // the WRAPPER, which has to trap it and take the group down on its way out. A timed-out trial
    // is already infrastructure, but its leftover writer would still be running while the NEXT
    // trial's tree is graded.
    const directory = mkdtempSync(join(tmpdir(), "skillval-group-timeout-"));
    const marker = join(directory, "written-after-the-kill.txt");

    let thrown: unknown;
    try {
      spawnAgent({
        args: ["-c", `(sleep 3; touch ${marker}) & sleep 30`],
        command: "sh",
        env: { PATH: process.env.PATH ?? "" },
        timeoutMs: 1000,
      });
    } catch (error) {
      thrown = error;
    }
    // Still classified as infrastructure, not as the skill failing.
    expect(thrown).toBeInstanceOf(ExecutorInfraError);
    expect((thrown as ExecutorInfraError).kind).toBe("timeout");

    await new Promise((resolve) => setTimeout(resolve, 4000));
    expect(existsSync(marker)).toBe(false);
    rmSync(directory, { force: true, recursive: true });
  }, 20_000);
});
