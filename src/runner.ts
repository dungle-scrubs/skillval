/** Orchestrates discovery, trial arms, voting, caching, cleanup, and report persistence. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArmCache } from "./cache.js";
import type { SkillvalConfig } from "./config.js";
import { resolveStateDirectory } from "./config.js";
import type { ReadyDiscoveredSkill } from "./discovery.js";
import { discoverSkills, selectSkills } from "./discovery.js";
import { createExecutor } from "./executors/index.js";
import type { Executor, ExecutorMetadata } from "./executors/types.js";
import type { ResolvedFixture } from "./fixture.js";
import { applyFixture, FixtureSetupError, resolveFixture, selectFixture } from "./fixture.js";
import { gradeTrial } from "./grade.js";
import { resolveLoadout } from "./loadout.js";
import type { ArmResult, CaseResult, EvalCase, RuntimeArm, TrialResult } from "./types.js";
import { loadoutHash, sha256, skillContentHash } from "./utils.js";
import { groupVerdict, VERDICT_TEXT } from "./verdict.js";
import { clampedTrialCount, hasMajority, shouldEscalate } from "./vote.js";

export interface RunOptions {
  readonly allowUnsandboxedPi: boolean;
  readonly caseFilter: string | undefined;
  readonly effort?: string;
  readonly loadout?: string;
  readonly model?: string;
  readonly requestedSkills: readonly string[];
  readonly skipBaseline: boolean;
  readonly useCache: boolean;
}

// A skill installed for an arm: its name, directory to seed, and content hash for the cache key.
interface SeededMember {
  readonly contentHash: string;
  readonly directory: string;
  readonly name: string;
}

// A named loadout resolved to its member skills with content hashes, held for the whole run.
interface RunLoadout {
  readonly members: readonly SeededMember[];
  readonly name: string;
}

// The skills seeded for one arm. solo seeds the target; baseline seeds nothing; group seeds the
// loadout plus the target; peers seeds the loadout minus the target.
function seededSkillsForArm(
  arm: RuntimeArm,
  target: SeededMember,
  loadout: readonly SeededMember[],
): readonly SeededMember[] {
  const withoutTarget = loadout.filter((member) => member.name !== target.name);
  switch (arm) {
    case "baseline":
      return [];
    case "group":
      return [...withoutTarget, target];
    case "peers":
      return withoutTarget;
    default:
      return [target];
  }
}

export interface SkillReport {
  readonly cases: readonly CaseResult[];
  readonly class: "capability" | "preference";
  readonly contentHash: string;
}

export interface ReportLoadout {
  readonly members: readonly { readonly contentHash: string; readonly name: string }[];
  readonly name: string;
}

export interface RunReport {
  readonly executor: ExecutorMetadata;
  // Present in group mode: the loadout that was evaluated, with each member's content hash, so the
  // report fully describes what ran even after the configuration or a peer skill later changes.
  readonly loadout?: ReportLoadout;
  readonly runHash: string;
  readonly skills: Readonly<Record<string, SkillReport>>;
}

export interface RunOutcome {
  readonly failures: number;
  readonly interferences: number;
  readonly noops: number;
  readonly report: RunReport;
  readonly reportPath: string;
}

interface ArmContext {
  readonly cache: ArmCache;
  readonly evalCase: EvalCase;
  readonly executor: Executor;
  readonly fixture: ResolvedFixture | undefined;
  readonly loadout: RunLoadout | undefined;
  readonly skill: ReadyDiscoveredSkill;
  readonly skillHash: string;
  readonly useCache: boolean;
}

interface CaseContext {
  readonly cache: ArmCache;
  readonly executor: Executor;
  readonly loadout: RunLoadout | undefined;
  readonly skill: ReadyDiscoveredSkill;
  readonly skillHash: string;
  readonly skipBaseline: boolean;
  readonly useCache: boolean;
}

export function runEvaluation(
  config: SkillvalConfig,
  options: RunOptions,
  log: (message: string) => void,
): RunOutcome {
  const discovery = discoverSkills(config.roots);
  const selectedSkills = selectSkills(discovery, options.requestedSkills);
  assertPiGenerationAcknowledged(
    config.executor,
    selectedSkills,
    options.caseFilter,
    options.allowUnsandboxedPi,
  );
  const loadout = resolveRunLoadout(config, options.loadout, discovery);
  const executor = createExecutor(config.executor, {
    effort: options.effort,
    model: options.model,
  });
  log(
    `executor: ${executor.metadata.name} ${executor.metadata.version} ` +
      `(model ${executor.metadata.model}, thinking ${executor.metadata.thinking}, ` +
      `invocation detection ${executor.metadata.invocationDetection})`,
  );
  const stateDirectory = resolveStateDirectory();
  const cache = new ArmCache(stateDirectory);
  const skillInputs = selectedSkills.map((skill) => ({
    contentHash: skillContentHash(skill.skillDirectory),
    skill,
  }));
  const runHash = participatingSkillsHash(
    skillInputs.map(({ contentHash, skill }) => ({ contentHash, name: skill.name })),
    loadout,
  );
  const skillReports: Record<string, SkillReport> = {};
  let failures = 0;
  let noops = 0;
  let interferences = 0;

  for (const { contentHash, skill } of skillInputs) {
    const evals = skill.evals;
    log(`${skill.name} (${evals.class}, ${contentHash.slice(0, 12)}):`);
    const cases = evals.cases
      .filter((evalCase) => options.caseFilter === undefined || evalCase.id === options.caseFilter)
      .map((evalCase) =>
        runCase(
          {
            cache,
            executor,
            loadout,
            skill,
            skillHash: contentHash,
            skipBaseline: options.skipBaseline,
            useCache: options.useCache,
          },
          evalCase,
          log,
        ),
      );
    skillReports[skill.name] = { cases, class: evals.class, contentHash };
    failures += cases.filter((result) => !result.pass).length;
    noops += cases.filter((result) => result.noop).length;
    interferences += cases.filter((result) => result.loadout?.verdict === "interference").length;
  }

  const report: RunReport = {
    executor: executor.metadata,
    ...(loadout === undefined
      ? {}
      : {
          loadout: {
            members: loadout.members.map((member) => ({
              contentHash: member.contentHash,
              name: member.name,
            })),
            name: loadout.name,
          },
        }),
    runHash,
    skills: skillReports,
  };
  const reportDirectory = join(stateDirectory, "reports");
  const reportPath = join(reportDirectory, `${runHash}.json`);
  mkdirSync(reportDirectory, { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  return { failures, interferences, noops, report, reportPath };
}

// Resolves the requested loadout to its members and their content hashes, once for the whole run.
function resolveRunLoadout(
  config: SkillvalConfig,
  name: string | undefined,
  discovery: ReturnType<typeof discoverSkills>,
): RunLoadout | undefined {
  if (name === undefined) return undefined;
  const resolved = resolveLoadout(config, name, discovery);
  return {
    members: resolved.members.map((member) => ({
      ...member,
      contentHash: skillContentHash(member.directory),
    })),
    name: resolved.name,
  };
}

// pi has no OS sandbox, so generation trials run agent writes with no enforced isolation. Refuse
// them unless the run explicitly acknowledges the gap, failing before any trial spawns.
export function assertPiGenerationAcknowledged(
  executorName: string,
  skills: readonly ReadyDiscoveredSkill[],
  caseFilter: string | undefined,
  allow: boolean,
): void {
  if (executorName !== "pi" || allow) return;
  for (const skill of skills) {
    for (const evalCase of skill.evals.cases) {
      if (caseFilter !== undefined && evalCase.id !== caseFilter) continue;
      if (evalCase.mode === "generation") {
        throw new Error(
          `pi has no OS sandbox, so generation case "${evalCase.id}" (skill "${skill.name}") would ` +
            "run agent writes without enforced isolation. Re-run with --allow-unsandboxed-pi to " +
            "acknowledge, or use codex or claude for generation cases.",
        );
      }
    }
  }
}

export function participatingSkillsHash(
  skills: readonly { readonly contentHash: string; readonly name: string }[],
  loadout?: { readonly members: readonly SeededMember[]; readonly name: string },
): string {
  const base = [...skills]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(({ contentHash, name }) => `${name}\0${contentHash}`)
    .join("\0");
  // Fold the loadout into the report identity so runs of the same targets under different loadouts,
  // or after a peer's content changes, write to distinct report paths instead of overwriting.
  if (loadout === undefined) return sha256(base);
  const members = loadoutHash(
    loadout.members.map((member) => ({ contentHash: member.contentHash, name: member.name })),
  );
  return sha256(`${base}\0LOADOUT\0${loadout.name}\0${members}`);
}

// Whether a case has an assertion that grades on every arm, including peers (where the target is
// absent). should_trigger does not count - it is target-specific and skipped on peers - so a case
// with only should_trigger has no meaningful without-target comparison.
function hasPeerGradedAssertion(evalCase: EvalCase): boolean {
  const assert = evalCase.assert;
  if (assert === undefined) return false;
  return (
    (assert.must_match?.length ?? 0) > 0 ||
    (assert.must_not_match?.length ?? 0) > 0 ||
    (assert.graders?.length ?? 0) > 0 ||
    assert.json_schema !== undefined ||
    assert.command_exit !== undefined
  );
}

function runCase(
  context: CaseContext,
  evalCase: EvalCase,
  log: (message: string) => void,
): CaseResult {
  // Group mode runs the three loadout arms for every case, ignoring the case's declared arms; the
  // verdict needs all three. Solo mode keeps the case's arms (default solo; baseline when opted in).
  const groupMode = context.loadout !== undefined;
  const arms: readonly RuntimeArm[] = groupMode
    ? ["solo", "group", "peers"]
    : (evalCase.arms ?? ["solo"]).filter((arm) => arm === "solo" || !context.skipBaseline);
  // When the target has no peers in the loadout (empty, or the target is the only member), the group
  // arm seeds the same set as solo, so it is reused rather than run - two independent nondeterministic
  // runs of an identical environment could otherwise disagree and report false interference.
  const hasPeers =
    context.loadout?.members.some((member) => member.name !== context.skill.name) ?? false;
  // Fixture paths are relative to skillval.yml, which sits in the skill directory.
  const fixture = resolveFixture(
    selectFixture(evalCase.fixture, context.skill.evals.fixture),
    context.skill.skillDirectory,
  );
  const results: ArmResult[] = [];
  for (const arm of arms) {
    if (arm === "group" && !hasPeers) {
      const solo = results.find((result) => result.arm === "solo");
      if (solo !== undefined) {
        log(`  ${evalCase.id} [group] ${solo.pass ? "pass" : "FAIL"} (same as solo; no peers)`);
        results.push({ ...solo, arm: "group" });
        continue;
      }
    }
    log(`  ${evalCase.id} [${arm}] ...`);
    const result = runArm(
      {
        cache: context.cache,
        evalCase,
        executor: context.executor,
        fixture,
        loadout: context.loadout,
        skill: context.skill,
        skillHash: context.skillHash,
        useCache: context.useCache,
      },
      arm,
    );
    log(
      `  ${evalCase.id} [${arm}] ${result.pass ? "pass" : "FAIL"}${
        result.cached ? " (cached)" : ""
      }`,
    );
    results.push(result);
  }
  const passOf = (arm: RuntimeArm): boolean =>
    results.find((result) => result.arm === arm)?.pass === true;

  if (groupMode && context.loadout !== undefined) {
    // pass/noop follow the same "with target vs without target" shape as solo mode: the group arm
    // is the with-target comparison, peers is the without-target control. The peers comparison only
    // means something when the case grades behavior on it (not a pure trigger-only case, whose
    // target-specific check is skipped when the target is absent), so gate the no-op on that too.
    const peersMeaningful = hasPeerGradedAssertion(evalCase);
    const verdict = groupVerdict(passOf("solo"), passOf("group"), passOf("peers"), peersMeaningful);
    log(`  ${evalCase.id} verdict: ${VERDICT_TEXT[verdict]}`);
    return {
      arms: results,
      id: evalCase.id,
      loadout: { name: context.loadout.name, verdict },
      noop: peersMeaningful && passOf("peers"),
      pass: passOf("group"),
      rule: evalCase.rule,
    };
  }
  return {
    arms: results,
    id: evalCase.id,
    noop: passOf("baseline"),
    pass: passOf("solo"),
    rule: evalCase.rule,
  };
}

function runArm(context: ArmContext, arm: RuntimeArm): ArmResult {
  const target: SeededMember = {
    contentHash: context.skillHash,
    directory: context.skill.skillDirectory,
    name: context.skill.name,
  };
  // The exact set this arm seeds. loadoutHash keys the arm on it (by name and content), and the
  // same set is handed to runTrial, so the cache key and what actually runs never drift.
  const seeded = seededSkillsForArm(arm, target, context.loadout?.members ?? []);
  // Target-present arms grade the target-specific trigger check, so key them on the target as well:
  // a target that is already in the loadout produces the same seeded set (and loadoutHash) as any
  // other loadout member's group arm, but its trigger result differs.
  const targetPresent = arm === "solo" || arm === "group";
  const identity = {
    arm,
    evalCase: context.evalCase,
    executor: context.executor.metadata,
    fixtureHash: context.fixture?.hash,
    loadoutHash: loadoutHash(
      seeded.map((member) => ({ contentHash: member.contentHash, name: member.name })),
    ),
    triggerTarget: targetPresent ? target.name : undefined,
  };
  if (context.useCache) {
    const hit = context.cache.lookup(identity);
    if (hit !== undefined) return hit;
  }

  const trials: TrialResult[] = [];
  const wanted = clampedTrialCount(context.evalCase.trials);
  for (let index = 0; index < wanted; index += 1) {
    trials.push(runTrial(context, arm, seeded));
  }
  // A disagreement makes the configured sample inconclusive, so collect the full five trials.
  while (shouldEscalate(trials)) trials.push(runTrial(context, arm, seeded));

  const result: ArmResult = {
    arm,
    cached: false,
    pass: hasMajority(trials),
    trials,
  };
  context.cache.store(identity, result);
  return result;
}

function runTrial(
  context: ArmContext,
  arm: RuntimeArm,
  seeded: readonly SeededMember[],
): TrialResult {
  // The runner owns generic resource lifecycle; adapters own provider-specific setup inside it.
  const workspace = mkdtempSync(join(tmpdir(), `skillval-${context.evalCase.id}-`));
  const trialHome = mkdtempSync(join(tmpdir(), "skillval-home-"));

  try {
    const fixtureSetup =
      context.fixture === undefined
        ? undefined
        : applyFixture(context.fixture, workspace, trialHome);
    const trace = context.executor.runTrial({
      arm,
      evalCase: context.evalCase,
      home: trialHome,
      seededSkills: seeded.map((member) => ({ directory: member.directory, name: member.name })),
      skillName: context.skill.name,
      workspace,
    });
    const checks = gradeTrial(context.evalCase, arm, trace, workspace);
    return {
      checks,
      fixtureSetup,
      pass: checks.every((check) => check.pass),
      usage: trace.usage,
    };
  } catch (error) {
    if (error instanceof FixtureSetupError) {
      // Workspace staging failed before the agent ran; this is infrastructure, not grading.
      return {
        checks: [{ detail: error.message, name: "fixture-setup", pass: false }],
        fixtureSetup: error.results,
        pass: false,
        usage: undefined,
      };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return {
      checks: [{ detail, name: "run", pass: false }],
      pass: false,
      usage: undefined,
    };
  } finally {
    // Trials may contain generated source or credentials-related environment state. Always clean
    // both directories, including executor and grader failure paths.
    rmSync(workspace, { force: true, recursive: true });
    rmSync(trialHome, { force: true, recursive: true });
  }
}
