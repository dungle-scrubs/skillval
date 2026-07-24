/** Orchestrates discovery, trial arms, voting, caching, cleanup, and report persistence. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import type { Executor, ExecutorMetadata } from "./executors/types.js";
import type { ResolvedFixture } from "./fixture.js";
import { applyFixture, FixtureSetupError, resolveFixture, selectFixture } from "./fixture.js";
import { gradeTrial } from "./grade.js";
import { renderHtmlReport } from "./html-report.js";
import type { InstructionFileContent } from "./instruction.js";
import { armInstructionContent, INSTRUCTION_ARMS, resolveRuleFile } from "./instruction.js";
import { resolveLoadout } from "./loadout.js";
import type { ArmResult, CaseResult, EvalCase, RuntimeArm, TrialResult } from "./types.js";
import { loadoutHash, sha256, skillContentHash } from "./utils.js";
import type { Verdict } from "./verdict.js";
import { groupVerdict, INSTRUCTION_VERDICT_TEXT, VERDICT_TEXT } from "./verdict.js";
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
  const rootDiscovery = discoverSkills(config.roots);
  const projectDiscovery = discoverProjects(config.projects ?? []);
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
  const runHash = sha256(
    `${targetsHash}\0EXECUTOR\0${executor.metadata.name}\0${executor.metadata.version}\0` +
      `${executor.metadata.model}\0${executor.metadata.thinking}`,
  );
  const instructionReports: Record<string, InstructionTargetReport> = {};
  const skillReports: Record<string, SkillReport> = {};
  let failures = 0;
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
    failures += cases.filter((result) => !result.pass).length;
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
    failures += applicable.filter((finding) => !instructionGroupPassed(finding)).length;
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
    htmlReportPath = join(reportDirectory, `${runHash}.html`);
    writeFileSync(
      htmlReportPath,
      renderHtmlReport(report, { generatedAt: new Date().toISOString(), reportPath }),
    );
  }
  return {
    failures,
    ...(htmlReportPath === undefined ? {} : { htmlReportPath }),
    instructionFindings,
    interferences,
    noops,
    report,
    reportPath,
  };
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
  const rootDiscovery = discoverSkills(config.roots);
  const projectDiscovery = discoverProjects(config.projects ?? []);
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
  // second run - matching what a real run spends. Only meaningful when the cache is in use.
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
    log(
      `  ${evalCase.id} [${arm}] ${result.pass ? "pass" : "FAIL"}${
        result.cached ? " (cached)" : ""
      }`,
    );
    return result;
  });
  const passOf = (arm: RuntimeArm): boolean =>
    arms.find((result) => result.arm === arm)?.pass === true;
  const peersMeaningful = hasPeerGradedAssertion(evalCase);
  const verdict = groupVerdict(passOf("solo"), passOf("group"), passOf("peers"), peersMeaningful);
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

function instructionFindingIsNoop(finding: InstructionFinding, evalCase: EvalCase): boolean {
  return (
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

  const trials: TrialResult[] = [];
  const wanted = clampedTrialCount(context.evalCase.trials);
  for (let index = 0; index < wanted; index += 1) {
    trials.push(runInstructionTrial(context, arm));
  }
  while (shouldEscalate(trials)) trials.push(runInstructionTrial(context, arm));

  const result: ArmResult = {
    arm,
    cached: false,
    pass: hasMajority(trials),
    trials,
  };
  context.cache.store(identity, result);
  return result;
}

function runInstructionTrial(context: InstructionArmContext, arm: RuntimeArm): TrialResult {
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
      seededInstruction: { content: context.content, filename: context.filename },
      seededSkills: [],
      skillName: context.targetId,
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
    rmSync(workspace, { force: true, recursive: true });
    rmSync(trialHome, { force: true, recursive: true });
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
