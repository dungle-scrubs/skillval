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
    expect(screen.getByText(/got: what the model wrote/)).toBeTruthy();
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
