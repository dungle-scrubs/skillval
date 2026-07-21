import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { armCacheKey, cachedArm, storeArm } from "./cache.js";
import { readCaseFile } from "./case-file.js";
import type { SkillvalConfig } from "./config.js";
import { resolveStateDirectory } from "./config.js";
import type { DiscoveredSkill } from "./discovery.js";
import { discoverSkills, selectSkills } from "./discovery.js";
import { createExecutor } from "./executors/index.js";
import type { Executor } from "./executors/types.js";
import { gradeTrial } from "./grade.js";
import type { Arm, ArmResult, CaseResult, EvalCase, TrialResult } from "./types.js";
import { sha256, skillContentHash } from "./utils.js";
import { clampedTrialCount, hasMajority, shouldEscalate } from "./vote.js";

export interface RunOptions {
  readonly caseFilter: string | undefined;
  readonly requestedSkills: readonly string[];
  readonly skipBaseline: boolean;
  readonly useCache: boolean;
}

export interface SkillReport {
  readonly cases: readonly CaseResult[];
  readonly class: "capability" | "preference";
  readonly contentHash: string;
}

export interface RunReport {
  readonly codexVersion: string;
  readonly model: string;
  readonly runHash: string;
  readonly skills: Readonly<Record<string, SkillReport>>;
}

export interface RunOutcome {
  readonly failures: number;
  readonly noops: number;
  readonly report: RunReport;
  readonly reportPath: string;
}

interface ArmContext {
  readonly evalCase: EvalCase;
  readonly executor: Executor;
  readonly skill: DiscoveredSkill;
  readonly skillHash: string;
  readonly stateDirectory: string;
  readonly useCache: boolean;
}

interface CaseContext {
  readonly executor: Executor;
  readonly skill: DiscoveredSkill;
  readonly skillHash: string;
  readonly skipBaseline: boolean;
  readonly stateDirectory: string;
  readonly useCache: boolean;
}

export function runEvaluation(
  config: SkillvalConfig,
  options: RunOptions,
  log: (message: string) => void,
): RunOutcome {
  const discovery = discoverSkills(config.roots);
  const selectedSkills = selectSkills(discovery, options.requestedSkills);
  const executor = createExecutor(config);
  const stateDirectory = resolveStateDirectory();
  const skillInputs = selectedSkills.map((skill) => ({
    contentHash: skillContentHash(skill.skillDirectory),
    skill,
  }));
  const runHash = participatingSkillsHash(
    skillInputs.map(({ contentHash, skill }) => ({ contentHash, name: skill.name })),
  );
  const skillReports: Record<string, SkillReport> = {};
  let failures = 0;
  let noops = 0;

  for (const { contentHash, skill } of skillInputs) {
    if (!skill.hasSkillval) {
      log(`${skill.name}: no skillval.yml, skipping`);
      continue;
    }
    const caseFilePath = join(skill.skillDirectory, "skillval.yml");
    const evals = readCaseFile(caseFilePath, skill.name);
    log(`${skill.name} (${evals.class}, ${contentHash.slice(0, 12)}):`);
    const cases = evals.cases
      .filter((evalCase) => options.caseFilter === undefined || evalCase.id === options.caseFilter)
      .map((evalCase) =>
        runCase(
          {
            executor,
            skill,
            skillHash: contentHash,
            skipBaseline: options.skipBaseline,
            stateDirectory,
            useCache: options.useCache,
          },
          evalCase,
          log,
        ),
      );
    skillReports[skill.name] = { cases, class: evals.class, contentHash };
    failures += cases.filter((result) => !result.pass).length;
    noops += cases.filter((result) => result.noop).length;
  }

  const report: RunReport = {
    codexVersion: executor.metadata.version,
    model: executor.metadata.model,
    runHash,
    skills: skillReports,
  };
  const reportDirectory = join(stateDirectory, "reports");
  const reportPath = join(reportDirectory, `${runHash}.json`);
  mkdirSync(reportDirectory, { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  return { failures, noops, report, reportPath };
}

export function participatingSkillsHash(
  skills: readonly { readonly contentHash: string; readonly name: string }[],
): string {
  return sha256(
    [...skills]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(({ contentHash, name }) => `${name}\0${contentHash}`)
      .join("\0"),
  );
}

function runCase(
  context: CaseContext,
  evalCase: EvalCase,
  log: (message: string) => void,
): CaseResult {
  const arms = (evalCase.arms ?? ["skill"]).filter(
    (arm) => arm === "skill" || !context.skipBaseline,
  );
  const results = arms.map((arm) => {
    log(`  ${evalCase.id} [${arm}] ...`);
    const result = runArm(
      {
        evalCase,
        executor: context.executor,
        skill: context.skill,
        skillHash: context.skillHash,
        stateDirectory: context.stateDirectory,
        useCache: context.useCache,
      },
      arm,
    );
    log(
      `  ${evalCase.id} [${arm}] ${result.pass ? "pass" : "FAIL"}${
        result.cached ? " (cached)" : ""
      }`,
    );
    return result;
  });
  return {
    arms: results,
    id: evalCase.id,
    noop: results.find((result) => result.arm === "baseline")?.pass === true,
    pass: results.find((result) => result.arm === "skill")?.pass === true,
    rule: evalCase.rule,
  };
}

function runArm(context: ArmContext, arm: Arm): ArmResult {
  const key = armCacheKey(
    context.skillHash,
    context.evalCase,
    arm,
    context.executor.metadata.version,
    context.executor.metadata.model,
  );
  if (context.useCache) {
    const hit = cachedArm(key, context.stateDirectory);
    if (hit !== undefined) return hit;
  }

  const trials: TrialResult[] = [];
  const wanted = clampedTrialCount(context.evalCase.trials);
  for (let index = 0; index < wanted; index += 1) {
    trials.push(runTrial(context, arm));
  }
  while (shouldEscalate(trials)) trials.push(runTrial(context, arm));

  const result: ArmResult = {
    arm,
    cached: false,
    pass: hasMajority(trials),
    trials,
  };
  storeArm(key, result, context.stateDirectory);
  return result;
}

function runTrial(context: ArmContext, arm: Arm): TrialResult {
  const workspace = mkdtempSync(join(tmpdir(), `skillval-${context.evalCase.id}-`));
  const trialHome = mkdtempSync(join(tmpdir(), "skillval-home-"));
  if (arm === "skill") {
    const skillsRoot = join(workspace, ".agents/skills");
    mkdirSync(skillsRoot, { recursive: true });
    symlinkSync(context.skill.skillDirectory, join(skillsRoot, context.skill.name));
  }

  try {
    const trace = context.executor.runTrial({
      arm,
      evalCase: context.evalCase,
      home: trialHome,
      skillName: context.skill.name,
      workspace,
    });
    const checks = gradeTrial(context.evalCase, arm, trace, workspace);
    return {
      checks,
      pass: checks.every((check) => check.pass),
      usage: trace.usage,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      checks: [{ detail, name: "run", pass: false }],
      pass: false,
      usage: undefined,
    };
  } finally {
    rmSync(workspace, { force: true, recursive: true });
    rmSync(trialHome, { force: true, recursive: true });
  }
}
