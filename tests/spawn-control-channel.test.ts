import { describe, expect, it } from "vitest";
import { spawnAgent } from "../src/executors/spawn.js";

describe("the wrapper control channel is unreachable from the agent", () => {
  it("is not in the wrapper's argv", () => {
    // The agent's parent IS the wrapper, so `ps -o args= -p $PPID` reads its command line. A
    // control path passed there was fully readable, which let the agent forge the pid token and
    // point the harness's kill(-pid) at a process group it never owned.
    const result = spawnAgent({
      // Through stdout, not a fixed temp file. Redirecting to a file made the probe pass whenever
      // `ps` FAILED - the redirect created an empty file, the shell still succeeded, and an empty
      // file trivially satisfies "does not contain". The marker proves ps actually produced output.
      // /proc first, ps second: the slim Linux images CI-adjacent work runs in have no procps, and
      // macOS has no /proc. Trying only one made this pass wherever that one was missing, since an
      // empty result trivially "does not contain" anything.
      args: [
        "-c",
        "echo ARGV-BEGIN; if [ -r /proc/$PPID/cmdline ]; then tr '\\0' ' ' < /proc/$PPID/cmdline; else ps -o args= -p $PPID; fi; echo; echo ARGV-END",
      ],
      command: "sh",
      env: { PATH: process.env.PATH ?? "" },
    });
    const argv = result.stdout.split("ARGV-BEGIN")[1]?.split("ARGV-END")[0] ?? "";
    // The read really produced the wrapper's command line: without this the assertion below is
    // vacuous, and it silently was on any host missing the one tool it tried.
    expect(argv).toContain("node");
    expect(argv).not.toContain("skillval-group-");
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
