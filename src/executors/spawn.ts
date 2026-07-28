import { spawnSync } from "node:child_process";

// spawnSync buffers the child's entire stdout in memory. A runaway generation (observed: GLM-5.2
// emitting multi-hundred-MB to multi-GB `--mode json` traces when a skill is seeded) overflows that
// buffer; Node kills the child and sets ENOBUFS. Either way the trial produced no usable trace for
// reasons unrelated to whether the skill works, and the old code recorded it as the skill failing.
// This cap is high enough that a legitimately verbose trace completes and grades (observed real
// traces run tens of MB), and low enough that a true runaway is aborted early at the cap rather than
// exhausting memory. Trials run sequentially, so peak use is one buffer plus its decode/parse, not a
// per-trial multiple; a memory-constrained environment that needed a harder ceiling would stream to
// a temp file instead of buffering, at the cost of the early abort.
export const AGENT_MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
export const AGENT_TIMEOUT_MS = 15 * 60 * 1000;

// A capture-layer or provider-layer failure: the trial yielded no usable trace for reasons
// unrelated to whether the skill works - output too large to buffer, wall-clock budget exceeded,
// or the provider refusing to serve at all (quota, rate limit, auth). The runner records it under
// a dedicated check name so it is never confused with a graded skill result, excludes it from the
// vote, and never caches it. A nonzero agent exit counts as a graded result only when the trace
// shows a completed turn; an exit that completed nothing is infrastructure too (throwNeverGraded).
export class ExecutorInfraError extends Error {
  public readonly kind:
    | "grading-tree"
    | "output-too-large"
    | "process-failed"
    | "provider-unavailable"
    | "staging-failed"
    | "timeout";

  public constructor(
    message: string,
    kind:
      | "grading-tree"
      | "output-too-large"
      | "process-failed"
      | "provider-unavailable"
      | "staging-failed"
      | "timeout",
  ) {
    super(message);
    this.kind = kind;
    this.name = "ExecutorInfraError";
  }
}

// Signatures of a provider refusing service on a nonzero exit. Deliberately narrow and literal:
// each phrase names an account/limit condition no agent output legitimately produces as its own
// failure mode. Observed live: codex burning through its usage quota mid-suite recorded 29 trials
// as content FAILs and cached them - exactly the false-verdict class the infra path exists for.
const PROVIDER_UNAVAILABLE_PATTERN =
  /usage limit|rate.?limit(ed)?|quota exceeded|too many requests|insufficient credit|purchase more credits|billing|invalid api key|no api key|not authenticated|401 unauthorized/i;

// Whether text carries a provider-availability signature. Exported because reports written before
// provider failures were classified as infrastructure still contain them as content failures, and
// a reader of that history must not present them as verdicts.
export function isProviderUnavailable(output: string): boolean {
  return PROVIDER_UNAVAILABLE_PATTERN.test(output);
}

// Classifies a failed spawn's output: a provider-availability failure throws the typed infra
// error; anything else returns so the executor raises its own descriptive error.
export function throwIfProviderUnavailable(command: string, output: string): void {
  const match = PROVIDER_UNAVAILABLE_PATTERN.exec(output);
  if (match !== null) {
    throw new ExecutorInfraError(
      `${command} unavailable (${match[0]}); the trial never ran against the model`,
      "provider-unavailable",
    );
  }
}

/**
 * Raised when an agent CLI exits nonzero WITHOUT completing a turn.
 *
 * The discriminator is the trace, not the exit status. A CLI that dies after the model finished
 * still holds a real answer, and that answer is gradeable - the trial earned its verdict. A CLI
 * that dies before completing a turn graded nothing at all, so calling it a content FAIL invents a
 * verdict out of a crash and then caches it. That is the same defect that recorded 29 trials as
 * false FAILs during a provider outage; the signature-matching fix above only ever covered the
 * failures that announce themselves, and an exit with an empty stderr announces nothing.
 */
export function throwNeverGraded(
  command: string,
  status: number | null,
  signal: string | null,
  detail: string,
): never {
  const how = signal === null ? `exited ${status}` : `died on ${signal}`;
  throw new ExecutorInfraError(
    `${command} ${how} without completing a turn: ${detail.trim() || "(no output)"}`,
    "process-failed",
  );
}

