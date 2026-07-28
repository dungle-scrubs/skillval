/** Orchestrates discovery, trial arms, voting, caching, cleanup, and report persistence. */
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, sep } from "node:path";
import type { AblationVariants } from "./ablate.js";
import { AblationError, ablateRule } from "./ablate.js";
import type { ArmCacheIdentity } from "./cache.js";
import { ArmCache } from "./cache.js";
import type { SkillvalConfig } from "./config.js";
import { resolveStateDirectory } from "./config.js";
import type {
  DiscoveredInstruction,
  DiscoveryResult,
  ReadyDiscoveredInstruction,
  ReadyDiscoveredSkill,
} from "./discovery.js";
import { discoverProjects, discoverSkills, selectSkills } from "./discovery.js";
import { createExecutor } from "./executors/index.js";
import type { StagedSkill } from "./executors/seed.js";
import { ExecutorInfraError } from "./executors/spawn.js";
import type { Executor, ExecutorMetadata } from "./executors/types.js";
import type { ResolvedFixture } from "./fixture.js";
import { applyFixture, FixtureSetupError, resolveFixture, selectFixture } from "./fixture.js";
import { gradeTrial } from "./grade.js";
import { renderHtmlReport } from "./html-report.js";
import type { InstructionFileContent } from "./instruction.js";
import { armInstructionContent, INSTRUCTION_ARMS, resolveRuleFile } from "./instruction.js";
import { resolveLoadout } from "./loadout.js";
import type { ArmResult, CaseResult, Check, EvalCase, RuntimeArm, TrialResult } from "./types.js";
import { loadoutHash, pathContains, sha256, skillContentHash } from "./utils.js";
import type { ArmState, Verdict } from "./verdict.js";
import { armState, groupVerdict, INSTRUCTION_VERDICT_TEXT, VERDICT_TEXT } from "./verdict.js";
import { clampedTrialCount, hasMajority, shouldEscalate } from "./vote.js";

export interface RunOptions {
  readonly allowShell: boolean;
  readonly allowUnsandboxedPi: boolean;
  readonly caseFilter: string | undefined;
  readonly effort?: string;
  readonly loadout?: string;
  readonly model?: string;
  readonly requestedInstructions: readonly string[];
  readonly requestedSkills: readonly string[];
  readonly skipBaseline: boolean;
  readonly useCache: boolean;
}

// A skill installed for an arm: its name, directory to seed, and content hash for the cache key.
export interface SeededMember {
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
export function seededSkillsForArm(
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
  readonly instructions?: Readonly<Record<string, InstructionTargetReport>>;
  // Present in group mode: the loadout that was evaluated, with each member's content hash, so the
  // report fully describes what ran even after the configuration or a peer skill later changes.
  readonly loadout?: ReportLoadout;
  readonly runHash: string;
  readonly skills: Readonly<Record<string, SkillReport>>;
}

export interface RunOutcome {
  readonly failures: number;
  // Written beside the JSON report unless the configuration disables it. The CLI opens this.
  readonly htmlReportPath?: string;
  // Cases whose deciding arm was never graded (infrastructure failures): not failures, not passes.
  readonly inconclusives: number;
  readonly instructionFindings: number;
  readonly interferences: number;
  readonly noops: number;
  readonly report: RunReport;
  readonly reportPath: string;
}

// One arm's predicted cost. A cache hit runs nothing (trialsMin/Max 0); a group arm with no peers is
// reused from solo, so it is neither cached nor run. An uncached arm runs at least its configured
// trial count and, unless that count is 1 (a single trial can never disagree), may escalate to 5.
export interface ArmPlan {
  readonly arm: RuntimeArm;
  readonly cached: boolean;
  readonly reused: boolean;
  readonly trialsMax: number;
  readonly trialsMin: number;
}

export interface CasePlan {
  readonly arms: readonly ArmPlan[];
  readonly id: string;
}

export interface SkillPlan {
  readonly cases: readonly CasePlan[];
  readonly name: string;
}

// An instruction case plans the three ablation arms, or none at all when the rule is not visible to
// this executor - an n/a case spends nothing, and the plan says so rather than hiding it.
export interface InstructionCasePlan {
  readonly arms: readonly ArmPlan[];
  readonly id: string;
  readonly na: boolean;
}

export interface InstructionTargetPlan {
  readonly cases: readonly InstructionCasePlan[];
  readonly id: string;
}

// The result of a dry run: what a real run would spend against the current cache, spawning nothing.
export interface RunPlan {
  readonly armsCached: number;
  readonly armsReused: number;
  readonly armsToRun: number;
  readonly executor: ExecutorMetadata;
  readonly instructions: readonly InstructionTargetPlan[];
  readonly skills: readonly SkillPlan[];
  readonly trialsMax: number;
  readonly trialsMin: number;
}

export type InstructionAction = "delete" | "investigate" | "keep" | "review";

export interface InstructionFinding {
  readonly action: InstructionAction;
  readonly arms: readonly ArmResult[];
  readonly caseId: string;
  readonly file: string;
  readonly naReason?: string;
  readonly rule: string | undefined;
  readonly span: string;
  readonly verdict: Verdict | "n/a";
}

export interface InstructionTargetReport {
  readonly directory: string;
  readonly findings: readonly InstructionFinding[];
  readonly id: string;
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

interface InstructionArmContext {
  readonly cache: ArmCache;
  readonly content: string;
  readonly evalCase: EvalCase;
  readonly executor: Executor;
  readonly filename: string;
  readonly fixture: ResolvedFixture | undefined;
  readonly targetId: string;
  readonly useCache: boolean;
}

interface InstructionCaseContext {
  readonly cache: ArmCache;
  readonly executor: Executor;
  readonly files: readonly InstructionFileContent[];
  readonly target: ReadyDiscoveredInstruction;
  readonly useCache: boolean;
}

export function runEvaluation(
  config: SkillvalConfig,
  options: RunOptions,
  log: (message: string) => void,
): RunOutcome {
  const rootDiscovery = discoverSkills(config.roots, config.exclude ?? []);
  const projectDiscovery = discoverProjects(config.projects ?? [], config.exclude ?? []);
  const discovery: DiscoveryResult = {
    missingRoots: [...rootDiscovery.missingRoots, ...projectDiscovery.missingRoots],
    skills: [...rootDiscovery.skills, ...projectDiscovery.skills],
  };
  const allTargetsRequested =
    options.requestedInstructions.length === 0 && options.requestedSkills.length === 0;
  const selectedSkills =
    allTargetsRequested || options.requestedSkills.length > 0
      ? selectSkills(discovery, options.requestedSkills)
      : [];
  const selectedInstructions =
    allTargetsRequested || options.requestedInstructions.length > 0
      ? selectInstructions(projectDiscovery.instructions, options.requestedInstructions)
      : [];
  assertShellAllowed(selectedSkills, options.caseFilter, options.allowShell, selectedInstructions);
  assertPiGenerationAcknowledged(
    config.executor,
    selectedSkills,
    options.caseFilter,
    options.allowUnsandboxedPi,
    selectedInstructions,
  );
  const loadout = resolveRunLoadout(config, options.loadout, discovery, log);
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
  const instructionInputs = selectedInstructions.map((target) => ({
    files: readInstructionFiles(target),
    target,
  }));
  const skillRunHash = participatingSkillsHash(
    skillInputs.map(({ contentHash, skill }) => ({ contentHash, name: skill.name })),
    loadout,
  );
  const targetsHash =
    instructionInputs.length === 0
      ? skillRunHash
      : sha256(
          `${skillRunHash}\0INSTRUCTIONS\0${instructionInputs
            .map(({ files, target }) => `${target.id}\0${instructionFilesHash(files)}`)
            .sort()
            .join("\0")}`,
        );
  // Results are executor-specific (a rule visible to codex can be n/a for claude), so the executor
  // identity belongs in the report path. Without it, running the same targets under a second
  // executor silently overwrites the first report.
  // The case filter is part of the report's identity: a --case run measures a different slice
  // than the full suite and must not overwrite its report (or another case's).
  const runHash = sha256(
    `${targetsHash}\0EXECUTOR\0${executor.metadata.name}\0${executor.metadata.version}\0` +
      `${executor.metadata.model}\0${executor.metadata.thinking}\0CASE\0${options.caseFilter ?? ""}`,
  );
  const instructionReports: Record<string, InstructionTargetReport> = {};
  const skillReports: Record<string, SkillReport> = {};
  let failures = 0;
  let inconclusives = 0;
  let instructionFindings = 0;
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
    failures += cases.filter((result) => !result.pass && !result.inconclusive).length;
    inconclusives += cases.filter((result) => result.inconclusive).length;
    noops += cases.filter((result) => result.noop).length;
    interferences += cases.filter((result) => result.loadout?.verdict === "interference").length;
  }

