import { describe, expect, it } from "vitest";
import type { ReadyDiscoveredSkill } from "../src/discovery.js";
import { assertShellAllowed } from "../src/runner.js";
import type { EvalCase, Fixture } from "../src/types.js";

interface CaseInput {
  readonly assert?: EvalCase["assert"];
  readonly fixture?: Fixture;
  readonly id: string;
}

const skill = (name: string, cases: CaseInput[], suiteFixture?: Fixture) =>
  ({ evals: { cases, fixture: suiteFixture }, name }) as unknown as ReadyDiscoveredSkill;

const setupFixture: Fixture = { setup: ["git init"] };
const commandExitCase: CaseInput = {
  assert: { command_exit: { command: "test -f out.ts" } },
  id: "cmd",
};

describe("assertShellAllowed", () => {
  it("refuses a case with fixture setup commands when shell is not allowed", () => {
    const skills = [skill("s", [{ fixture: setupFixture, id: "gen" }])];

    expect(() => assertShellAllowed(skills, undefined, false)).toThrow("--allow-shell");
    expect(() => assertShellAllowed(skills, undefined, false)).toThrow("fixture setup commands");
  });

  it("refuses a case that inherits suite-level fixture setup commands", () => {
    const skills = [skill("s", [{ id: "gen" }], setupFixture)];

    expect(() => assertShellAllowed(skills, undefined, false)).toThrow("--allow-shell");
  });

  it("refuses a case with a command_exit grader when shell is not allowed", () => {
    const skills = [skill("s", [commandExitCase])];

    expect(() => assertShellAllowed(skills, undefined, false)).toThrow("command_exit grader");
  });

  it("allows any shell once --allow-shell is set", () => {
    const skills = [skill("s", [{ fixture: setupFixture, id: "gen" }, commandExitCase])];

    expect(() => assertShellAllowed(skills, undefined, true)).not.toThrow();
  });

  it("allows a case whose fixture only copies files, with no setup commands", () => {
    const skills = [skill("s", [{ fixture: { path: "repo" }, id: "gen" }])];

    expect(() => assertShellAllowed(skills, undefined, false)).not.toThrow();
  });

  it("allows a case with no fixture and no command_exit grader", () => {
    const skills = [skill("s", [{ assert: { must_match: ["x"] }, id: "gen" }])];

    expect(() => assertShellAllowed(skills, undefined, false)).not.toThrow();
  });

  it("honors a case-level fixture that replaces a suite fixture with setup commands", () => {
    // The suite fixture has setup commands, but the selected case overrides it with a setup-free
    // fixture, so nothing shell-bearing actually runs for that case.
    const skills = [skill("s", [{ fixture: { path: "repo" }, id: "gen" }], setupFixture)];

    expect(() => assertShellAllowed(skills, "gen", false)).not.toThrow();
  });

  it("ignores shell in cases filtered out of the run", () => {
    const skills = [skill("s", [{ id: "clean" }, { fixture: setupFixture, id: "shelly" }])];

    expect(() => assertShellAllowed(skills, "clean", false)).not.toThrow();
    expect(() => assertShellAllowed(skills, "shelly", false)).toThrow("--allow-shell");
  });
});