export interface AgentProcessResult {
  readonly signal: NodeJS.Signals | null;
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

export interface SpawnAgentOptions {
  readonly args: readonly string[];
  // pi -p blocks reading stdin when it is an open non-TTY pipe, hanging the trial until the timeout
  // kills it. Closing stdin with an empty input sends immediate EOF, equivalent to `</dev/null`.
  readonly closeStdin?: boolean;
  readonly command: string;
  readonly cwd?: string;
  readonly env: NodeJS.ProcessEnv;
  // Overridable only so tests can exercise the overflow and timeout paths cheaply; executors use the
  // module defaults.
  readonly maxOutputBytes?: number;
  readonly timeoutMs?: number;
}

// Runs the agent as its own process-group LEADER and kills the whole group when it exits.
//
// spawnSync returns when the CLI it launched exits, which says nothing about what that CLI forked -
// and the evaluated model does not need the CLI to daemonize to exploit this. It can run
// `(sleep 5; echo x > out.ts) &` in one bash call, finish its turn, and have that writer mutate the
// workspace WHILE the tree is being snapshotted and graded. Measured: without this wrapper the
// backgrounded writer lands its file; with it, it does not.
//
// spawnSync ignores `detached` (measured - `kill(-pid)` returns ESRCH either way), so the group is
// created by a wrapper: a `node -e` process that spawns the real command detached, forwards its
// stdio, and reaps the group on exit or on a signal. The wrapper is what spawnSync waits for, so
// this whole path stays synchronous. The pid file is belt and braces for the paths the wrapper
// cannot trap - an EXTERNAL SIGKILL, including one the agent sends its own supervisor. Not the
// overflow abort: measured, spawnSync sends SIGTERM there (its killSignal default) and waits, so
// the wrapper does get its chance. An earlier comment claimed otherwise.
// Control data travels on an extra pipe (fd 3) that the wrapper inherits and the AGENT does not.
//
// Nothing about it touches the filesystem, because every filesystem answer failed. A marker on
// stderr was spoofable by any agent that printed it. Moving to files in a private directory did not
// help while the path sat in the wrapper's argv - `ps -o args= -p $PPID` handed it over, since the
// agent's parent IS the wrapper. Passing the path in an environment variable the wrapper deletes
// did not help either: the directory lives under the temp dir with a fixed prefix, so the agent
// simply globbed for it and read the token, nonce and all (verified - it printed
// "<nonce>:<pid>"). A secret does not become unreachable by being communicated more carefully; it
// becomes unreachable by not existing anywhere the agent can look.
//
// fd 3 is not a place. The parent opens it as a pipe, the wrapper writes to it, and the wrapper
// spawns the agent with an explicit three-entry stdio array so fd 3 is never in the agent's table
// (verified: the agent finds no /dev/fd/3). spawnSync hands the contents back in result.output[3].
//
// KNOWN LIMITS of a pid-plus-acknowledgement protocol, both inherent rather than oversights, and
// both unreachable by a test:
//
//   - The group exists before its pid is reported, and the window cannot be closed. The report is
//     the FIRST statement after `spawn()`, and it is still not early enough: on Linux an agent that
//     kills its supervisor immediately wins the race before `spawn()` has even returned the pid to
//     JS, so nothing could have been recorded (verified in a container - the channel held only a
//     marker written BEFORE the spawn call). macOS loses that race, which is why this looked like a
//     ~2ms curiosity locally and was a deterministic CI failure on Linux. Closing it needs the
//     wrapper itself to be the group leader, which Node cannot arrange: no setpgid binding, and
//     spawnSync ignores `detached`.
//
//     What this costs is bounded. It requires the agent to SIGKILL its own supervisor within
//     microseconds of starting; the realistic case this whole wrapper exists for - an agent that
//     backgrounds a writer and exits normally - is contained on both platforms, verified in a
//     container (14ms, "pid N / reaped", the writer never landing its file).
//   - Killing the group and reporting "reaped" cannot be made atomic. A SIGKILL between them makes
//     the parent repeat the kill against a pid that may since have been recycled; reversing the
//     order trades that for a leak instead. Only a kernel-level handle would close both.
//
// A third limit is documented rather than defended: the wrapper sets `process.exitCode` and lets
// the loop drain instead of calling `process.exit`, because Node documents the latter as able to
// truncate pending pipe writes. Neither this review nor I could reproduce truncation - probes to
// 64MB came back byte-exact - so the abrupt-exit mutant survives the suite. It is a documented
// hazard on the exact path that carries every trace, and the correct form costs nothing.
//
// The protocol is newline-delimited and written with writeSync, so a SIGKILLed wrapper still leaves
// whatever it had already reported:
//   pid <n>              the agent's process group, reported immediately after spawn
//   reaped               the wrapper took the group down; nothing is owed
//   spawn-error <text>   the agent could not be started at all
//   wrapper-error <text> the wrapper itself broke
//   signal <name>        the agent died on a signal the wrapper could not re-raise on itself
const CONTROL_FD = 3;

interface WrapperReport {
  readonly pid?: number;
  readonly reaped: boolean;
  readonly signal?: string;
  readonly spawnError?: string;
  readonly wrapperError?: string;
}

const GROUP_WRAPPER = `
const { spawn } = require("node:child_process");
const { writeSync } = require("node:fs");
// slice(1), not slice(2): under node -e there is no script filename, so the first user
// argument sits at argv[1].
const [command, ...args] = process.argv.slice(1);
// writeSync, so a SIGKILLed wrapper still leaves behind whatever it had already reported.
const report = (line) => { try { writeSync(3, line + "\\n"); } catch {} };

// fd 0 is /dev/null when the caller asked for it, rather than relying on spawnSync closing stdin
// on its own. Measured: spawnSync already delivers EOF either way, so the flag was a no-op that
// happened to work - an inherited guarantee, undefended and version specific.
const stdin = process.env.SKILLVAL_CLOSE_STDIN === "1" ? "ignore" : "inherit";
// PIPED, not inherited. With inherit, a writer the agent backgrounds holds spawnSync's own stdout
// pipe, so spawnSync cannot return until that writer exits - precisely the case where this wrapper
// failed to reap, which made the parent-side backstop run AFTER the mutation it exists to prevent
// and stalled the trial meanwhile. Piping makes this wrapper the only holder, so its death
// releases spawnSync at once. Three entries exactly, so fd 3 is NOT in the agent's table.
const child = spawn(command, args, { detached: true, stdio: [stdin, "pipe", "pipe"] });
// FIRST, before anything else. The group exists the moment spawn() returns and the agent runs
// concurrently from that instant, so every statement between here and this report is a window in
// which the agent can kill this wrapper and leave a group nobody knows the id of. On macOS that
// window measured ~2ms and looked unreachable; on Linux the agent wins the race reliably, and CI
// failed both containment tests because the report never happened at all.
if (child.pid !== undefined) report("pid " + String(child.pid));
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

// Installed before anything that can throw. Recording the pid used to come first, so a failure
// there killed the wrapper through an uncaught exception while the agent was ALREADY running,
// with no handler left to take it down.
let reaped = false;
const reap = () => {
  if (reaped) return;
  reaped = true;
  try { process.kill(-child.pid, "SIGKILL"); } catch {}
  report("reaped");
};
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => { reap(); process.exit(1); });
}
process.on("uncaughtException", (error) => {
  // Reported, not swallowed. Installing this handler suppresses Node's own stack print, so without
  // it every wrapper-internal fault became status 1 with empty stderr.
  reap();
  report("wrapper-error " + String(error && error.stack ? error.stack : error).split("\\n")[0]);
  process.exit(1);
});
child.on("error", (error) => {
  reap();
  report("spawn-error " + command + ": " + error.message);
  process.exit(127);
});
// Reap on exit, but leave only once the forwarded streams have drained - this wrapper owns every
// byte the agent wrote, and a JSONL trace missing its tail does not parse at all. Reaping first
// closes the leaked writers' pipe ends, so the drain always terminates.
child.on("exit", () => reap());
child.on("close", (code, signal) => {
  if (signal === null) {
    // exitCode, NOT process.exit(). Child "close" only says the CHILD's streams closed; the
    // wrapper's own forwarding writes to its stdout are asynchronous and may still be queued, and
    // Node documents process.exit as able to truncate pending pipe writes. Setting the code and
    // letting the loop drain is the documented way to flush. A JSONL trace missing its tail does
    // not parse at all, so this is the difference between a graded trial and an infrastructure
    // failure - and it would only ever show up under backpressure, on a big trace, in production.
    process.exitCode = code ?? 1;
    return;
  }
  {
    // Re-raised on ourselves so the caller sees the signal the AGENT died from rather than a flat
    // exit 1 - otherwise a SIGKILLed agent is reported as "exited 1" in the ledger.
    for (const installed of ["SIGTERM", "SIGINT", "SIGHUP"]) process.removeAllListeners(installed);
    try { process.kill(process.pid, signal); } catch {}
    // Reached only when the re-raise did NOT terminate us: Node ignores SIGPIPE and owns SIGUSR1.
    report("signal " + signal);
    process.exitCode = 128;
  }
});
`;

function parseWrapperReport(raw: string): WrapperReport {
  let pid: number | undefined;
  let reaped = false;
  let signal: string | undefined;
  let spawnError: string | undefined;
  let wrapperError: string | undefined;
  for (const line of raw.split("\n")) {
    if (line === "reaped") reaped = true;
    else if (line.startsWith("pid ")) {
      const parsed = Number.parseInt(line.slice(4), 10);
      if (Number.isFinite(parsed) && parsed > 1) pid = parsed;
    } else if (line.startsWith("spawn-error ")) spawnError = line.slice(12);
    else if (line.startsWith("wrapper-error ")) wrapperError = line.slice(14);
    else if (line.startsWith("signal ")) signal = line.slice(7);
  }
  return { pid, reaped, signal, spawnError, wrapperError };
}

// Runs an agent CLI once and captures its output, translating the two capture-layer failure modes
// (output overflow, timeout) into a typed ExecutorInfraError. A normal nonzero exit is returned as
// data for the caller to interpret, since each executor phrases that differently.
export function spawnAgent(options: SpawnAgentOptions): AgentProcessResult {
  const maxOutputBytes = options.maxOutputBytes ?? AGENT_MAX_OUTPUT_BYTES;
  const timeoutMs = options.timeoutMs ?? AGENT_TIMEOUT_MS;
  const result = spawnSync(
    process.execPath,
    ["-e", GROUP_WRAPPER, "--", options.command, ...options.args],
    {
      cwd: options.cwd,
      encoding: "utf8",
      env: {
        ...options.env,
        ...(options.closeStdin === true ? { SKILLVAL_CLOSE_STDIN: "1" } : {}),
      },
      ...(options.closeStdin === true ? { input: "" } : {}),
      maxBuffer: maxOutputBytes,
      // The fourth entry is the control pipe. The wrapper writes to it; the agent never inherits it.
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      timeout: timeoutMs,
    },
  );
  const report = parseWrapperReport(String(result.output?.[CONTROL_FD] ?? ""));
  // Reaped here only when the wrapper did not do it itself. "reaped" is the wrapper's
  // acknowledgement, so its absence - not a guess from spawnSync's result - is what says a group is
  // still owed. An earlier version keyed on `result.error`, which is wrong in both directions: a
  // SIGKILLed wrapper reports `signal` with NO error, so the group leaked, while a timeout reports
  // an error even though the wrapper already cleaned up.
  if (report.pid !== undefined && !report.reaped) {
    try {
      process.kill(-report.pid, "SIGKILL");
    } catch {
      // ESRCH: the group is already gone.
    }
  }
  const error = result.error as NodeJS.ErrnoException | undefined;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (report.wrapperError !== undefined) {
    // The wrapper itself broke, so nothing about the skill was tested.
    throw new ExecutorInfraError(
      `the agent wrapper failed: ${report.wrapperError}`,
      "process-failed",
    );
  }
  if (report.spawnError !== undefined) {
    // The agent never started, so nothing about the skill was tested. Same classification spawnSync
    // gave this before the wrapper existed, when it could report ENOENT itself.
    throw new ExecutorInfraError(`failed to start ${report.spawnError}`, "process-failed");
  }
  if (error?.code === "ETIMEDOUT") {
    throw new ExecutorInfraError(
      `${options.command} timed out after ${Math.round(timeoutMs / 1000)}s`,
      "timeout",
    );
  }
  // When stdout exceeds maxBuffer, Node sets UV_ENOBUFS and kills the child before returning, so
  // ENOBUFS is the authoritative, byte-accurate overflow signal - no length heuristic is needed or
  // reliable (a nonzero exit alone cannot be told apart from a legitimate error exit at similar
  // size). Verified against the Node 26 spawn_sync implementation.
  if (error?.code === "ENOBUFS") {
    throw new ExecutorInfraError(
      `${options.command} produced more than ${Math.floor(maxOutputBytes / (1024 * 1024))}MB of ` +
        "output (runaway generation); recorded as an infrastructure failure, not a skill result",
      "output-too-large",
    );
  }
  // The wrapper reports a signal it could not re-raise on itself (Node ignores SIGPIPE and owns
  // SIGUSR1), so a signalled agent is never flattened into a bare nonzero exit.
  return {
    signal: (report.signal as NodeJS.Signals | undefined) ?? result.signal,
    status: result.status,
    stderr,
    stdout,
  };
}
