// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../../report-ui/app";
import type { ReportPayload } from "../../src/report-payload.js";
import type { RunReport } from "../../src/runner.js";

afterEach(cleanup);

const executor = {
  invocationDetection: "heuristic" as const,
  model: "gpt-5.6-sol",
  name: "codex",
  thinking: "medium",
  version: "0.145.0",
};

const runReport: RunReport = {
  executor,
  runHash: "abc",
  skills: {
    "my-skill": {
      cases: [
        {
          arms: [
            {
              arm: "solo",
              cached: false,
              pass: false,
              trials: [
                {
                  checks: [
                    {
                      detail: "pattern | got: what the model wrote",
                      name: "must_match",
                      pass: false,
                    },
                  ],
                  pass: false,
                  usage: null,
                },
              ],
            },
            { arm: "baseline", cached: false, pass: true, trials: [] },
          ],
          id: "failing-case",
          inconclusive: false,
          noop: true,
          pass: false,
          rule: undefined,
        },
      ],
      class: "capability",
      contentHash: "deadbeef",
    },
  },
};

const runPayload: ReportPayload = {
  context: { generatedAt: "2026-07-25T00:00:00.000Z", reportPath: "/x.json", variant: "latest" },
  kind: "run",
  report: runReport,
};

describe("report app - run view", () => {
  it("renders the what-to-change card with inline evidence", () => {
    render(<App payload={runPayload} />);

    expect(screen.getByText("What to change - skills")).toBeTruthy();
    expect(screen.getByText("Investigate")).toBeTruthy();
    // The detail renders structurally: the pattern as an inline chip, the got: content as its
    // own labeled code block.
    expect(screen.getByText("pattern")).toBeTruthy();
    expect(screen.getByText(/what the model wrote/)).toBeTruthy();
    expect(screen.getAllByText("got").length).toBeGreaterThan(0);
  });

  it("opens a rich glossary popover from a term chip", async () => {
    const user = userEvent.setup();
    render(<App payload={runPayload} />);

    // The solo-fail/baseline-pass reason references the baseline term.
    const chips = screen.getAllByRole("button", { name: /baseline/ });
    const firstChip = chips[0];
    expect(firstChip).toBeTruthy();
    if (firstChip === undefined) throw new Error("no term chip rendered");
    await user.click(firstChip);

    expect(await screen.findByText("What it means")).toBeTruthy();
    expect(screen.getByText(/The control arm/)).toBeTruthy();
  });

  it("opens the full-evidence sidebar with every arm's checks", async () => {
    const user = userEvent.setup();
    render(<App payload={runPayload} />);

    await user.click(screen.getByRole("button", { name: /Full evidence for my-skill/ }));

    expect(await screen.findByText(/solo -/)).toBeTruthy();
    expect(screen.getByText(/baseline -/)).toBeTruthy();
  });

  it("labels an archived report and links to the latest alias", () => {
    render(
      <App payload={{ ...runPayload, context: { ...runPayload.context, variant: "archive" } }} />,
    );

    expect(screen.getByText("This run (archived)")).toBeTruthy();
    const latestLink = screen.getByRole("link", { name: "Latest run" });
    expect(latestLink.getAttribute("href")).toBe("latest.html");
  });
});

const coverageReport = {
  caseCount: 2,
  counts: { execution: 1, regex: 0, trigger: 1, ungraded: 0 },
  groups: [
    {
      caseCount: 2,
      label: "alpha",
      root: "/roots/alpha",
      skills: [
        {
          behavioral: 1,
          cases: [
            {
              arms: ["solo", "baseline"],
              graders: ["command_exit"],
              id: "typed-errors",
              mode: "generation" as const,
              rule: "typed-contextual-errors",
              rung: "execution" as const,
              trials: 1,
              type: "preference" as const,
            },
            {
              arms: ["solo"],
              graders: ["should_trigger: true"],
              id: "fires",
              mode: "trigger" as const,
              rule: undefined,
              rung: "trigger" as const,
              trials: 1,
              type: undefined,
            },
          ],
          class: "preference" as const,
          counts: { execution: 1, regex: 0, trigger: 1, ungraded: 0 },
          hasBaselineComparison: true,
          hasNegativeTrigger: false,
          name: "observability",
          root: "/roots/alpha",
        },
      ],
    },
  ],
  missingRoots: ["/roots/gone"],
  skillCount: 1,
  skillsWithBaselineComparison: 1,
  skillsWithoutBehavioralCases: [],
  skillsWithoutNegativeTrigger: [{ name: "observability", root: "/roots/alpha" }],
  skipped: [
    {
      name: "broken",
      root: "/roots/alpha",
      status: "invalid" as const,
      validationError: "bad yaml",
    },
  ],
};

