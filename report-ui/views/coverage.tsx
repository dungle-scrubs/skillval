import { ChevronRightIcon } from "lucide-react";
import Balancer from "react-wrap-balancer";
import type { CoverageReport, SkillCoverage, SkillRef } from "../../src/coverage.js";
import type { CoveragePayload } from "../../src/report-payload.js";
import { CompositionBar } from "../components/composition-bar";
import { NavTabs } from "../components/nav-tabs";
import { Primer } from "../components/primer";
import { Term } from "../components/term";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import { cn } from "../lib/utils";

export function CoverageView({ payload }: { readonly payload: CoveragePayload }) {
  const { context, report } = payload;
  const behavioral = report.counts.regex + report.counts.execution;
  const behavioralShare =
    report.caseCount === 0 ? 0 : Math.round((100 * behavioral) / report.caseCount);
  return (
    <div className="mx-auto max-w-6xl px-5 pt-10 pb-16">
      <header className="border-border border-b pb-0">
        <p className="font-mono font-semibold text-[0.72rem] text-primary uppercase tracking-widest">
          skillval
        </p>
        <h1 className="mt-1 font-semibold text-2xl tracking-tight">
          <Balancer>Eval coverage across every discoverable skill</Balancer>
        </h1>
        <p className="mt-1 text-muted-foreground text-sm">
          {report.skillCount} skills &middot; grader rungs: trigger-only &rarr; regex &rarr;
          execution &middot; {context.generatedAt}
        </p>
        <NavTabs active="coverage" />
      </header>

      <div className="mt-5">
        <Primer title="New here, or it has been a while? The 20-second version">
          <p>
            Every eval case earns its rung from its strongest grader.{" "}
            <Term k="trigger" text="Trigger-only" /> proves the skill loads (or stays quiet) when it
            should - and nothing more. <Term k="regex" text="Regex" /> proves text patterns in the
            output, which a comment can satisfy. <Term k="execution" text="Execution" /> runs the
            produced code and grades what it does. <Term k="ungraded" text="Ungraded" /> means no
            grader at all.
          </p>
          <p>
            Behavioral cases can also run a <Term k="baseline" /> arm: the same prompt with no skill
            installed. When that control passes too, the rule is a <Term k="no-op" /> - the model
            already behaves that way unaided.
          </p>
          <p>
            Coverage answers "what is graded"; the Latest run tab answers "what happened". Every
            highlighted term on this page opens a refresher.
          </p>
        </Primer>

        <Notices report={report} />
        {report.skillCount === 0 ? (
          <EmptyState />
        ) : (
          <>
            <Tiles behavioralShare={behavioralShare} report={report} />
            <Overall report={report} />
            {report.groups.map((group) => (
              <Group group={group} key={group.root} />
            ))}
          </>
        )}
      </div>

      <footer className="mt-10 border-border border-t pt-4 text-muted-foreground text-xs">
        <p>
          Within each group, skills sort weakest-coverage-first (behavioral share, then suite size).
          The t / r / x column is the per-rung case count. Expand a skill for its case-level
          graders. Source of truth: each skill's <code className="font-mono">skillval.yml</code>.
        </p>
      </footer>
    </div>
  );
}

function Notices({ report }: { readonly report: CoverageReport }) {
  if (report.missingRoots.length === 0 && report.skipped.length === 0) return null;
  return (
    <section className="mb-5 rounded-lg border border-border border-l-3 border-l-warning bg-card px-4 py-3">
      <h2 className="font-semibold text-sm">Not covered by this report</h2>
      <ul className="mt-1.5 list-disc pl-5 text-muted-foreground text-xs leading-relaxed">
        {report.missingRoots.map((root) => (
          <li key={root}>
            missing root: <code className="font-mono">{root}</code>
          </li>
        ))}
        {report.skipped.map((skill) => (
          <li key={`${skill.root}/${skill.name}`}>
            skipped ({skill.status}): <code className="font-mono">{skill.name}</code>
            {skill.validationError === undefined ? "" : ` - ${skill.validationError}`}
          </li>
        ))}
      </ul>
    </section>
  );
}

function EmptyState() {
  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <h2 className="font-semibold text-lg">
        <Balancer>No ready skills discovered</Balancer>
      </h2>
      <p className="mt-1.5 text-muted-foreground text-sm">
        Nothing is evaluatable under the configured roots: a skill needs a{" "}
        <code className="font-mono">SKILL.md</code> and a valid{" "}
        <code className="font-mono">skillval.yml</code> beside it. Check the configuration and the
        notices above.
      </p>
    </section>
  );
}

