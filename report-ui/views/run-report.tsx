import Balancer from "react-wrap-balancer";
import {
  ACTION_LABEL,
  CARDED_ACTIONS,
  cardEvidence,
  FINDING_REASON,
  SKILL_ACTION_LABEL,
  type SkillCaseAction,
  skillCaseAction,
  skillCaseReason,
} from "../../src/report-model.js";
import type { RunPayload } from "../../src/report-payload.js";
import type { InstructionAction, InstructionFinding, RunReport } from "../../src/runner.js";
import type { ArmResult, CaseResult } from "../../src/types.js";
import { armState } from "../../src/verdict.js";
import { CheckDetail } from "../components/check-detail";
import { NavTabs } from "../components/nav-tabs";
import { Primer } from "../components/primer";
import { ReasonText, Term } from "../components/term";
import { Badge } from "../components/ui/badge";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "../components/ui/sheet";
import { cn } from "../lib/utils";

const ACTION_BADGE: Readonly<
  Record<SkillCaseAction, "destructive" | "keep" | "muted" | "primary" | "warn">
> = {
  investigate: "warn",
  keep: "keep",
  ok: "muted",
  "prune-candidate": "destructive",
  rerun: "muted",
  review: "warn",
};

const ACTION_STRIPE: Readonly<Record<SkillCaseAction, string>> = {
  investigate: "border-l-warning",
  keep: "border-l-success",
  ok: "border-l-border",
  "prune-candidate": "border-l-destructive",
  rerun: "border-l-muted-foreground",
  review: "border-l-warning",
};

export function RunReportView({ payload }: { readonly payload: RunPayload }) {
  const { context, report } = payload;
  return (
    <div className="mx-auto max-w-6xl px-5 pt-10 pb-16">
      <header className="border-border border-b pb-0">
        <p className="font-mono font-semibold text-[0.72rem] text-primary uppercase tracking-widest">
          skillval
        </p>
        <h1 className="mt-1 font-semibold text-2xl tracking-tight">
          <Balancer>Evaluation report</Balancer>
        </h1>
        <p className="mt-1 text-muted-foreground text-sm">
          {report.executor.name} {report.executor.version} &middot; model {report.executor.model}{" "}
          &middot; thinking {report.executor.thinking} &middot; {context.generatedAt}
        </p>
        <NavTabs active={context.variant === "archive" ? "run-archive" : "run"} />
      </header>

      <div className="mt-5">
        <Primer title="How skillval decides - 20-second refresher">
          <p>
            Each case runs the same prompt in isolated <Term k="arm" text="arms" />:{" "}
            <Term k="solo" /> has the skill installed, <Term k="baseline" /> has no skill at all
            (group mode adds group and peers arms).
          </p>
          <p>
            An arm's pass/fail is a majority vote over its <Term k="trial" text="trials" /> - 1 to
            5, escalating on disagreement; infrastructure trials never vote.
          </p>
          <p>
            The verdict is a comparison between arms: a pass with a failing baseline is{" "}
            <Term k="load-bearing" />; a pass with a passing baseline is a <Term k="no-op" /> (prune
            candidate); a case whose deciding arm was never graded is <Term k="inconclusive" />.
            Every highlighted term on this page opens a refresher.
          </p>
        </Primer>

        <SkillActionPanel report={report} />
        <InstructionActionPanel report={report} />
        <InstructionTargets report={report} />
        <SkillResults report={report} />
      </div>

      <footer className="mt-10 border-border border-t pt-4 text-muted-foreground text-xs">
        <p>
          Raw JSON: <code className="break-all font-mono">{context.reportPath}</code>
        </p>
        <p className="mt-1">
          Every finding is backed by its arm results: <strong>group</strong> is the whole file,{" "}
          <strong>peers</strong> is the file with that one rule removed, <strong>solo</strong> is
          the rule alone.
        </p>
      </footer>
    </div>
  );
}

interface SkillCard {
  readonly action: SkillCaseAction;
  readonly result: CaseResult;
  readonly skillName: string;
}