  for (const { files, target } of instructionInputs) {
    log(`${target.id} (${target.evals.class}):`);
    const findings = target.evals.cases
      .filter((evalCase) => options.caseFilter === undefined || evalCase.id === options.caseFilter)
      .map((evalCase) =>
        runInstructionCase(
          {
            cache,
            executor,
            files,
            target,
            useCache: options.useCache,
          },
          evalCase,
          log,
        ),
      );
    instructionReports[target.id] = {
      directory: target.directory,
      findings,
      id: target.id,
    };
    const applicable = findings.filter((finding) => finding.verdict !== "n/a");
    instructionFindings += applicable.length;
    failures += applicable.filter(
      (finding) => !instructionGroupPassed(finding) && !instructionGroupUngraded(finding),
    ).length;
    inconclusives += applicable.filter((finding) => instructionGroupUngraded(finding)).length;
    noops += applicable.filter((finding) => {
      const evalCase = target.evals.cases.find((candidate) => candidate.id === finding.caseId);
      return evalCase !== undefined && instructionFindingIsNoop(finding, evalCase);
    }).length;
  }

  const report: RunReport = {
    executor: executor.metadata,
    ...(instructionInputs.length === 0 ? {} : { instructions: instructionReports }),
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
  // The HTML report is a rendering of the JSON one, so it is written from the same data and never
  // becomes a second source of truth. Enabled unless the configuration turns it off.
  let htmlReportPath: string | undefined;
  if (config.htmlReport !== false) {
    const generatedAt = new Date().toISOString();
    htmlReportPath = join(reportDirectory, `${runHash}.html`);
    // Two variants of the same report: the hash-named file is an immutable archive and must not
    // claim to be the latest run (its nav says "This run (archived)" and links to the alias),
    // while latest.html is the report nav's stable "Latest run" target, refreshed after every
    // HTML-enabled run. The page's own subtitle carries the executor identity, so "latest" is
    // never ambiguous across executors.
    writeFileSync(
      htmlReportPath,
      renderHtmlReport(report, { generatedAt, reportPath, variant: "archive" }),
    );
    writeLatestReportAlias(
      reportDirectory,
      renderHtmlReport(report, { generatedAt, reportPath, variant: "latest" }),
    );
  }
  return {
    failures,
    ...(htmlReportPath === undefined ? {} : { htmlReportPath }),
    inconclusives,
    instructionFindings,
    interferences,
    noops,
    report,
    reportPath,
  };
}

// Replaces the stable latest.html alias atomically: content goes to a sibling temp file first and
// is renamed over the alias, so an interruption or a concurrent reader never sees a partial page.
// Exported for filesystem-level tests.
export function writeLatestReportAlias(reportDirectory: string, html: string): string {
  const latestPath = join(reportDirectory, "latest.html");
  const stagingPath = `${latestPath}.tmp-${process.pid}`;
  writeFileSync(stagingPath, html);
  renameSync(stagingPath, latestPath);
  return latestPath;
}

export function instructionAction(verdict: Verdict | "n/a"): InstructionAction {
  switch (verdict) {
    case "load-bearing":
      return "keep";
    case "interference":
      return "review";
    case "prune":
    case "redundant":
      return "delete";
    default:
      return "investigate";
  }
}

export function createNaInstructionFinding(
  evalCase: EvalCase,
  executorName: string,
): InstructionFinding {
  const naReason = `rule is not in a file ${executorName} reads ambiently`;
  return {
    action: instructionAction("n/a"),
    arms: [],
    caseId: evalCase.id,
    file: "",
    naReason,
    rule: evalCase.rule,
    span: evalCase.rule_text ?? "",
    verdict: "n/a",
  };
}

export function routeRunTargets(arguments_: readonly string[]): {
  readonly requestedInstructions: readonly string[];
  readonly requestedSkills: readonly string[];
} {
  return {
    requestedInstructions: arguments_.filter((argument) => argument.includes(":")),
    requestedSkills: arguments_.filter((argument) => !argument.includes(":")),
  };
}

function selectInstructions(
  instructions: readonly DiscoveredInstruction[],
  requestedIds: readonly string[],
): readonly ReadyDiscoveredInstruction[] {
  const byId = new Map(instructions.map((instruction) => [instruction.id, instruction]));
  if (requestedIds.length === 0) {
    return instructions.filter(
      (instruction): instruction is ReadyDiscoveredInstruction => instruction.status === "ready",
    );
  }
  return requestedIds.map((id) => {
    const instruction = byId.get(id);
    if (instruction === undefined) {
      throw new Error(`instruction target "${id}" not found under configured projects`);
    }
    if (instruction.status === "missing") {
      throw new Error(`instruction target "${id}" has no skillval.yml`);
    }
    if (instruction.status === "invalid") {
      throw new Error(instruction.validationError);
    }
    return instruction;
  });
}

function readInstructionFiles(
  target: ReadyDiscoveredInstruction,
): readonly InstructionFileContent[] {
  return target.files.map((file) => ({
    content: readFileSync(join(target.directory, file), "utf8"),
    file,
  }));
}

function instructionFilesHash(files: readonly InstructionFileContent[]): string {
  return sha256(
    [...files]
      .sort((left, right) => left.file.localeCompare(right.file))
      .map(({ content, file }) => `${file}\0${content.length}\0${content}`)
      .join("\0"),
  );
}

// Predicts what a real run would spend against the current cache without spawning a single trial, so
// a large audit is never a blind spend. It resolves the same skills, loadout, executor identity, and
// fixtures a run would, then does cache lookups only - reusing armsForCase and armCacheIdentity so
// the prediction and the run key on identical inputs. Execution gates (shell, unsandboxed pi) are not
// applied: a dry run runs nothing, so it can preview cost even for a suite a real run would refuse.
export function planEvaluation(
  config: SkillvalConfig,
  options: RunOptions,
  log: (message: string) => void,
): RunPlan {
  const rootDiscovery = discoverSkills(config.roots, config.exclude ?? []);
  const projectDiscovery = discoverProjects(config.projects ?? [], config.exclude ?? []);
  const discovery: DiscoveryResult = {
    missingRoots: [...rootDiscovery.missingRoots, ...projectDiscovery.missingRoots],
    skills: [...rootDiscovery.skills, ...projectDiscovery.skills],
  };
  const allTargetsRequested =
    options.requestedInstructions.length === 0 && options.requestedSkills.length === 0;
  const selectedSkills =
    allTargetsRequested || options.requestedSkills.length > 0
      ? selectSkills(discovery, options.requestedSkills)
      : [];
  const selectedInstructions =
    allTargetsRequested || options.requestedInstructions.length > 0
      ? selectInstructions(projectDiscovery.instructions, options.requestedInstructions)
      : [];
  const loadout = resolveRunLoadout(config, options.loadout, discovery, log);
  const executor = createExecutor(config.executor, {
    effort: options.effort,
    model: options.model,
  });
  const cache = new ArmCache(resolveStateDirectory());
  const skillInputs = selectedSkills.map((skill) => ({
    contentHash: skillContentHash(skill.skillDirectory),
    skill,
  }));
  const skillPlan = computePlan(skillInputs, loadout, executor.metadata, cache, options);
  const instructionPlan = computeInstructionPlan(
    selectedInstructions.map((target) => ({ files: readInstructionFiles(target), target })),
    executor.metadata,
    cache,
    options,
  );
  return {
    armsCached: skillPlan.armsCached + instructionPlan.armsCached,
    armsReused: skillPlan.armsReused,
    armsToRun: skillPlan.armsToRun + instructionPlan.armsToRun,
    executor: executor.metadata,
    instructions: instructionPlan.instructions,
    skills: skillPlan.skills,
    trialsMax: skillPlan.trialsMax + instructionPlan.trialsMax,
    trialsMin: skillPlan.trialsMin + instructionPlan.trialsMin,
  };
}

// The instruction half of a dry run. Mirrors computePlan: it derives each arm's cache identity the
// same way runInstructionArm does, so predicted and actual spend can never drift.
export function computeInstructionPlan(
  inputs: readonly {
    readonly files: readonly InstructionFileContent[];
    readonly target: ReadyDiscoveredInstruction;
  }[],
  metadata: ExecutorMetadata,
  cache: ArmCache,
  options: Pick<RunOptions, "caseFilter" | "useCache">,
): {
  readonly armsCached: number;
  readonly armsToRun: number;
  readonly instructions: readonly InstructionTargetPlan[];
  readonly trialsMax: number;
  readonly trialsMin: number;
} {
  let armsCached = 0;
  let armsToRun = 0;
  let trialsMin = 0;
  let trialsMax = 0;
  const instructions: InstructionTargetPlan[] = [];
  const scheduledKeys = new Set<string>();

  for (const { files, target } of inputs) {
    const cases: InstructionCasePlan[] = [];
    for (const evalCase of target.evals.cases) {
      if (options.caseFilter !== undefined && evalCase.id !== options.caseFilter) continue;
      const span = evalCase.rule_text ?? "";
      const home = resolveRuleFile(metadata.name, files, span);
      const source = files.find((entry) => entry.file === home);
      if (home === undefined || source === undefined) {
        cases.push({ arms: [], id: evalCase.id, na: true });
        continue;
      }
      let variants: AblationVariants;
      try {
        variants = ablateRule(source.content, span);
      } catch {
        // A stale or ambiguous span spends nothing; the real run reports it as a failed finding.
        cases.push({ arms: [], id: evalCase.id, na: true });
        continue;
      }
      const fixture = resolveFixture(
        selectFixture(evalCase.fixture, target.evals.fixture),
        target.directory,
      );
      const configured = clampedTrialCount(evalCase.trials);
      const maxPerArm = configured === 1 ? 1 : 5;
      const armPlans: ArmPlan[] = [];
      for (const arm of INSTRUCTION_ARMS) {
        const identity = {
          arm,
          evalCase,
          executor: metadata,
          fixtureHash: fixture?.hash,
          instructionHash: sha256(armInstructionContent(arm, variants)),
          loadoutHash: loadoutHash([]),
        };
        const key = cache.keyFor(identity);
        const cached =
          options.useCache && (scheduledKeys.has(key) || cache.lookup(identity) !== undefined);
        if (options.useCache) scheduledKeys.add(key);
        if (cached) {
          armsCached += 1;
          armPlans.push({ arm, cached: true, reused: false, trialsMax: 0, trialsMin: 0 });
          continue;
        }
        armsToRun += 1;
        trialsMin += configured;
        trialsMax += maxPerArm;
        armPlans.push({
          arm,
          cached: false,
          reused: false,
          trialsMax: maxPerArm,
          trialsMin: configured,
        });
      }
      cases.push({ arms: armPlans, id: evalCase.id, na: false });
    }
    instructions.push({ cases, id: target.id });
  }

  return { armsCached, armsToRun, instructions, trialsMax, trialsMin };
}

// The pure core of a dry run: given already-resolved skills, loadout, executor identity, and cache,
// count the trials each arm would run without spawning anything. Split out so it is testable with a
// temp-dir cache and fake skills, never a live executor. Fixture-free cases touch no disk here.
export function computePlan(
  skillInputs: readonly { readonly contentHash: string; readonly skill: ReadyDiscoveredSkill }[],
  loadout: RunLoadout | undefined,
  metadata: ExecutorMetadata,
  cache: ArmCache,
  options: Pick<RunOptions, "caseFilter" | "skipBaseline" | "useCache">,
): RunPlan {
  const groupMode = loadout !== undefined;
  let armsCached = 0;
  let armsReused = 0;
  let armsToRun = 0;
  let trialsMin = 0;
  let trialsMax = 0;
  const skills: SkillPlan[] = [];
  // The runner stores each arm's result the moment it completes, so a later arm with an identical
  // cache key reuses it within the same run. Track the keys this plan has already accounted for (in
  // the same skill/case/arm order the runner walks) so a repeat is predicted as a cache hit, not a
  // second run - matching what a real run spends. Only meaningful when the cache is in use. The
  // prediction assumes arms grade normally: an arm whose every trial hits an infrastructure failure
  // is never cached, so a real run would re-run its same-key repeats. A dry run cannot foresee a
  // transient runaway, so it prices the normal path rather than model a conditional state.
  const scheduledKeys = new Set<string>();

  for (const { contentHash, skill } of skillInputs) {
    // Mirrors runCase: a group arm is reused from solo when the target has no peers in the loadout.
    const hasPeers = loadout?.members.some((member) => member.name !== skill.name) ?? false;
    const target: SeededMember = {
      contentHash,
      directory: skill.skillDirectory,
      name: skill.name,
    };
    const cases: CasePlan[] = [];
    for (const evalCase of skill.evals.cases) {
      if (options.caseFilter !== undefined && evalCase.id !== options.caseFilter) continue;
      const fixture = resolveFixture(
        selectFixture(evalCase.fixture, skill.evals.fixture),
        skill.skillDirectory,
      );
      const configured = clampedTrialCount(evalCase.trials);
      // A single trial can never disagree, so it never escalates; any larger count may reach 5.
      const maxPerArm = configured === 1 ? 1 : 5;
      const armPlans: ArmPlan[] = [];
      for (const arm of armsForCase(evalCase, groupMode, options.skipBaseline)) {
        if (arm === "group" && !hasPeers) {
          armsReused += 1;
          armPlans.push({ arm, cached: false, reused: true, trialsMax: 0, trialsMin: 0 });
          continue;
        }
        const seeded = seededSkillsForArm(arm, target, loadout?.members ?? []);
        const identity = armCacheIdentity(
          arm,
          evalCase,
          metadata,
          fixture?.hash,
          target.name,
          seeded,
        );
        const key = cache.keyFor(identity);
        // A cache hit at runtime is either an entry already on disk, or one an earlier arm in this
        // same run will have stored under the same key by the time this arm runs.
        const cached =
          options.useCache && (scheduledKeys.has(key) || cache.lookup(identity) !== undefined);
        if (options.useCache) scheduledKeys.add(key);
        if (cached) {
          armsCached += 1;
          armPlans.push({ arm, cached: true, reused: false, trialsMax: 0, trialsMin: 0 });
          continue;
        }
        armsToRun += 1;
        trialsMin += configured;
        trialsMax += maxPerArm;
        armPlans.push({
          arm,
          cached: false,
          reused: false,
          trialsMax: maxPerArm,
          trialsMin: configured,
        });
      }
      cases.push({ arms: armPlans, id: evalCase.id });
    }
    skills.push({ cases, name: skill.name });
  }

  return {
    armsCached,
    armsReused,
    armsToRun,
    executor: metadata,
    instructions: [],
    skills,
    trialsMax,
    trialsMin,
  };
}

// Resolves the requested loadout to its members and their content hashes, once for the whole run.
function resolveRunLoadout(
  config: SkillvalConfig,
  name: string | undefined,
  discovery: ReturnType<typeof discoverSkills>,
  log: (message: string) => void,
): RunLoadout | undefined {
  if (name === undefined) return undefined;
  const resolved = resolveLoadout(config, name, discovery);
  for (const warning of resolved.warnings) log(`warning: ${warning}`);
  return {
    members: resolved.members.map((member) => ({
      ...member,
      contentHash: skillContentHash(member.directory),
    })),
    name: resolved.name,
  };
}

// Case-authored shell runs from two surfaces - fixture `setup` commands and the `command_exit`
// grader - both executed with `shell: true` on the grading machine, at the trust level of the case
// file. Off by default, a run refuses any selected case that carries either, so evaluating an
// untrusted third-party skill never runs arbitrary shell unacknowledged. --allow-shell opts in. The
// refusal fires before any trial spawns and names the skill, case, and surface. Loadout members are
// only seeded (their cases never run), so only the selected target skills' cases are scanned.
export function assertShellAllowed(
  skills: readonly ReadyDiscoveredSkill[],
  caseFilter: string | undefined,
  allow: boolean,
  instructions: readonly ReadyDiscoveredInstruction[] = [],
): void {
  if (allow) return;
  // An instruction target's skillval.yml carries the same executable fields as any other case file,
  // so it is gated identically - the instruction file itself is inert, its case file is not.
  for (const instruction of instructions) {
    for (const evalCase of instruction.evals.cases) {
      if (caseFilter !== undefined && evalCase.id !== caseFilter) continue;
      const fixture = selectFixture(evalCase.fixture, instruction.evals.fixture);
      if (fixture?.setup !== undefined && fixture.setup.length > 0) {
        throw new Error(
          `case "${evalCase.id}" (instruction target "${instruction.id}") runs case-authored ` +
            "fixture setup shell. Re-run with --allow-shell to permit it.",
        );
      }
      if (evalCase.assert?.command_exit !== undefined) {
        throw new Error(
          `case "${evalCase.id}" (instruction target "${instruction.id}") runs the case-authored ` +
            "command_exit grader. Re-run with --allow-shell to permit it.",
        );
      }
    }
  }
  for (const skill of skills) {
    for (const evalCase of skill.evals.cases) {
      if (caseFilter !== undefined && evalCase.id !== caseFilter) continue;
      // The effective fixture is the case's own, or the suite default it inherits; a case fixture
      // replaces the suite one entirely, so check exactly what this case would run.
      const fixture = selectFixture(evalCase.fixture, skill.evals.fixture);
      if (fixture?.setup !== undefined && fixture.setup.length > 0) {
        throw new Error(
          `case "${evalCase.id}" (skill "${skill.name}") has fixture setup commands, which run ` +
            "arbitrary shell on the grading machine. Re-run with --allow-shell to permit " +
            "case-authored shell, or remove the setup commands.",
        );
      }
      if (evalCase.assert?.command_exit !== undefined) {
        throw new Error(
          `case "${evalCase.id}" (skill "${skill.name}") uses the command_exit grader, which runs ` +
            "arbitrary shell on the grading machine. Re-run with --allow-shell to permit " +
            "case-authored shell, or remove the command_exit grader.",
        );
      }
    }
  }
}

// pi has no OS sandbox, so generation trials run agent writes with no enforced isolation. Refuse
// them unless the run explicitly acknowledges the gap, failing before any trial spawns.
export function assertPiGenerationAcknowledged(
  executorName: string,
  skills: readonly ReadyDiscoveredSkill[],
  caseFilter: string | undefined,
  allow: boolean,
  instructions: readonly ReadyDiscoveredInstruction[] = [],
): void {
  if (executorName !== "pi" || allow) return;
  for (const instruction of instructions) {
    for (const evalCase of instruction.evals.cases) {
      if (caseFilter !== undefined && evalCase.id !== caseFilter) continue;
      if (evalCase.mode === "generation") {
        throw new Error(
          `pi has no OS sandbox, so generation case "${evalCase.id}" (instruction target ` +
            `"${instruction.id}") would run agent writes without enforced isolation. Re-run with ` +
            "--allow-unsandboxed-pi to acknowledge, or use codex or claude for generation cases.",
        );
      }
    }
  }
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
    assert.ast !== undefined ||
    assert.json_schema !== undefined ||
    assert.command_exit !== undefined
  );
}

// Which arms a case runs. Group mode runs the three loadout arms for every case, ignoring the case's
// declared arms; the verdict needs all three. Solo mode keeps the case's arms (default solo; baseline
// when opted in). Shared by runCase and planEvaluation so the plan mirrors the real run exactly.
export function armsForCase(
  evalCase: EvalCase,
  groupMode: boolean,
  skipBaseline: boolean,
): readonly RuntimeArm[] {
  return groupMode
    ? ["solo", "group", "peers"]
    : (evalCase.arms ?? ["solo"]).filter((arm) => arm === "solo" || !skipBaseline);
}

function runCase(
  context: CaseContext,
  evalCase: EvalCase,
  log: (message: string) => void,
): CaseResult {
  const groupMode = context.loadout !== undefined;
  const arms = armsForCase(evalCase, groupMode, context.skipBaseline);
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
        log(`  ${evalCase.id} [group] ${armStateLabel(solo)} (same as solo; no peers)`);
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
    log(`  ${evalCase.id} [${arm}] ${armStateLabel(result)}${result.cached ? " (cached)" : ""}`);
    results.push(result);
  }
  // A missing arm reads as "fail": it contributes no pass, and only arms that ran can be infra.
  const stateOf = (arm: RuntimeArm): ArmState => {
    const result = results.find((candidate) => candidate.arm === arm);
    return result === undefined ? "fail" : armState(result);
  };