function Tiles({
  behavioralShare,
  report,
}: {
  readonly behavioralShare: number;
  readonly report: CoverageReport;
}) {
  const tiles: readonly {
    readonly label: string;
    readonly tone?: string;
    readonly value: string;
  }[] = [
    { label: "ready skills", value: String(report.skillCount) },
    { label: "eval cases", value: String(report.caseCount) },
    {
      label: "trigger-only cases",
      tone: "text-rung-trigger",
      value: String(report.counts.trigger),
    },
    { label: "regex-graded cases", tone: "text-rung-regex", value: String(report.counts.regex) },
    {
      label: "execution-graded cases",
      tone: "text-rung-execution",
      value: String(report.counts.execution),
    },
    { label: "cases with a behavioral grader", value: `${behavioralShare}%` },
  ];
  return (
    <div className="mb-5 grid grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-3">
      {tiles.map((tile) => (
        <div className="rounded-lg border border-border bg-card px-4 py-3" key={tile.label}>
          <b className={cn("block font-semibold text-2xl tabular-nums leading-tight", tile.tone)}>
            {tile.value}
          </b>
          <span className="text-muted-foreground text-xs">{tile.label}</span>
        </div>
      ))}
    </div>
  );
}

function Overall({ report }: { readonly report: CoverageReport }) {
  return (
    <section className="mb-6 rounded-lg border border-border bg-card p-5">
      <h2 className="mb-3 font-semibold text-base">All {report.caseCount} cases by grader rung</h2>
      <CompositionBar counts={report.counts} tall total={report.caseCount} />
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-muted-foreground text-xs">
        <LegendEntry swatch="bg-rung-trigger">
          <Term k="trigger" text="trigger-only" /> ({report.counts.trigger}) - proves invocation
          behavior, not what the skill changes
        </LegendEntry>
        <LegendEntry swatch="bg-rung-regex">
          <Term k="regex" /> ({report.counts.regex}) - lexical presence in the output
        </LegendEntry>
        <LegendEntry swatch="bg-rung-execution">
          <Term k="execution" /> ({report.counts.execution}) - runtime behavior via command_exit /
          json_schema / tsc
        </LegendEntry>
        {report.counts.ungraded > 0 ? (
          <LegendEntry swatch="bg-rung-ungraded">
            <Term k="ungraded" /> ({report.counts.ungraded}) - no grader at all
          </LegendEntry>
        ) : null}
      </div>
      <p className="mt-3 text-muted-foreground text-xs leading-relaxed">
        {report.skillsWithBaselineComparison} of {report.skillCount} skills compare against a{" "}
        <Term k="baseline" /> arm on at least one behavioral case &middot;{" "}
        <GapSentence
          label={
            <>
              without a <Term k="trigger" text="negative trigger" /> case
            </>
          }
          none="every skill ships at least one negative trigger case (no thin boundaries)"
          refs={report.skillsWithoutNegativeTrigger}
        />{" "}
        &middot;{" "}
        <GapSentence
          label={<>with zero behavioral cases</>}
          none="every skill has at least one behavioral case"
          refs={report.skillsWithoutBehavioralCases}
        />
      </p>
    </section>
  );
}

function LegendEntry({
  children,
  swatch,
}: {
  readonly children: React.ReactNode;
  readonly swatch: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <i className={cn("size-2.5 rounded-sm", swatch)} />
      <span>{children}</span>
    </span>
  );
}

function GapSentence({
  label,
  none,
  refs,
}: {
  readonly label: React.ReactNode;
  readonly none: string;
  readonly refs: readonly SkillRef[];
}) {
  if (refs.length === 0) return <span>{none}</span>;
  return (
    <span>
      {refs.length} skill(s) {label}:{" "}
      {refs.map((ref, index) => (
        <span key={`${ref.root}/${ref.name}`}>
          {index > 0 ? ", " : ""}
          <code className="font-mono" title={ref.root}>
            {ref.name}
          </code>
        </span>
      ))}
    </span>
  );
}

function Group({ group }: { readonly group: CoverageReport["groups"][number] }) {
  return (
    <section className="mb-7">
      <h2 className="font-semibold text-base">
        {group.label}{" "}
        <span className="font-normal text-muted-foreground text-sm">
          {group.skills.length} skills &middot; {group.caseCount} cases
        </span>
      </h2>
      <p className="mb-2 font-mono text-muted-foreground text-[0.7rem]">{group.root}</p>
      <div
        aria-hidden
        className="grid grid-cols-[minmax(11rem,1.25fr)_6rem_3rem_minmax(8rem,1fr)_5.5rem_5rem] items-center gap-3.5 px-3.5 py-1 text-[0.68rem] text-muted-foreground uppercase tracking-wider max-md:hidden"
      >
        <span>skill</span>
        <span>class</span>
        <span>cases</span>
        <span>composition</span>
        <span>t / r / x</span>
        <span>behavioral</span>
      </div>
      <div className="grid gap-1.5">
        {group.skills.map((skill) => (
          <SkillRow key={skill.name} skill={skill} />
        ))}
      </div>
    </section>
  );
}

