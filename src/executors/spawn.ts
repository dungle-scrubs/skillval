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

// A capture-layer failure: the trial yielded no usable trace because the output was too large to
// buffer or the run exceeded its wall-clock budget. The runner records it under a dedicated check
// name so it is never confused with a graded skill result. Distinct from a nonzero agent exit,
// which stays a per-executor error.
export class ExecutorInfraError extends Error {
  public readonly kind: "output-too-large" | "timeout";

  public constructor(message: string, kind: "output-too-large" | "timeout") {
    super(message);
    this.kind = kind;
    this.name = "ExecutorInfraError";
  }
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