  if (groupMode && context.loadout !== undefined) {
    // pass/noop follow the same "with target vs without target" shape as solo mode: the group arm
    // is the with-target comparison, peers is the without-target control. The peers comparison only
    // means something when the case grades behavior on it (not a pure trigger-only case, whose
    // target-specific check is skipped when the target is absent), so gate the no-op on that too.
    const peersMeaningful = hasPeerGradedAssertion(evalCase);
    const verdict = groupVerdict(
      stateOf("solo"),
      stateOf("group"),
      stateOf("peers"),
      peersMeaningful,
    );
    log(`  ${evalCase.id} verdict: ${VERDICT_TEXT[verdict]}`);
    return {
      arms: results,
      id: evalCase.id,
      loadout: { name: context.loadout.name, verdict },
      rule: evalCase.rule,
      ...caseOutcome(stateOf("group"), stateOf("peers"), peersMeaningful),
    };
  }
  return {
    arms: results,
    id: evalCase.id,
    rule: evalCase.rule,
    ...caseOutcome(stateOf("solo"), stateOf("baseline"), true),
  };
}

// The case-level outcome shared by solo and group mode. The deciding arm carries the with-target
// result (solo arm in solo mode, group arm in group mode); the control arm is the without-target
// comparison (baseline, or peers when the case grades behavior on peers). An ungraded deciding arm
// makes the case inconclusive - neither a pass nor a content failure - and disqualifies any no-op
// claim: a passing control beside an ungraded deciding arm proves nothing about the target and must
// not surface a prune candidate. An ungraded control simply cannot claim a no-op (it did not pass).
export function caseOutcome(
  deciding: ArmState,
  control: ArmState,
  controlMeaningful: boolean,
): { readonly inconclusive: boolean; readonly noop: boolean; readonly pass: boolean } {
  return {
    inconclusive: deciding === "infra",
    noop: deciding !== "infra" && controlMeaningful && control === "pass",
    pass: deciding === "pass",
  };
}

