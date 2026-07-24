#!/usr/bin/env node

/** Defines the command-line transport and renders runner and discovery results. */
import { spawn } from "node:child_process";
import { Command } from "commander";
import { loadConfig, resolveConfigPath } from "./config.js";
import type { DiscoveredInstruction, DiscoveredSkill } from "./discovery.js";
import {
  discoverProjects,
  discoverSkills,
  discoveryReport,
  projectDiscoveryReport,
} from "./discovery.js";
import type { ArmPlan, RunPlan } from "./runner.js";
import { planEvaluation, routeRunTargets, runEvaluation } from "./runner.js";

interface GlobalOptions {
  readonly config?: string;
}

interface ListOptions {
  readonly json?: boolean;
}

interface RunCommandOptions {
  readonly allowShell?: boolean;
  readonly allowUnsandboxedPi?: boolean;
  readonly cache: boolean;
  readonly case?: string;
  readonly dryRun?: boolean;
  readonly effort?: string;
  readonly json?: boolean;
  readonly loadout?: string;
  readonly model?: string;
  readonly skipBaseline?: boolean;
}

const program = new Command();

program
  .name("skillval")
  .description("Evaluate agent skills with deterministic graders")
  .configureHelp({ showGlobalOptions: true })
  .version("0.4.0") // x-release-please-version
  .option("--config <path>", "read configuration from this path");

program
  .command("run")
  .description(
    "Run selected cases and return a report whose exit status fails when any target arm fails",
  )
  .argument("[target...]", "skill names or instruction target IDs; omit to run every ready target")
  .option("--case <id>", "run only the case with this id")
  .option("--model <model>", "model for the executor to use this run")
  .option("--effort <level>", "effort/thinking level for the executor to use this run")
  .option(
    "--loadout <name>",
    "run group mode against a configured loadout (solo, group, and peers arms)",
  )
  .option("--no-cache", "ignore cached arm results")
  .option("--dry-run", "report the trials a run would spend against the cache, spawning nothing")
  .option("--skip-baseline", "do not run baseline arms")
  .option(
    "--allow-shell",
    "permit case-authored shell (fixture setup commands and the command_exit grader)",
  )
  .option(
    "--allow-unsandboxed-pi",
    "acknowledge that pi generation trials run without an OS sandbox",
  )
  .option("--json", "return the complete report as JSON")
  .action((targets: string[], options: RunCommandOptions, command: Command): void => {
    const globalOptions = command.optsWithGlobals() as GlobalOptions & RunCommandOptions;
    const configPath = resolveConfigPath({ cliPath: globalOptions.config });
    const config = loadConfig(configPath);
    const requested = routeRunTargets(targets);
    const runOptions = {
      allowShell: options.allowShell === true,
      allowUnsandboxedPi: options.allowUnsandboxedPi === true,
      caseFilter: options.case,
      effort: options.effort,
      loadout: options.loadout,
      model: options.model,
      requestedInstructions: requested.requestedInstructions,
      requestedSkills: requested.requestedSkills,
      skipBaseline: options.skipBaseline === true,
      useCache: options.cache,
    };
    const quiet =
      options.json === true ? () => undefined : (message: string) => console.log(message);

    if (options.dryRun === true) {
      const plan = planEvaluation(config, runOptions, quiet);
      if (options.json === true) {
        console.log(JSON.stringify(plan, null, 2));
      } else {
        printPlan(plan);
      }
      process.exitCode = 0;
      return;
    }

    const outcome = runEvaluation(config, runOptions, quiet);

    if (options.json === true) {
      console.log(JSON.stringify(outcome.report, null, 2));
    } else {
      console.log(`report: ${outcome.reportPath}`);
      if (outcome.htmlReportPath !== undefined) {
        console.log(`html: ${outcome.htmlReportPath}`);
        openInBrowser(outcome.htmlReportPath);
      }
      if (outcome.noops > 0) {
        console.log(
          `no-op alert: ${outcome.noops} case(s) pass without the target - prune candidates`,
        );
      }
      if (outcome.interferences > 0) {
        console.log(
          `interference alert: ${outcome.interferences} case(s) work alone but the loadout breaks them`,
        );
      }
      console.log(
        outcome.failures === 0 ? "all cases passed" : `${outcome.failures} case(s) FAILED`,
      );
    }
    process.exitCode = outcome.failures > 0 ? 1 : 0;
  });