function SkillActionPanel({ report }: { readonly report: RunReport }) {
  const cards: SkillCard[] = [];
  for (const [skillName, skill] of Object.entries(report.skills)) {
    for (const result of skill.cases) {
      const action = skillCaseAction(result);
      if (CARDED_ACTIONS.includes(action)) cards.push({ action, result, skillName });
    }
  }
  if (cards.length === 0) return null;
  cards.sort((a, b) => CARDED_ACTIONS.indexOf(a.action) - CARDED_ACTIONS.indexOf(b.action));
  return (
    <section className="mb-6 rounded-lg border border-border bg-card p-5">
      <h2 className="font-semibold text-lg">What to change - skills</h2>
      <p className="mt-0.5 mb-4 text-muted-foreground text-sm">
        {cards.length} case{cards.length === 1 ? "" : "s"} need attention. Each card explains the
        causal chain behind its action.
      </p>
      <ul className="grid gap-3.5">
        {cards.map((card) => (
          <SkillActionCard card={card} key={`${card.skillName}/${card.result.id}`} />
        ))}
      </ul>
    </section>
  );
}

function SkillActionCard({ card }: { readonly card: SkillCard }) {
  const { action, result, skillName } = card;
  const where = `${skillName} / ${result.id}${result.rule === undefined ? "" : ` / ${result.rule}`}`;
  const evidence = cardEvidence(result);
  return (
    <li
      className={cn(
        "rounded-md border border-border border-l-3 bg-background px-4 py-3.5",
        ACTION_STRIPE[action],
      )}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2.5">
        <Badge variant={ACTION_BADGE[action]}>{SKILL_ACTION_LABEL[action]}</Badge>
        <code className="font-mono text-muted-foreground text-xs">{where}</code>
      </div>
      <p className="mb-2.5 text-sm leading-relaxed">
        <ReasonText segments={skillCaseReason(result)} />
      </p>
      {evidence.length > 0 ? (
        <div className="mb-2.5 grid gap-1.5">
          {evidence.map((check, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: checks have no stable identity
            <CheckDetail check={check} key={index} />
          ))}
        </div>
      ) : null}
      <EvidenceSheet result={result} skillName={skillName} where={where} />
    </li>
  );
}

/** The full per-case evidence, in a wide right sidebar: every arm, every trial, every check. */
function EvidenceSheet({
  result,
  skillName,
  where,
}: {
  readonly result: CaseResult;
  readonly skillName: string;
  readonly where: string;
}) {
  return (
    <Sheet>
      <SheetTrigger
        aria-label={`Full evidence for ${where}`}
        className="cursor-pointer rounded-md border border-border px-2.5 py-1 text-muted-foreground text-xs transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        Full evidence
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <p className="font-mono text-[0.68rem] text-primary uppercase tracking-widest">
            evidence
          </p>
          <SheetTitle className="font-mono text-base">
            {skillName} / {result.id}
          </SheetTitle>
        </SheetHeader>
        {result.arms.map((arm) => (
          <ArmEvidence arm={arm} key={arm.arm} />
        ))}
      </SheetContent>
    </Sheet>
  );
}