// One arm's outcome for run logs: infra is called out as ungraded, never conflated with FAIL.
function armStateLabel(result: ArmResult): string {
  const state = armState(result);
  if (state === "infra") return "infra (not graded)";
  return state === "pass" ? "pass" : "FAIL";
}

// The cache identity for one arm. Shared by runArm and planEvaluation so the trials a dry run
// predicts and the trials a real run spends key on exactly the same thing - they can never drift.
export function armCacheIdentity(
  arm: RuntimeArm,
  evalCase: EvalCase,
  metadata: ExecutorMetadata,
  fixtureHash: string | undefined,
  targetName: string,
  seeded: readonly SeededMember[],
): ArmCacheIdentity {
  // Target-present arms grade the target-specific trigger check, so key them on the target as well:
  // a target that is already in the loadout produces the same seeded set (and loadoutHash) as any
  // other loadout member's group arm, but its trigger result differs.
  const targetPresent = arm === "solo" || arm === "group";
  return {
    arm,
    evalCase,
    executor: metadata,
    fixtureHash,
    loadoutHash: loadoutHash(
      seeded.map((member) => ({ contentHash: member.contentHash, name: member.name })),
    ),
    triggerTarget: targetPresent ? targetName : undefined,
  };
}

function runInstructionCase(
  context: InstructionCaseContext,
  evalCase: EvalCase,
  log: (message: string) => void,
): InstructionFinding {
  const span = evalCase.rule_text ?? "";
  const home = resolveRuleFile(context.executor.metadata.name, context.files, span);
  if (home === undefined) {
    const finding = createNaInstructionFinding(evalCase, context.executor.metadata.name);
    log(`  ${evalCase.id} n/a (${finding.naReason})`);
    return finding;
  }

  const source = context.files.find((entry) => entry.file === home);
  if (source === undefined) {
    throw new Error(`instruction target "${context.target.id}" is missing resolved file ${home}`);
  }

  let variants: ReturnType<typeof ablateRule>;
  try {
    variants = ablateRule(source.content, span);
  } catch (error) {
    if (!(error instanceof AblationError)) throw error;
    log(`  ${evalCase.id} [${home}] FAIL (${error.message})`);
    const finding = failedInstructionFinding(evalCase, home, error);
    log(`  ${evalCase.id} [${home}] ${INSTRUCTION_VERDICT_TEXT.inconclusive} -> ${finding.action}`);
    return finding;
  }

  const fixture = resolveFixture(
    selectFixture(evalCase.fixture, context.target.evals.fixture),
    context.target.directory,
  );
  const arms = INSTRUCTION_ARMS.map((arm) => {
    log(`  ${evalCase.id} [${arm}] ...`);
    const result = runInstructionArm(
      {
        cache: context.cache,
        content: armInstructionContent(arm, variants),
        evalCase,
        executor: context.executor,
        filename: home,
        fixture,
        targetId: context.target.id,
        useCache: context.useCache,
      },
      arm,
    );
    log(`  ${evalCase.id} [${arm}] ${armStateLabel(result)}${result.cached ? " (cached)" : ""}`);
    return result;
  });
  const stateOf = (arm: RuntimeArm): ArmState => {
    const result = arms.find((candidate) => candidate.arm === arm);
    return result === undefined ? "fail" : armState(result);
  };
  const peersMeaningful = hasPeerGradedAssertion(evalCase);
  const verdict = groupVerdict(
    stateOf("solo"),
    stateOf("group"),
    stateOf("peers"),
    peersMeaningful,
  );
  const finding: InstructionFinding = {
    action: instructionAction(verdict),
    arms,
    caseId: evalCase.id,
    file: home,
    rule: evalCase.rule,
    span,
    verdict,
  };
  log(`  ${evalCase.id} [${home}] ${INSTRUCTION_VERDICT_TEXT[verdict]} -> ${finding.action}`);
  return finding;
}

