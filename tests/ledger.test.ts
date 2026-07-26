import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildLedger, caseVerdict, executorIdentity, transitions } from "../src/ledger.js";
import type { RunReport } from "../src/runner.js";
import type { ArmResult, CaseResult, Check, RuntimeArm } from "../src/types.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

function armOf(arm: RuntimeArm, pass: boolean, checks: readonly Check[] = []): ArmResult {
  return { arm, cached: false, pass, trials: [{ checks, pass, usage: null }] };
}

function caseOf(partial: Partial<CaseResult> & Pick<CaseResult, "arms">): CaseResult {
  return { id: "case", inconclusive: false, noop: false, pass: true, rule: undefined, ...partial };
}

function reportDir(
  reports: readonly { executor: RunReport["executor"]; skills: RunReport["skills"] }[],
): string {
  const directory = mkdtempSync(join(tmpdir(), "skillval-ledger-"));
  directories.push(directory);
  reports.forEach((report, index) => {
    writeFileSync(
      join(directory, `${index}.json`),
      JSON.stringify({ ...report, runHash: String(index) }),
    );
  });
  return directory;
}

const executor = (model: string, thinking: string): RunReport["executor"] => ({
  invocationDetection: "structured",
  model,
  name: "claude",
  thinking,
  version: "1.0.0",
});

describe("caseVerdict", () => {
  it("separates load-bearing from no-op by the control arm", () => {
    expect(caseVerdict(caseOf({ arms: [armOf("solo", true), armOf("baseline", false)] }))).toBe(
      "load-bearing",
    );
    expect(caseVerdict(caseOf({ arms: [armOf("solo", true), armOf("baseline", true)] }))).toBe(
      "no-op",
    );
  });

  it("reports an uninvoked skill separately from a graded failure", () => {
    const notInvoked = caseOf({
      arms: [
        armOf("solo", false, [
          { detail: "invoked=false, expected=true, evidence=none", name: "trigger", pass: false },
        ]),
      ],
      pass: false,
    });
    // A floor on LOADING the skill is not a judgment about the rule, so it must not read as FAIL.
    expect(caseVerdict(notInvoked)).toBe("not-invoked");

    const graded = caseOf({
      arms: [
        armOf("solo", false, [{ detail: "pattern | got: x", name: "must_match", pass: false }]),
      ],
      pass: false,
    });
    expect(caseVerdict(graded)).toBe("fail");
  });

  it("never reads a process failure as a verdict", () => {
    // The exact shape a provider outage wrote into 29 reports before such failures were typed as
    // infrastructure: a failing "run" check, whose detail carries no outage signature at all.
    const crashed = caseOf({
      arms: [
        armOf("solo", false, [
          {
            detail: "codex exec exited 1: Reading additional input from stdin",
            name: "run",
            pass: false,
          },
        ]),
      ],
      pass: false,
    });
    expect(caseVerdict(crashed)).toBe("inconclusive");
  });
});

describe("buildLedger", () => {
  it("puts each executor identity in its own column and keeps the newest verdict", () => {
    const directory = reportDir([
      {
        executor: executor("sonnet", "low"),
        skills: {
          "my-skill": {
            cases: [caseOf({ arms: [armOf("solo", true), armOf("baseline", true)], id: "c1" })],
            class: "capability",
            contentHash: "a",
          },
        },
      },
      {
        executor: executor("sonnet", "high"),
        skills: {
          "my-skill": {
            cases: [caseOf({ arms: [armOf("solo", true), armOf("baseline", false)], id: "c1" })],
            class: "capability",
            contentHash: "a",
          },
        },
      },
    ]);

    const ledger = buildLedger(directory, "2026-07-26T00:00:00.000Z");

    expect(ledger.executors).toEqual(["claude/sonnet/high", "claude/sonnet/low"]);
    const row = ledger.rows[0];
    expect(row?.cells["claude/sonnet/low"]?.verdict).toBe("no-op");
    expect(row?.cells["claude/sonnet/high"]?.verdict).toBe("load-bearing");
  });

  it("surfaces only rows whose verdict changes across identities", () => {
    const directory = reportDir([
      {
        executor: executor("sonnet", "low"),
        skills: {
          s: {
            cases: [
              caseOf({ arms: [armOf("solo", true), armOf("baseline", true)], id: "stable" }),
              caseOf({ arms: [armOf("solo", true), armOf("baseline", true)], id: "shifts" }),
            ],
            class: "capability",
            contentHash: "a",
          },
        },
      },
      {
        executor: executor("sonnet", "high"),
        skills: {
          s: {
            cases: [
              caseOf({ arms: [armOf("solo", true), armOf("baseline", true)], id: "stable" }),
              caseOf({ arms: [armOf("solo", true), armOf("baseline", false)], id: "shifts" }),
            ],
            class: "capability",
            contentHash: "a",
          },
        },
      },
    ]);

    const moved = transitions(buildLedger(directory, "2026-07-26T00:00:00.000Z"));

    expect(moved.map((row) => row.caseId)).toEqual(["shifts"]);
  });

  it("returns an empty ledger rather than throwing when no reports exist", () => {
    const ledger = buildLedger(join(tmpdir(), "skillval-ledger-does-not-exist"), "t");
    expect(ledger).toEqual({ executors: [], generatedAt: "t", rows: [] });
  });
});

describe("executorIdentity", () => {
  it("keys on the fields the cache keys on", () => {
    expect(executorIdentity(executor("sonnet", "high"))).toBe("claude/sonnet/high");
  });
});