const coveragePayload: ReportPayload = {
  context: { generatedAt: "2026-07-25T00:00:00.000Z" },
  kind: "coverage",
  report: coverageReport,
};

describe("report app - coverage view", () => {
  it("renders tiles, discovery diagnostics, and the matrix row", () => {
    render(<App payload={coveragePayload} />);

    expect(screen.getByText("eval cases")).toBeTruthy();
    expect(screen.getByText("Not covered by this report")).toBeTruthy();
    expect(screen.getByText(/missing root:/)).toBeTruthy();
    expect(screen.getByText(/bad yaml/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /observability/ })).toBeTruthy();
  });

  it("expands a matrix row to its case-level detail", async () => {
    const user = userEvent.setup();
    render(<App payload={coveragePayload} />);

    await user.click(screen.getByRole("button", { name: /observability/ }));

    expect(await screen.findByText("typed-errors")).toBeTruthy();
    expect(screen.getByText("typed-contextual-errors")).toBeTruthy();
    expect(screen.getByText("command_exit")).toBeTruthy();
  });

  it("keeps composition tooltips outside the row toggle", () => {
    render(<App payload={coveragePayload} />);

    // Segment buttons and the row trigger are siblings: no button nests inside another.
    for (const button of screen.getAllByRole("button")) {
      expect(button.parentElement?.closest("button")).toBeNull();
    }
  });

  it("renders the explicit empty state", () => {
    render(
      <App
        payload={{
          ...coveragePayload,
          report: {
            ...coverageReport,
            caseCount: 0,
            groups: [],
            missingRoots: [],
            skillCount: 0,
            skipped: [],
          },
        }}
      />,
    );

    expect(screen.getByText("No ready skills discovered")).toBeTruthy();
  });
});

describe("report app - run view contracts", () => {
  it("renders a rerun card for an inconclusive case", () => {
    render(
      <App
        payload={{
          ...runPayload,
          report: {
            ...runReport,
            skills: {
              "my-skill": {
                cases: [
                  {
                    arms: [],
                    id: "overflow",
                    inconclusive: true,
                    noop: false,
                    pass: false,
                    rule: undefined,
                  },
                ],
                class: "capability" as const,
                contentHash: "deadbeef",
              },
            },
          },
        }}
      />,
    );

    expect(screen.getByText("Rerun")).toBeTruthy();
    expect(screen.getByText(/infrastructure failure/)).toBeTruthy();
  });

  it("shows instruction cards with their arm evidence and n/a reasons in the table", () => {
    render(
      <App
        payload={{
          ...runPayload,
          report: {
            ...runReport,
            instructions: {
              "myapp:.": {
                directory: "/repo",
                findings: [
                  {
                    action: "delete" as const,
                    arms: [{ arm: "peers" as const, cached: false, pass: true, trials: [] }],
                    caseId: "duplicate-rule",
                    file: "AGENTS.md",
                    rule: undefined,
                    span: "- Always use tabs.",
                    verdict: "redundant" as const,
                  },
                  {
                    action: "investigate" as const,
                    arms: [],
                    caseId: "claude-only",
                    file: "",
                    naReason: "rule is not in a file codex reads ambiently",
                    rule: undefined,
                    span: "- Claude only.",
                    verdict: "n/a" as const,
                  },
                ],
                id: "myapp:.",
              },
            },
            skills: {},
          },
        }}
      />,
    );

    expect(screen.getByText("- Always use tabs.")).toBeTruthy();
    // The card carries its arm evidence beside the recommendation.
    expect(screen.getAllByText(/peers pass/).length).toBeGreaterThan(0);
    expect(screen.getByText(/rule is not in a file codex reads ambiently/)).toBeTruthy();
  });
});