function failedInstructionFinding(
  evalCase: EvalCase,
  file: string,
  error: AblationError,
): InstructionFinding {
  return {
    action: instructionAction("inconclusive"),
    arms: [
      {
        arm: "group",
        cached: false,
        pass: false,
        trials: [
          {
            checks: [{ detail: error.message, name: "ablation", pass: false }],
            pass: false,
            usage: undefined,
          },
        ],
      },
    ],
    caseId: evalCase.id,
    file,
    rule: evalCase.rule,
    span: evalCase.rule_text ?? "",
    verdict: "inconclusive",
  };
}

function instructionGroupPassed(finding: InstructionFinding): boolean {
  return finding.arms.find((arm) => arm.arm === "group")?.pass === true;
}

// The finding's whole-file arm was never graded (all trials were infrastructure failures), so the
// finding carries no content result: not a failure, and disqualified from any no-op claim.
function instructionGroupUngraded(finding: InstructionFinding): boolean {
  return finding.arms.find((arm) => arm.arm === "group")?.infrastructure === true;
}

function instructionFindingIsNoop(finding: InstructionFinding, evalCase: EvalCase): boolean {
  return (
    !instructionGroupUngraded(finding) &&
    hasPeerGradedAssertion(evalCase) &&
    finding.arms.find((arm) => arm.arm === "peers")?.pass === true
  );
}

