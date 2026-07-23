#!/usr/bin/env node

/** Defines the command-line transport and renders runner and discovery results. */
import { Command } from "commander";
import { loadConfig, resolveConfigPath } from "./config.js";
import type { DiscoveredSkill } from "./discovery.js";
import { discoverSkills, discoveryReport } from "./discovery.js";
import type { ArmPlan, RunPlan } from "./runner.js";
import { planEvaluation, runEvaluation } from "./runner.js";

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
  .version("0.3.0") // x-release-please-version
  .option("--config <path>", "read configuration from this path");

program
  .command("run")
  .description(
    "Run selected cases and return a report whose exit status fails when any skill arm fails",
  )
  .argument("[skill...]", "skill names; omit to run every skill with skillval.yml")
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
  .action((skills: string[], options: RunCommandOptions, command: Command): void => {
    const globalOptions = command.optsWithGlobals() as GlobalOptions & RunCommandOptions;
    const configPath = resolveConfigPath({ cliPath: globalOptions.config });
    const config = loadConfig(configPath);
    const runOptions = {
      allowShell: options.allowShell === true,
      allowUnsandboxedPi: options.allowUnsandboxedPi === true,
      caseFilter: options.case,
      effort: options.effort,
      loadout: options.loadout,
      model: options.model,
      requestedSkills: skills,
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
      if (outcome.noops > 0) {
        console.log(
          `no-op alert: ${outcome.noops} case(s) pass without the skill - prune candidates`,
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
    const discovery = discoverSkills(config.roots);
    if (options.json === true) {
      console.log(JSON.stringify(discoveryReport(discovery), null, 2));
      return;
    }

    printSkillTable(discovery.skills);
    for (const skill of discovery.skills) {
      if (skill.status === "invalid") console.log(`invalid skill: ${skill.validationError}`);
    }
    for (const root of discovery.missingRoots) console.log(`missing root: ${root}`);
  });

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

await main();
