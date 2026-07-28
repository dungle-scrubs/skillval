import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
// Control data travels through files in a private directory, never through the agent's stderr. A
// marker matched against stderr is spoofable: any command that happens to print it would be
// reclassified as infrastructure and dropped from the vote.
//
// The pid file is a CLEANUP-PENDING TOKEN, not a record to be read opportunistically. The wrapper
// unlinks it once it has taken the group down, so its continued existence is the only thing that
// means "nobody reaped this". That inverts an earlier protocol that guessed from spawnSync's
// result: `result.error !== undefined` is wrong in both directions - a SIGKILLed wrapper reports
// `signal` with NO error, so the group leaked, while a timeout reports an error even though the
// wrapper already cleaned up, so the parent re-killed a pid that may since have been recycled.
const PID_FILE = "pid";
const SPAWN_ERROR_FILE = "spawn-error";

const GROUP_WRAPPER = `
const { spawn } = require("node:child_process");
const { rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
// slice(1), not slice(2): under node -e there is no script filename, so the first user
// argument sits at argv[1]. slice(2) silently dropped the control directory and ran the agent
// with its own command name as the first argument.
// Read from the environment and DELETED before the agent is spawned, so it never appears in a
// place the agent can reach. In argv it was readable with \`ps -o args= -p $PPID\` - the agent's
// parent IS this wrapper - which let the agent forge both control files: one to get its own
// gradeable trial discarded as infrastructure, and one to point the harness's kill(-pid) at an
// unrelated process group. Same defect the move off stderr was supposed to close.
const control = process.env.SKILLVAL_CONTROL_DIR;
const nonce = process.env.SKILLVAL_CONTROL_NONCE;
delete process.env.SKILLVAL_CONTROL_DIR;
delete process.env.SKILLVAL_CONTROL_NONCE;
const [command, ...args] = process.argv.slice(1);
const pidFile = join(control, ${JSON.stringify("pid")});
// PIPED, not inherited. With inherit, a writer the agent backgrounds holds spawnSync's own stdout
// pipe, so spawnSync cannot return until that writer exits - which is precisely the case where the
// wrapper failed to reap, and it means the parent-side backstop only ever runs AFTER the mutation
// it exists to prevent (and stalls the trial until the writer finishes, up to the timeout).
// Piping makes this wrapper the only holder: when it dies the pipe closes, spawnSync returns at
// once, and the backstop runs while the leaked group is still only sleeping.
// stdin stays inherited so the input spawnSync writes still reaches the agent.
// fd 0 is /dev/null when the caller asked for it, rather than relying on spawnSync closing stdin
// on its own. Measured: spawnSync already delivers EOF with or without an empty \`input\`, so the
// flag was a no-op that happened to work - an inherited guarantee, undefended and version
// specific, behind a comment claiming pi would hang without it.
const stdin = process.env.SKILLVAL_CLOSE_STDIN === "1" ? "ignore" : "inherit";
const child = spawn(command, args, { detached: true, stdio: [stdin, "pipe", "pipe"] });
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

// Installed BEFORE anything that can throw. Recording the pid used to come first, so an ENOSPC or
// EMFILE there killed the wrapper through an uncaught exception while the agent was ALREADY
// running and no handler existed to take it down - an orphan with nothing left pointing at it.
let reaped = false;
const reap = () => {
  if (reaped) return;
  reaped = true;
  try { process.kill(-child.pid, "SIGKILL"); } catch {}
  // Consumed, so the parent knows this group is handled. Order matters: kill first, unlink second,
  // or a crash in between drops the token while the group still runs.
  //
  // Deliberately untested, along with the nonce check the parent applies to this file and the
  // drain-before-exit above. All three are defence in depth behind something that IS tested, and
  // each was mutation-checked to confirm it: removing the unlink leaves a kill that is a harmless
  // ESRCH; removing the nonce comparison changes nothing while the control path stays unreadable
  // (the probes in tests/spoof-probe.test.ts pin that); removing the drain still captured 20k
  // lines intact on this platform. Kept because the outer layer failing is exactly when they
  // matter, and written down because a mutation test will not defend any of them.
  try { rmSync(pidFile, { force: true }); } catch {}
};
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => { reap(); process.exit(1); });
}
process.on("uncaughtException", (error) => {
  // Reported, not swallowed. Installing this handler suppresses Node's own stack print, so without
  // it every wrapper-internal fault became status 1 with empty stderr - the exact signature the
  // spawn-error channel exists to eliminate.
  reap();
  try { writeFileSync(join(control, "wrapper-error"), String(error && error.stack ? error.stack : error)); } catch {}
  process.exit(1);
});
child.on("error", (error) => {
  reap();
  try {
    writeFileSync(join(control, ${JSON.stringify("spawn-error")}), command + ": " + error.message);
  } catch {}
  process.exit(127);
});
// Reap on exit, but do NOT leave until the forwarded streams have drained. Piping means this
// wrapper is now responsible for every byte the agent wrote: exiting on "exit" truncated whatever
// was still buffered, and a JSONL trace missing its tail does not parse at all. Reaping first
// closes the leaked writers' pipe ends, so the drain always terminates.
child.on("exit", () => reap());
child.on("close", (code, signal) => {
  if (signal !== null) {
    // Re-raised on ourselves so the caller sees the signal the AGENT died from rather than a flat
    // exit 1 - otherwise a SIGKILLed agent is reported as "exited 1" in the ledger.
    for (const installed of ["SIGTERM", "SIGINT", "SIGHUP"]) process.removeAllListeners(installed);
    try { process.kill(process.pid, signal); } catch {}
    // Reached only when the re-raise did NOT terminate us: Node ignores SIGPIPE and owns SIGUSR1,
    // so killing ourselves with those is a no-op and control falls through here. Exiting 1 would
    // report a signalled agent as a flat nonzero exit, which is what the re-raise exists to avoid.
    try { writeFileSync(join(control, "signal"), signal); } catch {}
    process.exit(128);
  }
  process.exit(code ?? 1);
});

if (child.pid !== undefined) {
  // Nonce-prefixed and newline-terminated. The parent rejects anything else, so a forged token
  // cannot aim the group kill, and a short write cannot be read as a truncated pid.
  try { writeFileSync(pidFile, nonce + ":" + String(child.pid) + "\\n"); }
  catch (error) {
    reap();
    try { writeFileSync(join(control, "wrapper-error"), "recording the agent pid failed: " + error.message); } catch {}
    process.exit(1);
  }
}
`;