program
  .command("list")
  .description(
    "Return discovered skills, evaluation metadata, and configured roots that are missing",
  )
  .option("--json", "return the complete discovery result as JSON")
  .action((options: ListOptions, command: Command): void => {
    const globalOptions = command.optsWithGlobals() as GlobalOptions & ListOptions;
    const configPath = resolveConfigPath({ cliPath: globalOptions.config });
    const config = loadConfig(configPath);
    const discovery = discoverSkills(config.roots, config.exclude ?? []);
    const projectDiscovery = discoverProjects(config.projects ?? [], config.exclude ?? []);
    if (options.json === true) {
      const rootReport = discoveryReport(discovery);
      if (config.projects === undefined) {
        console.log(JSON.stringify(rootReport, null, 2));
      } else {
        const projectReport = projectDiscoveryReport(projectDiscovery);
        console.log(
          JSON.stringify(
            {
              instructions: projectReport.instructions,
              missingRoots: [...rootReport.missingRoots, ...projectReport.missingRoots],
              skills: [...rootReport.skills, ...projectReport.skills],
            },
            null,
            2,
          ),
        );
      }
      return;
    }

    const skills = [...discovery.skills, ...projectDiscovery.skills];
    printSkillTable(skills);
    for (const skill of skills) {
      if (skill.status === "invalid") console.log(`invalid skill: ${skill.validationError}`);
    }
    if (config.projects !== undefined) {
      console.log("");
      printInstructionTable(projectDiscovery.instructions);
      for (const instruction of projectDiscovery.instructions) {
        if (instruction.status === "invalid") {
          console.log(`invalid instruction target: ${instruction.validationError}`);
        }
      }
    }
    for (const root of [...discovery.missingRoots, ...projectDiscovery.missingRoots]) {
      console.log(`missing root: ${root}`);
    }
  });

// Opening the report is a convenience, never a failure mode: a headless or unusual environment
// simply keeps the printed path. The child is detached and unref'd so the CLI can exit immediately.
function openInBrowser(path: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(command, [path], { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // No opener available; the path above is the fallback.
  }
}

export async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

function printPlan(plan: RunPlan): void {
  const executor = plan.executor;
  console.log(
    `executor: ${executor.name} ${executor.version} (model ${executor.model}, ` +
      `thinking ${executor.thinking}, invocation detection ${executor.invocationDetection})`,
  );
  console.log("dry run: no trials will be spawned");
  for (const skill of plan.skills) {
    console.log(`${skill.name}:`);
    for (const casePlan of skill.cases) {
      for (const arm of casePlan.arms) {
        console.log(`  ${casePlan.id} [${arm.arm}] ${armPlanStatus(arm)}`);
      }
    }
  }
  for (const target of plan.instructions) {
    console.log(`${target.id}:`);
    for (const casePlan of target.cases) {
      if (casePlan.na) {
        console.log(`  ${casePlan.id} n/a (not visible to this executor; spends nothing)`);
        continue;
      }
      for (const arm of casePlan.arms) {
        console.log(`  ${casePlan.id} [${arm.arm}] ${armPlanStatus(arm)}`);
      }
    }
  }
  console.log(
    `plan: ${plan.armsToRun} arm(s) to run, ${plan.armsCached} cached, ${plan.armsReused} reused`,
  );
  const trials =
    plan.trialsMin === plan.trialsMax
      ? `${plan.trialsMin}`
      : `${plan.trialsMin} (up to ${plan.trialsMax} if arms escalate on disagreement)`;
  console.log(`trials to run: ${trials}`);
}

function armPlanStatus(arm: ArmPlan): string {
  if (arm.reused) return "reused from solo (no peers)";
  if (arm.cached) return "cached";
  if (arm.trialsMin === arm.trialsMax) {
    return `run (${arm.trialsMin} ${arm.trialsMin === 1 ? "trial" : "trials"})`;
  }
  return `run (${arm.trialsMin}-${arm.trialsMax} trials)`;
}

function printSkillTable(skills: readonly DiscoveredSkill[]): void {
  const rows = [
    ["NAME", "ROOT", "CLASS", "CASES", "HAS-SKILLVAL.YML"],
    ...skills.map((skill) => [
      skill.name,
      skill.root,
      skill.class ?? "-",
      String(skill.caseCount),
      skill.hasSkillval ? "true" : "false",
    ]),
  ];
  const widths = rows[0]?.map((_, column) =>
    Math.max(...rows.map((row) => row[column]?.length ?? 0)),
  );
  for (const row of rows) {
    console.log(
      row
        .map((cell, column) => cell.padEnd(widths?.[column] ?? cell.length))
        .join("  ")
        .trimEnd(),
    );
  }
}

function printInstructionTable(instructions: readonly DiscoveredInstruction[]): void {
  const rows = [
    ["ID", "DIRECTORY", "FILES", "CLASS", "CASES", "STATUS"],
    ...instructions.map((instruction) => [
      instruction.id,
      instruction.directory,
      instruction.files.join(","),
      instruction.class ?? "-",
      String(instruction.caseCount),
      instruction.status,
    ]),
  ];
  const widths = rows[0]?.map((_, column) =>
    Math.max(...rows.map((row) => row[column]?.length ?? 0)),
  );
  for (const row of rows) {
    console.log(
      row
        .map((cell, column) => cell.padEnd(widths?.[column] ?? cell.length))
        .join("  ")
        .trimEnd(),
    );
  }
}

await main();