function runInstructionArm(context: InstructionArmContext, arm: RuntimeArm): ArmResult {
  const identity = {
    arm,
    evalCase: context.evalCase,
    executor: context.executor.metadata,
    fixtureHash: context.fixture?.hash,
    instructionHash: sha256(context.content),
    loadoutHash: loadoutHash([]),
  };
  if (context.useCache) {
    const hit = context.cache.lookup(identity);
    if (hit !== undefined) return hit;
  }

  const trials = collectArmTrials(clampedTrialCount(context.evalCase.trials), () =>
    runInstructionTrial(context, arm),
  );
  const { cache, result } = finalizeArm(arm, trials);
  if (cache) context.cache.store(identity, result);
  return result;
}

// Translates a thrown trial error into a failed TrialResult, keeping capture-layer infrastructure
// failures (fixture setup, output overflow, timeout) under their own check names so the report never
// reads them as a graded skill result. Shared by the skill and instruction trial paths.
function trialErrorResult(error: unknown): TrialResult {
  if (error instanceof FixtureSetupError) {
    // Workspace staging failed before the agent ran; this is infrastructure, not grading.
    return {
      checks: [{ detail: error.message, name: "fixture-setup", pass: false }],
      fixtureSetup: error.results,
      pass: false,
      usage: undefined,
    };
  }
  if (error instanceof ExecutorInfraError) {
    // The agent produced no usable trace (output too large to buffer, or a timeout). Flagged so the
    // arm excludes it from the vote and does not cache a runaway as though it were a graded result.
    return {
      checks: [{ detail: error.message, name: "infrastructure", pass: false }],
      infrastructure: true,
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
}

// Runs an arm's configured trials, escalating to at most five when the graded trials disagree.
// Infrastructure trials (capture-layer failures) never count toward agreement and cannot force
// escalation, but do count toward the five-trial ceiling so a persistent failure cannot loop.
export function collectArmTrials(wanted: number, runOne: () => TrialResult): TrialResult[] {
  const trials: TrialResult[] = [];
  for (let index = 0; index < wanted; index += 1) trials.push(runOne());
  const graded = (): TrialResult[] => trials.filter((trial) => trial.infrastructure !== true);
  while (trials.length < 5 && shouldEscalate(graded())) trials.push(runOne());
  return trials;
}

// Builds an arm result, voting only on graded trials. An arm whose every trial was an infrastructure
// failure could not be graded: its pass is not a real signal, so the caller must not cache it (the
// failure is transient and a re-run may capture a usable trace). Returns whether it is safe to cache.
export function finalizeArm(
  arm: RuntimeArm,
  trials: readonly TrialResult[],
): { cache: boolean; result: ArmResult } {
  const graded = trials.filter((trial) => trial.infrastructure !== true);
  if (graded.length === 0) {
    return {
      cache: false,
      result: { arm, cached: false, infrastructure: true, pass: false, trials },
    };
  }
  return { cache: true, result: { arm, cached: false, pass: hasMajority(graded), trials } };
}

function runInstructionTrial(context: InstructionArmContext, arm: RuntimeArm): TrialResult {
  const workspace = mkdtempSync(join(tmpdir(), `skillval-${context.evalCase.id}-`));
  const trialHome = mkdtempSync(join(tmpdir(), "skillval-home-"));

  try {
    const fixtureSetup =
      context.fixture === undefined
        ? undefined
        : applyFixture(context.fixture, workspace, trialHome);
    const { trace } = context.executor.runTrial({
      arm,
      evalCase: context.evalCase,
      home: trialHome,
      seededInstruction: { content: context.content, filename: context.filename },
      seededSkills: [],
      skillName: context.targetId,
      workspace,
    });
    // No skills are seeded on an instruction arm, so nothing staged needs excluding.
    const checks = gradeTrial(context.evalCase, arm, trace, workspace, []);
    return {
      checks,
      fixtureSetup,
      pass: checks.every((check) => check.pass),
      usage: trace.usage,
    };
  } catch (error) {
    return trialErrorResult(error);
  } finally {
    // Best-effort, exactly as for skill trials: cleanup failure must not replace a completed result
    // or abort the run.
    discard(workspace);
    discard(trialHome);
  }
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
  const identity = armCacheIdentity(
    arm,
    context.evalCase,
    context.executor.metadata,
    context.fixture?.hash,
    target.name,
    seeded,
  );
  if (context.useCache) {
    const hit = context.cache.lookup(identity);
    if (hit !== undefined) return hit;
  }

  const trials = collectArmTrials(clampedTrialCount(context.evalCase.trials), () =>
    runTrial(context, arm, seeded),
  );
  const { cache, result } = finalizeArm(arm, trials);
  if (cache) context.cache.store(identity, result);
  return result;
}

/**
 * Prepares the tree the graders see: a faithful copy of the trial workspace with the skill files
 * staging put there removed.
 *
 * The ordering is the whole point. Deleting staged files out of the LIVE workspace could not be
 * made safe - it had to identify them by pathname in a tree the model can rewrite, so a symlink
 * swapped in for a staged directory defeated any leaf-level check. Deleting them from a copy the
 * harness alone holds is safe, because nothing can race a tree nobody else has.
 *
 * So the copy is FAITHFUL first: symlinks are preserved as symlinks rather than followed or
 * dropped, empty directories survive, and modes come with it. An earlier version built the copy
 * selectively and was lossy in exactly the ways that manufacture false failures - a model's own
 * `mkdir -p dist/cache` vanished, and a fixture-created link that `test -L` was meant to observe
 * disappeared, while fixture.ts actively tells authors to create such links.
 *
 * Grading then happens at the ORIGINAL pathname: the live tree is moved aside and the prepared copy
 * takes its place. Generated files routinely embed absolute paths, and grading under a different
 * prefix would both break those and leave the untouched original reachable.
 */
/**
 * Removes symlinks whose target lies outside the graded tree, keeping the ones inside it.
 *
 * Both halves matter. Dropping every symlink was lossy: fixture.ts tells authors to create links in
 * setup, so a `test -L current` case could never pass. Keeping every symlink would hand a
 * command_exit grader - which runs arbitrary shell - a path out of the tree, including back into
 * the model's own live workspace.
 */
/**
 * Resolves a path through whichever of its ancestors actually exist.
 *
 * `realpathSync` throws on a path whose leaf is missing, and a link target need not exist. Walking
 * up to the deepest existing ancestor gives the canonical prefix while keeping the rest verbatim.
 */
function canonicalize(path: string): string {
  let existing = path;
  const trailing: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return path;
    trailing.unshift(basename(existing));
    existing = parent;
  }
  return join(realpathSync(existing), ...trailing);
}

/**
 * Where a link text really lands, following each component in order.
 *
 * `resolve()` and `join()` collapse `..` LEXICALLY, before any earlier component is followed. With
 * `pivot -> .` and `escape -> pivot/..`, that collapse cancels `pivot` against `..` and reports the
 * link as pointing at its own directory. The kernel does the opposite: it follows `pivot` to the
 * directory it names, and only then applies `..` - so the link reaches the PARENT, which is where
 * the model's live tree is parked. Canonicalizing before each step is what makes the two agree.
 */
function resolveThroughLinks(base: string, text: string): string {
  let walked = isAbsolute(text) ? parse(text).root : base;
  for (const part of text.split(sep)) {
    if (part === "" || part === ".") continue;
    walked = canonicalize(walked);
    walked = part === ".." ? dirname(walked) : join(walked, part);
  }
  return canonicalize(walked);
}

/**
 * Restores hard-link identity that `cpSync` does not preserve.
 *
 * Two names for one inode arrive in the copy as two independent files, so `test a -ef b` answers
 * differently in the graded tree than in the model's own - and the inverted case is worse than a
 * spurious failure: a baseline arm asserting `! test a -ef b` PASSES against the split copy and
 * turns a working rule into a prune candidate. Rebuilding the links keeps the copy faithful.
 */
function preserveHardLinks(source: string, root: string): void {
  const firstByInode = new Map<string, string>();
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const stats = lstatSync(path, { throwIfNoEntry: false });
      if (stats === undefined || stats.nlink < 2) continue;
      const key = `${stats.dev}:${stats.ino}`;
      const inCopy = join(root, relative(source, path));
      const first = firstByInode.get(key);
      if (first === undefined) {
        firstByInode.set(key, inCopy);
        continue;
      }
      if (!existsSync(inCopy) || !existsSync(first)) continue;
      rmSync(inCopy, { force: true });
      linkSync(first, inCopy);
    }
  };
  walk(source);
}