// Kills the agent's process group if the wrapper did not. The token still being there is the
// signal; when the wrapper cleaned up it unlinked it, so there is nothing here to act on and no
// window in which a recycled pid could be killed by mistake.
function reapAbandonedGroup(control: string, nonce: string): void {
  const pidFile = join(control, PID_FILE);
  try {
    // Exact shape only - "<nonce>:<pid>\n". A partial write cannot be read as a truncated pid, and
    // a token the agent forged carries no nonce, so it cannot aim this kill at anything.
    const raw = readFileSync(pidFile, "utf8");
    const match = /^([0-9a-f-]{36}):(\d+)\n$/.exec(raw);
    if (match === null || match[1] !== nonce) return;
    const pid = Number.parseInt(match[2] ?? "", 10);
    if (Number.isFinite(pid) && pid > 1) process.kill(-pid, "SIGKILL");
  } catch {
    // Consumed by the wrapper, or never written: either way nothing is owed.
  }
}

function readControlFile(control: string, name: string): string | undefined {
  try {
    return readFileSync(join(control, name), "utf8").trim();
  } catch {
    return undefined;
  }
}

// Runs an agent CLI once and captures its output, translating the two capture-layer failure modes
// (output overflow, timeout) into a typed ExecutorInfraError. A normal nonzero exit is returned as
// data for the caller to interpret, since each executor phrases that differently.
export function spawnAgent(options: SpawnAgentOptions): AgentProcessResult {
  const maxOutputBytes = options.maxOutputBytes ?? AGENT_MAX_OUTPUT_BYTES;
  const timeoutMs = options.timeoutMs ?? AGENT_TIMEOUT_MS;
  const control = mkdtempSync(join(tmpdir(), "skillval-group-"));
  // A per-run secret the agent cannot see: the wrapper deletes both variables from its environment
  // before spawning, so they reach the wrapper and stop there.
  const nonce = randomUUID();
  const result = spawnSync(
    process.execPath,
    ["-e", GROUP_WRAPPER, "--", options.command, ...options.args],
    {
      cwd: options.cwd,
      encoding: "utf8",
      env: {
        ...options.env,
        SKILLVAL_CONTROL_DIR: control,
        SKILLVAL_CONTROL_NONCE: nonce,
        ...(options.closeStdin === true ? { SKILLVAL_CLOSE_STDIN: "1" } : {}),
      },
      ...(options.closeStdin === true ? { input: "" } : {}),
      maxBuffer: maxOutputBytes,
      timeout: timeoutMs,
    },
  );
  reapAbandonedGroup(control, nonce);
  const spawnFailure = readControlFile(control, SPAWN_ERROR_FILE);
  const wrapperFailure = readControlFile(control, "wrapper-error");
  const reportedSignal = readControlFile(control, "signal");
  rmSync(control, { force: true, recursive: true });
  const error = result.error as NodeJS.ErrnoException | undefined;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (wrapperFailure !== undefined) {
    // The wrapper itself broke, so nothing about the skill was tested.
    throw new ExecutorInfraError(`the agent wrapper failed: ${wrapperFailure}`, "process-failed");
  }
  if (spawnFailure !== undefined) {
    // The agent never started, so nothing about the skill was tested. Same classification spawnSync
    // gave this before the wrapper existed, when it could report ENOENT itself.
    throw new ExecutorInfraError(`failed to start ${spawnFailure}`, "process-failed");
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
    signal: (reportedSignal as NodeJS.Signals | undefined) ?? result.signal,
    status: result.status,
    stderr,
    stdout,
  };
}
