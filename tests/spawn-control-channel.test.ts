import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { spawnAgent } from "../src/executors/spawn.js";

describe("the wrapper control channel is unreachable from the agent", () => {
  it("is not in the wrapper's argv", () => {
    // The agent's parent IS the wrapper, so `ps -o args= -p $PPID` reads its command line. A
    // control path passed there was fully readable, which let the agent forge the pid token and
    // point the harness's kill(-pid) at a process group it never owned.
    const result = spawnAgent({
      args: ["-c", "ps -o args= -p $PPID > /tmp/skillval-probe-argv.txt; echo REAL_ANSWER"],
      command: "sh",
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(result.stdout).toContain("REAL_ANSWER");
    expect(readFileSync("/tmp/skillval-probe-argv.txt", "utf8")).not.toContain("skillval-group-");
  });

  it("is not in the agent's environment", () => {
    const result = spawnAgent({
      args: ["-c", 'echo "DIR=[$SKILLVAL_CONTROL_DIR] NONCE=[$SKILLVAL_CONTROL_NONCE]"'],
      command: "sh",
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(result.stdout).toContain("DIR=[] NONCE=[]");
  });

  it("leaves nothing in the temp directory to find", () => {
    // Hiding the PATH was not enough. The control directory lived under the temp dir with a fixed
    // prefix, so the agent globbed for it and read the token outright - nonce and pid together.
    // A secret does not become unreachable by being communicated more carefully. There is now no
    // control directory at all.
    const result = spawnAgent({
      args: [
        "-c",
        // $TMPDIR without braces: Biome reads "${...}" in a plain string as a stray JS template
        // placeholder, and this is shell.
        'ls -d "$TMPDIR"skillval-group-*/ 2>/dev/null; cat "$TMPDIR"skillval-group-*/* 2>/dev/null; echo SWEPT',
      ],
      command: "sh",
      env: { PATH: process.env.PATH ?? "", TMPDIR: process.env.TMPDIR ?? "/tmp/" },
    });
    expect(result.stdout.trim()).toBe("SWEPT");
  });

  it("does not hand the agent the control descriptor", () => {
    // fd 3 is the channel. The wrapper spawns the agent with an explicit three-entry stdio array,
    // so the descriptor stops at the wrapper.
    const result = spawnAgent({
      args: ["-c", "if [ -e /dev/fd/3 ]; then echo AGENT_HAS_FD3; else echo AGENT_BLIND; fi"],
      command: "sh",
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(result.stdout).toContain("AGENT_BLIND");
  });
});
