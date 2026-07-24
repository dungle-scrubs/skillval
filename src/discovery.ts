/** Discovers skills and carries validated case suites into evaluation without reparsing them. */
import { existsSync, readdirSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { readCaseFile } from "./case-file.js";
import type { SkillEvals } from "./types.js";

export type InstructionFile = "AGENTS.md" | "CLAUDE.md";

interface InstructionLocation {
  readonly directory: string;
  readonly files: readonly InstructionFile[];
  readonly id: string;
}

interface SkillLocation {
  readonly name: string;
  readonly root: string;
  readonly skillDirectory: string;
}

export interface MissingDiscoveredSkill extends SkillLocation {
  readonly caseCount: 0;
  readonly class: undefined;
  readonly hasSkillval: false;
  readonly status: "missing";
  readonly validationError: undefined;
}

export interface InvalidDiscoveredSkill extends SkillLocation {
  readonly caseCount: 0;
  readonly class: "invalid";
  readonly hasSkillval: true;
  readonly status: "invalid";
  readonly validationError: string;
}

export interface ReadyDiscoveredSkill extends SkillLocation {
  readonly caseCount: number;
  readonly class: "capability" | "preference";
  readonly evals: SkillEvals;
  readonly hasSkillval: true;
  readonly status: "ready";
  readonly validationError: undefined;
}

export type DiscoveredSkill =
  | InvalidDiscoveredSkill
  | MissingDiscoveredSkill
  | ReadyDiscoveredSkill;

export interface MissingDiscoveredInstruction extends InstructionLocation {
  readonly caseCount: 0;
  readonly class: undefined;
  readonly hasSkillval: false;
  readonly status: "missing";
  readonly validationError: undefined;
}

export interface InvalidDiscoveredInstruction extends InstructionLocation {
  readonly caseCount: 0;
  readonly class: "invalid";
  readonly hasSkillval: true;
  readonly status: "invalid";
  readonly validationError: string;
}

export interface ReadyDiscoveredInstruction extends InstructionLocation {
  readonly caseCount: number;
  readonly class: "capability" | "preference";
  readonly evals: SkillEvals;
  readonly hasSkillval: true;
  readonly status: "ready";
  readonly validationError: undefined;
}

export type DiscoveredInstruction =
  | InvalidDiscoveredInstruction
  | MissingDiscoveredInstruction
  | ReadyDiscoveredInstruction;

export interface DiscoveryResult {
  readonly missingRoots: readonly string[];
  readonly skills: readonly DiscoveredSkill[];
}

export interface ProjectDiscoveryResult {
  readonly instructions: readonly DiscoveredInstruction[];
  readonly missingRoots: readonly string[];
  readonly skills: readonly DiscoveredSkill[];
}

export interface DiscoveryReport {
  readonly missingRoots: readonly string[];
  readonly skills: readonly DiscoverySkillSummary[];
}

export interface ProjectDiscoveryReport {
  readonly instructions: readonly DiscoveryInstructionSummary[];
  readonly missingRoots: readonly string[];
  readonly skills: readonly DiscoverySkillSummary[];
}

export type DiscoveryInstructionSummary =
  | Omit<ReadyDiscoveredInstruction, "evals">
  | Exclude<DiscoveredInstruction, ReadyDiscoveredInstruction>;

export type DiscoverySkillSummary =
  | Omit<ReadyDiscoveredSkill, "evals">
  | Exclude<DiscoveredSkill, ReadyDiscoveredSkill>;

export function discoverSkills(roots: readonly string[]): DiscoveryResult {
  const missingRoots: string[] = [];
  const skills: DiscoveredSkill[] = [];

  for (const root of roots) {
    if (!existsSync(root)) {
      missingRoots.push(root);
      continue;
    }

    const entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const skillDirectory = join(root, entry.name);
      if (!existsSync(join(skillDirectory, "SKILL.md"))) continue;
      skills.push(describeSkill(entry.name, root, skillDirectory));
    }
  }

  return { missingRoots, skills };
}

export function discoverProjects(projects: readonly string[]): ProjectDiscoveryResult {
  const instructions: DiscoveredInstruction[] = [];
  const missingRoots: string[] = [];
  const skills: DiscoveredSkill[] = [];

  for (const project of projects) {
    if (!existsSync(project)) {
      missingRoots.push(project);
      continue;
    }

    walkProject(project, project, basename(project), instructions, skills);
  }

  instructions.sort((left, right) => left.id.localeCompare(right.id));
  skills.sort((left, right) => left.name.localeCompare(right.name));
  return { instructions, missingRoots, skills };
}

export function discoveryReport(discovery: DiscoveryResult): DiscoveryReport {
  return {
    missingRoots: discovery.missingRoots,
    skills: discovery.skills.map((skill) => {
      if (skill.status !== "ready") return skill;
      // Parsed prompts are execution input, not listing metadata. Keep list --json compact and
      // avoid exposing prompt contents when callers only asked what skills are available.
      return {
        caseCount: skill.caseCount,
        class: skill.class,
        hasSkillval: skill.hasSkillval,
        name: skill.name,
        root: skill.root,
        skillDirectory: skill.skillDirectory,
        status: skill.status,
        validationError: skill.validationError,
      };
    }),
  };
}