function dropEscapingLinks(
  directory: string,
  root: string,
  workspace: string,
  finalPath: string,
): void {
  // Compared against REAL paths. On macOS /tmp is itself a symlink to /private/tmp, so an absolute
  // link written by the model resolves to the /private form while the workspace path does not -
  // and a naive comparison classifies the model's own output as an escape and deletes it.
  const realRoot = realpathSync(root);
  const realWorkspace = existsSync(workspace) ? realpathSync(workspace) : workspace;
  // Both spellings, because a link target is whatever the model literally wrote. On macOS the
  // workspace lives under /tmp, which is itself a link to /private/tmp: realpath gives the private
  // form while the model's own `ln -s "$PWD/x"` gives the public one. Comparing a lexical target
  // against a canonical prefix alone classifies the model's own output as an escape and deletes it.
  const roots = [realRoot, root];
  const workspaces = [realWorkspace, workspace];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const text = readlinkSync(path);
      // Judged on where it really lands rather than on how it was spelled.
      const target = resolveThroughLinks(directory, text);
      if (roots.some((base) => target === base || pathContains(base, target))) continue;
      // An ABSOLUTE link the model wrote inside the workspace points at the live tree, which the
      // copy is not. Repointing it at the equivalent path here keeps the link meaningful instead of
      // deleting output that was never trying to escape.
      // Already correct at the pathname this tree is graded at, so leave the text ALONE. Rewriting
      // it through the canonical target silently edits model output: `$PWD/alias/file` would become
      // `$PWD/real/file`, and a `readlink` grader comparing against what the model wrote fails on a
      // link that was working.
      if (isAbsolute(text) && (text === finalPath || pathContains(finalPath, text))) continue;
      const home = workspaces.find((base) => target === base || pathContains(base, target));
      if (home !== undefined) {
        // Repointed at the path this tree will OCCUPY once installed, not the temporary one it is
        // being built at - the temporary path stops existing the moment it is renamed into place,
        // which would leave every rewritten link dangling while graders run.
        rmSync(path, { force: true });
        symlinkSync(join(finalPath, relative(home, target)), path);
        continue;
      }
      rmSync(path, { force: true });
      continue;
    }
    if (entry.isDirectory()) dropEscapingLinks(path, root, workspace, finalPath);
  }
}

/**
 * Whether every component between `root` and `path` is a real directory rather than a symlink.
 *
 * Subtraction happens by pathname, and a pathname is only trustworthy if nothing along it can
 * redirect. Checking the leaf alone is what made every earlier version unsafe: a staged DIRECTORY
 * replaced by a link to somewhere holding identical bytes would have its target deleted instead.
 */
/**
 * Removes a path inside the graded copy even when its parent directory is not writable.
 *
 * Defensive rather than load-bearing. Two reviews called for this on the premise that the copy
 * preserves directory modes; measured, it does not - cpSync brings a 0555 directory back as 0755,
 * so the copy is always writable and this retry has no reachable trigger through it. Kept because
 * the cost is a caught EACCES and the failure it guards against is the skill's own text surviving
 * into the graded tree as model output. The mode is restored either way: a `test -w` case can see
 * it.
 *
 * KNOWN LIMIT, from the same measurement - directory modes are NOT faithful in the copy. A case
 * asserting a mode reads 0755 where the model's own tree had something else.
 */
