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
    //
    // The redirect to /dev/null is what makes this a real test. The first version let the
    // background process keep the inherited stdout and stderr, so an UNWRAPPED spawnSync sat
    // waiting for those descriptors to close and the writer finished before the call even
    // returned. It failed without the wrapper, but not for the reason it claimed - it never
    // reproduced a mutation arriving after the turn was over.
    const directory = mkdtempSync(join(tmpdir(), "skillval-wtest-"));
    const marker = join(directory, "written-after-the-turn.txt");

    const started = Date.now();
    const result = spawnAgent({
      args: ["-c", `(sleep 2; touch ${marker}) >/dev/null 2>&1 </dev/null & echo done`],
      command: "sh",
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(result.stdout).toContain("done");
    expect(result.status).toBe(0);
    // Returned while the writer was still sleeping - so the mutation this guards against really is
    // a post-turn one, and the assertion below is not just observing a finished write.
    expect(Date.now() - started).toBeLessThan(1500);

    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(existsSync(marker)).toBe(false);
    rmSync(directory, { force: true, recursive: true });
  }, 15_000);

  it("kills the group even when the wrapper itself is killed uncatchably", async () => {
    // SIGKILL cannot be trapped, so the wrapper's own handlers never run. The parent used to skip
    // its backstop here because it keyed on `result.error`, which is UNDEFINED for a signalled
    // child - spawnSync reports `signal` instead. The group survived, and nothing noticed.
    const directory = mkdtempSync(join(tmpdir(), "skillval-wtest-kill-"));
    const marker = join(directory, "written-after-the-wrapper-died.txt");

    const result = spawnAgent({
      args: [
        "-c",
        // Killed after a beat, not instantly. Instantly is not containable and never will be: on
        // Linux the agent kills the wrapper before spawn() has even returned the pid to JS, so the
        // group could not have been recorded by anything (verified in a container - the control
        // channel held only a marker written BEFORE the spawn call). macOS loses that race, which
        // is why this passed locally and failed CI. Delaying the kill puts it after the pid is
        // recorded, making the backstop the thing under test rather than the reporting window.
        `(sleep 4; touch ${marker}) >/dev/null 2>&1 </dev/null & echo done; sleep 0.5; kill -9 $PPID`,
      ],
      command: "sh",
      env: { PATH: process.env.PATH ?? "" },
    });
    // The wrapper died without cleaning up, so the pid token survived and the parent acted on it.
    expect(result.signal === "SIGKILL" || result.status !== 0).toBe(true);

    // Must outlast the writer's own delay. Waiting less than it made the assertion fire before the
    // write could have happened, so the test passed with no containment at all.
    await new Promise((resolve) => setTimeout(resolve, 6000));
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
    expect((thrown as Error).message).toContain("skillval-definitely-not-a-real-binary-xyz");
  });

  it("does not treat the agent's own output as a wrapper control message", () => {
    // Control data used to travel as a marker string on stderr, which any command could print.
    // A trial that happened to emit it was reclassified as infrastructure and dropped from the
    // vote - a gradeable result silently discarded.
    const result = spawnAgent({
      args: ["-c", ">&2 echo 'skillval-wrapper: failed to spawn something'; echo real-answer"],
      command: "sh",
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(result.stdout).toContain("real-answer");
    expect(result.status).toBe(0);
  });

  it("closes stdin so an agent that reads it does not hang, and keeps the streams apart", () => {
    // pi -p blocks on an open non-TTY stdin until the 15-minute timeout kills it. This property
    // was verified by hand when the wrapper was written and never pinned, so a stdio regression
    // would have turned every pi trial into a quarter-hour hang with the suite still green.
    const result = spawnAgent({
      args: [
        "-c",
        "if [ -c /dev/stdin ]; then echo fd0=character-device; else echo fd0=other; fi; cat; echo to-stdout; >&2 echo to-stderr",
      ],
      closeStdin: true,
      command: "sh",
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 5000,
    });
    expect(result.status).toBe(0);
    // The KIND of fd 0, not just that EOF arrived. spawnSync supplies EOF on its own pipe whether
    // or not this flag is set, so asserting "cat terminated" passed with the feature removed - the
    // review confirmed the mutant survived. /dev/null is a character device; an inherited pipe or
    // socket is not, so this distinguishes them.
    expect(result.stdout).toContain("fd0=character-device");
    expect(result.stdout).toContain("to-stdout");
    // Separate channels: a JSONL trace is parsed from stdout, so stderr leaking into it corrupts
    // every trace rather than failing loudly.
    expect(result.stdout).not.toContain("to-stderr");
    expect(result.stderr).toContain("to-stderr");
  });

  it.each(["SIGKILL", "SIGPIPE", "SIGUSR1"])(
    "reports %s as the signal the agent died from rather than a flat exit 1",
    (name) => {
      // SIGKILL alone terminated the wrapper during its own re-raise, so the fd-3 fallback beneath
      // it was never exercised: Node IGNORES SIGPIPE and OWNS SIGUSR1 for the inspector, so killing
      // itself with those is a no-op and control falls through to the report. Removing that report
      // left this test green while both became a flat status with no signal.
      const result = spawnAgent({
        args: ["-c", `kill -s ${name.replace("SIG", "")} $$`],
        command: "sh",
        env: { PATH: process.env.PATH ?? "" },
      });
      expect(result.signal).toBe(name);
    },
  );

  it("reports the signal the agent died from rather than a flat exit 1", () => {
    // The wrapper exits on the child's behalf, so a signalled agent was reported as "exited 1".
    // throwNeverGraded and the pi diagnostics both print that, and a killed agent reading as an
    // ordinary nonzero exit hides an OOM.
    const result = spawnAgent({
      args: ["-c", "kill -9 $$"],
      command: "sh",
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(result.signal).toBe("SIGKILL");
  });

  it("kills the group when the agent is killed for exceeding its timeout", async () => {
    // The timeout path reaps through a different mechanism than a normal exit: spawnSync signals
    // the WRAPPER, which has to trap it and take the group down on its way out. A timed-out trial
    // is already infrastructure, but its leftover writer would still be running while the NEXT
    // trial's tree is graded.
    const directory = mkdtempSync(join(tmpdir(), "skillval-wtest-timeout-"));
    const marker = join(directory, "written-after-the-kill.txt");

    let thrown: unknown;
    try {
      spawnAgent({
        args: ["-c", `(sleep 3; touch ${marker}) >/dev/null 2>&1 </dev/null & sleep 30`],
        command: "sh",
        env: { PATH: process.env.PATH ?? "" },
        timeoutMs: 1000,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ExecutorInfraError);
    expect((thrown as ExecutorInfraError).kind).toBe("timeout");

    await new Promise((resolve) => setTimeout(resolve, 4000));
    expect(existsSync(marker)).toBe(false);
    rmSync(directory, { force: true, recursive: true });
  }, 20_000);
});

describe("spawnAgent containment when the leaked writer keeps stdout", () => {
  it("returns promptly and contains a writer that inherited the agent's stdout", async () => {
    // The variant the /dev/null redirect in the tests above was hiding. A writer that KEEPS stdout
    // used to hold spawnSync's own pipe, so spawnSync could not return until that writer finished:
    // in exactly the case where the wrapper failed to reap, the backstop ran after the mutation and
    // the trial stalled until the writer exited. Piping the agent's output through the wrapper
    // makes the wrapper the only pipe holder, so its death releases spawnSync immediately.
    const directory = mkdtempSync(join(tmpdir(), "skillval-wtest-pipe-"));
    const marker = join(directory, "written-by-a-pipe-holding-writer.txt");

    const started = Date.now();
    spawnAgent({
      // No redirect, so the writer inherits stdout - AND the wrapper is killed, so nothing reaps
      // on its way out. That combination is the one that used to stall: the writer held spawnSync's
      // own pipe, so spawnSync could not return until it finished.
      // Kill delayed for the reason given in the test above.
      args: ["-c", `(sleep 4; touch ${marker}) & echo done; sleep 0.5; kill -9 $PPID`],
      command: "sh",
      env: { PATH: process.env.PATH ?? "" },
    });
    const elapsed = Date.now() - started;
    // Returned while the writer was still sleeping - which a held pipe prevented, stalling the
    // trial until the writer exited (measured at ~4.1s here, and up to the 15-minute timeout in
    // general) and letting the mutation land before the backstop could run.
    //
    // Output is NOT asserted here. The agent killed its own supervisor uncatchably, so anything
    // still in flight through the wrapper is lost - the accepted cost of piping, and only in a
    // scenario that is an infrastructure failure regardless. Full capture on a normal run is
    // pinned by the test below, which is the case that must never regress.
    expect(elapsed).toBeLessThan(2500);

    await new Promise((resolve) => setTimeout(resolve, 6000));
    expect(existsSync(marker)).toBe(false);
    rmSync(directory, { force: true, recursive: true });
  }, 20_000);

  it("forwards every byte the agent wrote, including a large trace", () => {
    // Piping made this wrapper responsible for the agent's output rather than letting it write
    // straight to skillval's pipe, so truncation became possible where it was not before. A JSONL
    // trace missing its tail does not parse at all, which would fail every trial of every arm.
    const lines = 20_000;
    const result = spawnAgent({
      args: ["-c", `seq 1 ${lines}; >&2 echo stderr-tail; echo LAST-LINE`],
      command: "sh",
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("LAST-LINE");
    expect(result.stdout.split("\n").filter((line) => line !== "").length).toBe(lines + 1);
    expect(result.stderr).toContain("stderr-tail");
  }, 20_000);
});