function ArmEvidence({ arm }: { readonly arm: ArmResult }) {
  const state = armState(arm);
  const stateText = state === "infra" ? "infra (not graded)" : state === "pass" ? "pass" : "FAIL";
  return (
    <section>
      <h4 className="mb-1.5 font-mono font-semibold text-sm">
        {arm.arm} -{" "}
        <span
          className={cn(
            state === "pass" && "text-success",
            state === "fail" && "text-destructive",
            state === "infra" && "text-warning",
          )}
        >
          {stateText}
        </span>
        {arm.cached ? <span className="text-muted-foreground"> (cached)</span> : null}
      </h4>
      {arm.trials.length === 0 ? (
        <p className="text-muted-foreground text-xs">no trials recorded</p>
      ) : (
        arm.trials.map((trial, trialIndex) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: trials are ordered and stable
          <div className="mb-3 overflow-x-auto" key={trialIndex}>
            <table className="w-full border-collapse text-xs">
              <caption className="pb-1 text-left text-muted-foreground">
                trial {trialIndex + 1}
              </caption>
              <thead>
                <tr className="border-border border-b text-left text-muted-foreground uppercase tracking-wide">
                  <th className="py-1 pr-2 font-semibold">Check</th>
                  <th className="py-1 pr-2 font-semibold">Result</th>
                  <th className="py-1 font-semibold">Detail</th>
                </tr>
              </thead>
              <tbody>
                {trial.checks.map((check, checkIndex) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: checks are ordered and stable
                  <tr className="border-border border-b align-top" key={checkIndex}>
                    <td className="py-1 pr-2 font-mono">{check.name}</td>
                    <td
                      className={cn("py-1 pr-2", check.pass ? "text-success" : "text-destructive")}
                    >
                      {check.pass ? "pass" : "fail"}
                    </td>
                    <td className="whitespace-pre-wrap break-words py-1 font-mono">
                      {check.detail}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}
    </section>
  );
}

const INSTRUCTION_BADGE: Readonly<
  Record<InstructionAction, "destructive" | "keep" | "muted" | "warn">
> = {
  delete: "destructive",
  investigate: "muted",
  keep: "keep",
  review: "warn",
};

function InstructionActionPanel({ report }: { readonly report: RunReport }) {
  const findings = Object.values(report.instructions ?? {}).flatMap((target) =>
    target.findings.map((finding) => ({ finding, targetId: target.id })),
  );
  if (findings.length === 0) return null;
  const actionable = findings.filter(
    ({ finding }) => finding.action === "delete" || finding.action === "review",
  );
  return (
    <section className="mb-6 rounded-lg border border-border bg-card p-5">
      <h2 className="font-semibold text-lg">What to change - instructions</h2>
      {actionable.length === 0 ? (
        <p className="mt-2 text-muted-foreground text-sm">
          Nothing to change - no rule was flagged for deletion or review.
        </p>
      ) : (
        <ul className="mt-4 grid gap-3.5">
          {actionable.map(({ finding, targetId }) => (
            <li
              className="rounded-md border border-border border-l-3 border-l-destructive bg-background px-4 py-3.5"
              key={`${targetId}/${finding.caseId}`}
            >
              <div className="mb-2 flex flex-wrap items-center gap-2.5">
                <Badge variant={INSTRUCTION_BADGE[finding.action]}>
                  {ACTION_LABEL[finding.action]}
                </Badge>
                <code className="font-mono text-muted-foreground text-xs">
                  {targetId}
                  {finding.file === "" ? "" : ` / ${finding.file}`}
                </code>
              </div>
              <pre className="mb-2 overflow-x-auto rounded-md border border-border bg-card px-3 py-2 text-xs">
                <code className="whitespace-pre-wrap break-words font-mono">{finding.span}</code>
              </pre>
              <p className="text-sm leading-relaxed">
                {finding.verdict === "n/a"
                  ? (finding.naReason ?? "not applicable to this executor")
                  : FINDING_REASON[finding.verdict]}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function InstructionTargets({ report }: { readonly report: RunReport }) {
  const targets = Object.values(report.instructions ?? {});
  if (targets.length === 0) return null;
  return (
    <section className="mb-6 rounded-lg border border-border bg-card p-5">
      <h2 className="font-semibold text-lg">Instruction files</h2>
      {targets.map((target) => (
        <article className="mt-4" key={target.id}>
          <h3 className="font-mono font-semibold text-sm">{target.id}</h3>
          <p className="text-muted-foreground text-xs">{target.directory}</p>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-border border-b text-left text-muted-foreground text-xs uppercase tracking-wide">
                  <th className="py-1.5 pr-3 font-semibold">Case</th>
                  <th className="py-1.5 pr-3 font-semibold">File</th>
                  <th className="py-1.5 pr-3 font-semibold">Verdict</th>
                  <th className="py-1.5 pr-3 font-semibold">Action</th>
                  <th className="py-1.5 font-semibold">Arms</th>
                </tr>
              </thead>
              <tbody>
                {target.findings.map((finding) => (
                  <tr className="border-border border-b align-top" key={finding.caseId}>
                    <td className="py-1.5 pr-3 font-mono text-xs">{finding.caseId}</td>
                    <td className="py-1.5 pr-3 font-mono text-xs">
                      {finding.file === "" ? "-" : finding.file}
                    </td>
                    <td className="py-1.5 pr-3">
                      <FindingVerdict finding={finding} />
                    </td>
                    <td className="py-1.5 pr-3">
                      <Badge variant={INSTRUCTION_BADGE[finding.action]}>
                        {ACTION_LABEL[finding.action]}
                      </Badge>
                    </td>
                    <td className="py-1.5">
                      <ArmChips arms={finding.arms} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>
      ))}
    </section>
  );
}

function FindingVerdict({ finding }: { readonly finding: InstructionFinding }) {
  if (finding.verdict === "n/a") {
    return (
      <span className="text-muted-foreground text-xs">
        n/a{finding.naReason === undefined ? "" : ` - ${finding.naReason}`}
      </span>
    );
  }
  return <VerdictWord verdict={finding.verdict} />;
}

// Verdict words that have glossary entries open them; the rest render as plain text.
function VerdictWord({ verdict }: { readonly verdict: string }) {
  if (verdict === "prune") return <Term k="prune-candidate" text="prune" />;
  if (
    verdict === "inconclusive" ||
    verdict === "interference" ||
    verdict === "load-bearing" ||
    verdict === "redundant"
  ) {
    return <Term k={verdict} />;
  }
  return <span>{verdict}</span>;
}

function ArmChips({ arms }: { readonly arms: readonly ArmResult[] }) {
  if (arms.length === 0) {
    return <span className="text-muted-foreground text-xs">no arms run</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {arms.map((arm) => {
        const state = armState(arm);
        return (
          <span
            className={cn(
              "rounded-sm border px-1.5 py-0.5 font-mono text-[0.7rem]",
              state === "pass" && "border-success/50 text-success",
              state === "fail" && "border-destructive/50 text-destructive",
              state === "infra" && "border-warning/50 text-warning",
            )}
            key={arm.arm}
          >
            {arm.arm} {state === "infra" ? "infra" : state}
          </span>
        );
      })}
    </div>
  );
}

function SkillResults({ report }: { readonly report: RunReport }) {
  const names = Object.keys(report.skills);
  if (names.length === 0) return null;
  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <h2 className="font-semibold text-lg">Skills</h2>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-border border-b text-left text-muted-foreground text-xs uppercase tracking-wide">
              <th className="py-1.5 pr-3 font-semibold">Skill</th>
              <th className="py-1.5 pr-3 font-semibold">Case</th>
              <th className="py-1.5 pr-3 font-semibold">Result</th>
              <th className="py-1.5 font-semibold">Arms</th>
            </tr>
          </thead>
          <tbody>
            {names.flatMap((name) => {
              const skill = report.skills[name];
              if (skill === undefined) return [];
              return skill.cases.map((result) => (
                <tr className="border-border border-b align-top" key={`${name}/${result.id}`}>
                  <td className="py-1.5 pr-3 font-mono text-xs">{name}</td>
                  <td className="py-1.5 pr-3 font-mono text-xs">{result.id}</td>
                  <td className="py-1.5 pr-3">
                    <CaseVerdictCell result={result} />
                  </td>
                  <td className="py-1.5">
                    <ArmChips arms={result.arms} />
                  </td>
                </tr>
              ));
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function CaseVerdictCell({ result }: { readonly result: CaseResult }) {
  const verdict =
    result.loadout === undefined ? (
      result.inconclusive ? (
        <Term k="inconclusive" />
      ) : result.pass ? (
        <span>pass</span>
      ) : (
        <span className="text-destructive">FAIL</span>
      )
    ) : (
      <VerdictWord verdict={result.loadout.verdict} />
    );
  return (
    <span className="inline-flex items-center gap-1.5">
      {verdict}
      {result.noop ? <Term k="no-op" text="no-op" /> : null}
    </span>
  );
}