export function projectDiscoveryReport(discovery: ProjectDiscoveryResult): ProjectDiscoveryReport {
  return {
    instructions: discovery.instructions.map((instruction) => {
      if (instruction.status !== "ready") return instruction;
      return {
        caseCount: instruction.caseCount,
        class: instruction.class,
        directory: instruction.directory,
        files: instruction.files,
        hasSkillval: instruction.hasSkillval,
        id: instruction.id,
        status: instruction.status,
        validationError: instruction.validationError,
      };
    }),
    missingRoots: discovery.missingRoots,
    skills: discoveryReport(discovery).skills,
  };
}

export function selectSkills(
  discovery: DiscoveryResult,
  requestedNames: readonly string[],
): readonly ReadyDiscoveredSkill[] {
  const byName = new Map<string, DiscoveredSkill>();
  for (const skill of discovery.skills) {
    if (!byName.has(skill.name)) byName.set(skill.name, skill);
  }

  if (requestedNames.length === 0) {
    return [...byName.values()].filter(
      (skill): skill is ReadyDiscoveredSkill => skill.status === "ready",
    );
  }

  return requestedNames.map((name) => {
    const skill = byName.get(name);
    if (skill === undefined) {
      throw new Error(`skill "${name}" not found under configured roots`);
    }
    if (skill.status === "missing") {
      throw new Error(`skill "${name}" has no skillval.yml`);
    }
    if (skill.status === "invalid") {
      throw new Error(skill.validationError);
    }
    return skill;
  });
}

function describeSkill(name: string, root: string, skillDirectory: string): DiscoveredSkill {
  const caseFilePath = join(skillDirectory, "skillval.yml");
  if (!existsSync(caseFilePath)) {
    return {
      caseCount: 0,
      class: undefined,
      hasSkillval: false,
      name,
      root,
      skillDirectory,
      status: "missing",
      validationError: undefined,
    };
  }

  let evals: SkillEvals;
  try {
    evals = readCaseFile(caseFilePath, name);
  } catch (error) {
    return {
      caseCount: 0,
      class: "invalid",
      hasSkillval: true,
      name,
      root,
      skillDirectory,
      status: "invalid",
      validationError: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    caseCount: evals.cases.length,
    class: evals.class,
    evals,
    hasSkillval: true,
    name,
    root,
    skillDirectory,
    status: "ready",
    validationError: undefined,
  };
}

function describeInstruction(
  directory: string,
  files: readonly InstructionFile[],
  id: string,
): DiscoveredInstruction {
  const caseFilePath = join(directory, "skillval.yml");
  if (!existsSync(caseFilePath)) {
    return {
      caseCount: 0,
      class: undefined,
      directory,
      files,
      hasSkillval: false,
      id,
      status: "missing",
      validationError: undefined,
    };
  }

  let evals: SkillEvals;
  try {
    evals = readCaseFile(caseFilePath);
    if (evals.target !== "instructions") {
      throw new Error(`${caseFilePath} target must be "instructions"`);
    }
  } catch (error) {
    return {
      caseCount: 0,
      class: "invalid",
      directory,
      files,
      hasSkillval: true,
      id,
      status: "invalid",
      validationError: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    caseCount: evals.cases.length,
    class: evals.class,
    directory,
    evals,
    files,
    hasSkillval: true,
    id,
    status: "ready",
    validationError: undefined,
  };
}

function instructionId(projectBase: string, projectRoot: string, directory: string): string {
  const relativeDirectory = relative(projectRoot, directory);
  const location = relativeDirectory === "" ? "." : relativeDirectory.split(sep).join("/");
  return `${projectBase}:${location}`;
}

function walkProject(
  projectRoot: string,
  directory: string,
  projectBase: string,
  instructions: DiscoveredInstruction[],
  skills: DiscoveredSkill[],
): void {
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const entryNames = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  const files = (["AGENTS.md", "CLAUDE.md"] as const).filter((file) => entryNames.has(file));
  if (files.length > 0) {
    instructions.push(
      describeInstruction(directory, files, instructionId(projectBase, projectRoot, directory)),
    );
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ".git" || entry.name === "node_modules") continue;
    const childDirectory = join(directory, entry.name);
    const isSkillsDirectory =
      entry.name === "skills" &&
      (basename(directory) === ".agents" || basename(directory) === ".claude");
    if (isSkillsDirectory) {
      const skillEntries = readdirSync(childDirectory, { withFileTypes: true })
        .filter((skillEntry) => skillEntry.isDirectory())
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const skillEntry of skillEntries) {
        const skillDirectory = join(childDirectory, skillEntry.name);
        if (!existsSync(join(skillDirectory, "SKILL.md"))) continue;
        skills.push(describeSkill(skillEntry.name, childDirectory, skillDirectory));
      }
      continue;
    }
    walkProject(projectRoot, childDirectory, projectBase, instructions, skills);
  }
}
