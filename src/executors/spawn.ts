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

// KNOWN LIMIT - no descendant containment. spawnSync returns when the CLI it launched exits, which
// says nothing about helpers that CLI forked; a surviving background writer could still mutate the
// workspace while it is being snapshotted and graded. There is no sync fix: spawnSync IGNORES
// `detached`, so the child never becomes a process-group leader and `kill(-pid)` returns ESRCH
// (measured both ways - a backgrounded `sleep 1; touch` survived identically with and without it).
// Real containment needs the async `spawn` plus a group kill, which means making this whole path
// async. Untaken because no supported agent CLI daemonizes, and a comment claiming containment that
// does not contain is worse than a documented gap.
//
// Runs an agent CLI once and captures its output, translating the two capture-layer failure modes
// (output overflow, timeout) into a typed ExecutorInfraError. A normal nonzero exit is returned as
// data for the caller to interpret, since each executor phrases that differently.
export function spawnAgent(options: SpawnAgentOptions): AgentProcessResult {
  const maxOutputBytes = options.maxOutputBytes ?? AGENT_MAX_OUTPUT_BYTES;
  const timeoutMs = options.timeoutMs ?? AGENT_TIMEOUT_MS;
  const result = spawnSync(options.command, [...options.args], {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    ...(options.closeStdin === true ? { input: "" } : {}),
    maxBuffer: maxOutputBytes,
    timeout: timeoutMs,
  });
  const error = result.error as NodeJS.ErrnoException | undefined;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
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
  return { signal: result.signal, status: result.status, stderr, stdout };
}