function removeFromCopy(path: string): void {
  try {
    rmSync(path, { force: true, recursive: true });
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EACCES") throw error;
  }
  const parent = dirname(path);
  const mode = lstatSync(parent, { throwIfNoEntry: false })?.mode;
  if (mode === undefined) return;
  chmodSync(parent, mode | 0o200);
  try {
    rmSync(path, { force: true, recursive: true });
  } finally {
    chmodSync(parent, mode);
  }
}

function reachableWithoutLinks(root: string, path: string): boolean {
  const rest = relative(root, path);
  // Containment first: an empty relative (the path IS root), an absolute one, or anything leading
  // with `..` walked happily out of the tree.
  //
  // Defense in depth, and deliberately unaccompanied by a regression test. Every caller reaches
  // this through `join(root, relative(workspace, manifestPath))`, which lands an escaping manifest
  // entry back inside the harness's own temp directory rather than at the path it names - so an
  // attempt to build the exploit produced a test that passed with this guard REMOVED. A green test
  // asserting a property its subject does not have is worse than none. The guard stays because it
  // is one comparison and the remap is not a property this function should have to rely on.
  if (rest === "" || isAbsolute(rest) || rest === ".." || rest.startsWith(`..${sep}`)) return false;
  const parts = rest.split(sep).filter((part) => part !== "");
  let walked = root;
  for (const part of parts.slice(0, -1)) {
    walked = join(walked, part);
    if (lstatSync(walked, { throwIfNoEntry: false })?.isDirectory() !== true) return false;
  }
  return true;
}

export function prepareGradingTree(workspace: string, staged: readonly StagedSkill[]): string {
  const prepared = mkdtempSync(join(tmpdir(), "skillval-graded-"));
  const root = join(prepared, "tree");
  try {
    // dereference:false keeps symlinks as symlinks; without it a link would be replaced by a copy
    // of its target, which is both lossy and a way out of the workspace.
    cpSync(workspace, root, {
      dereference: false,
      preserveTimestamps: true,
      recursive: true,
      // Without this cpSync path-resolves relative link targets, so a relative link stops being
      // relative and starts pointing at the source tree.
      verbatimSymlinks: true,
    });
    for (const skill of staged) {
      for (const file of skill.created) {
        const inCopy = join(root, relative(workspace, file.path));
        // Every component checked with lstat, not just the leaf. A model can replace a staged
        // DIRECTORY with a link to another directory holding identical bytes; following it would
        // delete unrelated output, and the leaf-level check cannot see that.
        if (!reachableWithoutLinks(root, inCopy)) continue;
        // Only while the bytes still match what staging wrote. The moment the model edits a staged
        // file it is output, and output is graded.
        const stats = lstatSync(inCopy, { throwIfNoEntry: false });
        if (stats === undefined || !stats.isFile()) continue;
        if (sha256(readFileSync(inCopy)) !== file.hash) continue;
        removeFromCopy(inCopy);
      }
      // Only directories staging itself created, and only while empty - never every empty
      // directory, which would delete the model's own. Deepest first, by path depth rather than by
      // insertion order: a parent examined before its child is emptied looks non-empty and
      // survives, which is how the provider root outlived its own subdirectory.
      const deepestFirst = [...skill.directories].sort(
        (left, right) => right.split(sep).length - left.split(sep).length,
      );
      for (const directory of deepestFirst) {
        const inCopy = join(root, relative(workspace, directory));
        if (!reachableWithoutLinks(root, inCopy)) continue;
        const stats = lstatSync(inCopy, { throwIfNoEntry: false });
        if (stats?.isDirectory() !== true) continue;
        if (readdirSync(inCopy).length > 0) continue;
        removeFromCopy(inCopy);
      }
    }
    preserveHardLinks(workspace, root);
    dropEscapingLinks(root, root, workspace, workspace);
  } catch (error) {
    // Nothing about the skill has been graded when preparation fails, so it must not vote or be
    // cached - and the half-built copy must not leak.
    discard(prepared);
    throw new ExecutorInfraError(
      `preparing the graded workspace failed: ${error instanceof Error ? error.message : String(error)}`,
      "staging-failed",
    );
  }
  return prepared;
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
    const { staged, trace } = context.executor.runTrial({
      arm,
      evalCase: context.evalCase,
      home: trialHome,
      seededSkills: seeded.map((member) => ({ directory: member.directory, name: member.name })),
      skillName: context.skill.name,
      workspace,
    });
    // Remove what seeding staged BEFORE grading. A staged skill is copied into the workspace, so
    // Graded from a faithful copy with staged input removed, standing at the workspace's own path -
    // see prepareGradingTree.
    const prepared = prepareGradingTree(workspace, staged);
    // Parked inside the harness's OWN temp directory rather than at `${workspace}.live`. That
    // pathname sits in the model's parent directory, where the model can create something there
    // first - and then cleanup would recursively delete a path the harness never acquired.
    const parked = join(prepared, "live");
    // Tracked explicitly, because an unconditional cleanup here would delete the model's LIVE tree
    // whenever the first rename failed - it was never parked, so `workspace` still WAS the live
    // tree. Each flag says which path this code currently owns.
    let liveParked = false;
    let gradedInstalled = false;
    let checks: Check[];
    try {
      try {
        renameSync(workspace, parked);
        liveParked = true;
        renameSync(join(prepared, "tree"), workspace);
        gradedInstalled = true;
      } catch (error) {
        // Infrastructure, never content. Nothing has been graded at this point, so letting this
        // fall through as an ordinary trial error would make it VOTE and be CACHED: a solo arm
        // becomes a false FAIL, and a baseline failing this way stops disqualifying a no-op.
        // Either way a working rule gets deleted on evidence that was never collected.
        throw new ExecutorInfraError(
          `could not install the grading tree: ${error instanceof Error ? error.message : String(error)}`,
          "grading-tree",
        );
      }
      checks = gradeTrial(context.evalCase, arm, trace, workspace, []);
    } finally {
      if (gradedInstalled) discard(workspace);
      if (liveParked) {
        try {
          renameSync(parked, workspace);
        } catch {
          // Leave it parked; `prepared` is discarded next and takes it with it.
        }
      }
      discard(prepared);
    }
    return {
      checks,
      fixtureSetup,
      pass: checks.every((check) => check.pass),
      usage: trace.usage,
    };
  } catch (error) {
    return trialErrorResult(error);
  } finally {
    // Trials may contain generated source or credentials-related environment state. Always clean
    // both directories, including executor and grader failure paths.
    //
    // Best-effort on purpose. This runs in a `finally`, so a throw here would replace whatever the
    // trial actually concluded - a permission change or a filesystem race would surface as the
    // trial's result, and outside the catch above it could abort the whole run. Disposal of a temp
    // directory is never a statement about the skill.
    discard(workspace);
    discard(trialHome);
  }
}

// Removes a temporary directory, never letting its failure become a trial outcome.
function discard(directory: string): void {
  try {
    rmSync(directory, { force: true, recursive: true });
  } catch {
    // The OS reclaims it; a leaked temp directory is not worth failing a measured trial for.
  }
}