function SkillRow({ skill }: { readonly skill: SkillCoverage }) {
  const total = skill.cases.length;
  const share = total === 0 ? 0 : Math.round((100 * skill.behavioral) / total);
  const mix = `${skill.counts.trigger} / ${skill.counts.regex} / ${skill.counts.execution}${
    skill.counts.ungraded > 0 ? ` (+${skill.counts.ungraded}u)` : ""
  }`;
  return (
    <Collapsible className="rounded-md border border-border bg-card">
      {/* The row is a plain grid, not the trigger: the composition segments carry their own
          tooltip buttons, and interactive controls must never nest inside another button. Only
          the name cell toggles the row. */}
      <div className="grid grid-cols-[minmax(11rem,1.25fr)_6rem_3rem_minmax(8rem,1fr)_5.5rem_5rem] items-center gap-3.5 px-3.5 py-2 hover:bg-accent/40 max-md:grid-cols-[1fr_3rem_minmax(6rem,1fr)]">
        <CollapsibleTrigger className="group inline-flex cursor-pointer items-center gap-1 text-left font-mono font-semibold text-sm hover:text-primary focus-visible:outline-2 focus-visible:outline-ring">
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
          {skill.name}
        </CollapsibleTrigger>
        <span className="rounded-sm border border-border px-1.5 py-0.5 text-center text-[0.65rem] text-muted-foreground uppercase tracking-wide max-md:hidden">
          {skill.class}
        </span>
        <span className="pr-1.5 text-right text-sm tabular-nums">{total}</span>
        <CompositionBar counts={skill.counts} total={total} />
        <span className="font-mono text-muted-foreground text-xs tabular-nums max-md:hidden">
          {mix}
        </span>
        <span className="text-right text-muted-foreground text-sm tabular-nums max-md:hidden">
          {share}%
        </span>
      </div>
      <CollapsibleContent className="border-border border-t px-3.5 py-3">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-border border-b text-left text-muted-foreground text-xs uppercase tracking-wide">
                <th className="py-1.5 pr-3 font-semibold">Case</th>
                <th className="py-1.5 pr-3 font-semibold">Rule</th>
                <th className="py-1.5 pr-3 font-semibold">Mode</th>
                <th className="py-1.5 pr-3 font-semibold">Type</th>
                <th className="py-1.5 pr-3 font-semibold">Graders</th>
                <th className="py-1.5 pr-3 font-semibold">Arms</th>
                <th className="py-1.5 text-right font-semibold">Trials</th>
              </tr>
            </thead>
            <tbody>
              {skill.cases.map((item) => (
                <tr className="border-border border-b align-top" key={item.id}>
                  <td className="py-1.5 pr-3 font-mono text-xs">{item.id}</td>
                  <td className="py-1.5 pr-3 font-mono text-xs">{item.rule ?? "-"}</td>
                  <td className="py-1.5 pr-3 text-xs">{item.mode}</td>
                  <td className="py-1.5 pr-3 text-xs">{item.type ?? "-"}</td>
                  <td className="min-w-56 py-1.5 pr-3">
                    <GraderChips graders={item.graders} />
                  </td>
                  <td className="py-1.5 pr-3 text-xs">
                    {item.arms.length === 0 ? "(none)" : item.arms.join("+")}
                  </td>
                  <td className="py-1.5 text-right text-xs tabular-nums">{item.trials}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function GraderChips({ graders }: { readonly graders: readonly string[] }) {
  if (graders.length === 0) {
    return (
      <span className="rounded-sm border border-border px-1.5 py-0.5 font-mono text-[0.7rem] text-muted-foreground">
        no graders
      </span>
    );
  }
  return (
    <div className="flex flex-wrap gap-1">
      {graders.map((label) => (
        <span
          className={cn(
            "rounded-sm border px-1.5 py-0.5 font-mono text-[0.7rem]",
            label.startsWith("should_trigger")
              ? "border-rung-trigger/50 text-rung-trigger"
              : label.startsWith("must_")
                ? "border-rung-regex/50 text-rung-regex"
                : "border-rung-execution/50 text-rung-execution",
          )}
          key={label}
        >
          {label}
        </span>
      ))}
    </div>
  );
}
