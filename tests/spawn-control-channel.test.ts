import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { spawnAgent } from "../src/executors/spawn.js";

describe("the wrapper control channel is unreachable from the agent", () => {
  it("the agent cannot find the control directory in its parent's argv", () => {
    const result = spawnAgent({
      args: ["-c", "ps -o args= -p $PPID > /tmp/skillval-probe-argv.txt; echo REAL_ANSWER"],
      command: "sh",
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(result.stdout).toContain("REAL_ANSWER");
    const argv = readFileSync("/tmp/skillval-probe-argv.txt", "utf8");
    // The wrapper's own command line must not name the control directory.
    expect(argv).not.toContain("skillval-group-");
  });

  it("the agent cannot read the control path out of its own environment", () => {
    const result = spawnAgent({
      args: ["-c", 'echo "DIR=[$SKILLVAL_CONTROL_DIR] NONCE=[$SKILLVAL_CONTROL_NONCE]"'],
      command: "sh",
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(result.stdout).toContain("DIR=[] NONCE=[]");
  });
});
