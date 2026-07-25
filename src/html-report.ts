/** Renders a run report as one self-contained HTML page: what to change, why, and the evidence. */
import { renderReportNav, renderTermPanels, TERM_STYLES, termButton } from "./report-terms.js";
import type { InstructionAction, InstructionFinding, RunReport } from "./runner.js";
import type { ArmResult, CaseResult, Check, RuntimeArm } from "./types.js";
import type { Verdict } from "./verdict.js";
import { armState } from "./verdict.js";

// Why each verdict produced its action, in plain language tied to the arm that proved it. This is
// the "why" the page leads with - a bare verdict word is not actionable on its own.
const FINDING_REASON: Record<Verdict, string> = {
  inconclusive: "The arms did not form a conclusive pattern, so no action is implied yet.",
  interference:
    "The rule works on its own but the file fails with it present, so it fights the other rules here.",
  "load-bearing":
    "Removing this rule broke the behavior (the peers arm failed), so the rule is doing the work.",
  prune:
    "The rule did not produce the behavior on its own, and the behavior happened without it anyway.",
  redundant:
    "The behavior still happened with this rule removed (the peers arm passed), so another rule in this file already covers it.",
};

const ACTION_LABEL: Record<InstructionAction, string> = {
  delete: "Delete",
  investigate: "Investigate",
  keep: "Keep",
  review: "Review",
};

// What a skill case asks the reader to do, derived from its verdict and arm shapes. "ok" and "keep"
// are table-only states; the other four render remediation cards.
export type SkillCaseAction =
  | "investigate"
  | "keep"
  | "ok"
  | "prune-candidate"
  | "rerun"
  | "review";

const SKILL_ACTION_LABEL: Record<SkillCaseAction, string> = {
  investigate: "Investigate",
  keep: "Keep",
  ok: "OK",
  "prune-candidate": "Prune candidate",
  rerun: "Rerun",
  review: "Review",
};

// Card order: graded failures first (they may be mis-keyed asserts), then ungraded reruns, then
// prune candidates, then loadout reviews.
const CARDED_ACTIONS: readonly SkillCaseAction[] = [
  "investigate",
  "rerun",
  "prune-candidate",
  "review",
];

// Deliberately NOT the instructionAction mapping: an instruction rule is a deletable line, so
// prune and redundant both map to "delete" there. A skill is not deletable from a run report -
// its no-op maps to prune-candidate (surface, verify cross-model, then decide) and redundancy to
// review (a consolidation question about the loadout, not this skill's existence).
export function skillCaseAction(result: CaseResult): SkillCaseAction {
  if (result.loadout !== undefined) {
    switch (result.loadout.verdict) {
      case "load-bearing":
        return "keep";
      case "prune":
        return "prune-candidate";
      case "redundant":
        return "review";
      case "interference":
        return "review";
      case "inconclusive":
        return result.inconclusive ? "rerun" : "investigate";
    }
  }
  if (result.inconclusive) return "rerun";
  if (!result.pass) return "investigate";
  if (result.noop) return "prune-candidate";
  const baseline = result.arms.find((arm) => arm.arm === "baseline");
  if (baseline !== undefined && armState(baseline) === "fail") return "keep";
  return "ok";
}

export interface HtmlReportContext {
  readonly generatedAt: string;
  readonly reportPath: string;
  // "latest" renders the alias page (Latest run is the active tab); "archive" renders a hash-named
  // immutable report, which must not claim to be the latest - it gets a "This run (archived)" tab
  // with Latest run as a live link. Defaults to "latest".
  readonly variant?: "archive" | "latest";
}

export function renderHtmlReport(report: RunReport, context: HtmlReportContext): string {
  const findings = allFindings(report);
  const actionable = findings.filter(
    ({ finding }) => finding.action === "delete" || finding.action === "review",
  );
  const counts = countActions(findings.map(({ finding }) => finding));
  const skillActions = renderSkillActions(report);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>skillval report</title>
<style>${STYLES}${TERM_STYLES}</style>
</head>
<body>
<header class="page-head">
  <div class="brand">skillval</div>
  <h1>Evaluation report</h1>
  <p class="meta">
    ${escapeHtml(report.executor.name)} ${escapeHtml(report.executor.version)}
    &middot; model ${escapeHtml(report.executor.model)}
    &middot; thinking ${escapeHtml(report.executor.thinking)}
    &middot; ${escapeHtml(context.generatedAt)}
  </p>
  ${renderReportNav(context.variant === "archive" ? "run-archive" : "run")}
</header>

${renderPrimer()}

<section class="summary">
  ${statTile("Delete", counts.delete, "delete")}
  ${statTile("Review", counts.review, "review")}
  ${statTile("Keep", counts.keep, "keep")}
  ${statTile("Investigate", counts.investigate, "investigate")}
</section>

${skillActions.panel}
${renderActionList(actionable)}
${renderTargets(report)}
${renderSkills(report)}

<footer class="page-foot">
  <p>Raw JSON: <code>${escapeHtml(context.reportPath)}</code></p>
  <p>Every finding is backed by its arm results: <strong>group</strong> is the whole file,
     <strong>peers</strong> is the file with that one rule removed, <strong>solo</strong> is the rule alone.</p>
</footer>
${skillActions.popovers}
${renderTermPanels()}
</body>
</html>
`;
}

// The 20-second refresher: collapsed by default, re-teaches the comparison model at the top of the
// page for a reader who has forgotten how skillval decides.
function renderPrimer(): string {
  return `<details class="primer"><summary>How skillval decides - 20-second refresher</summary>
<div class="primer-body">
<p>Each case runs the same prompt in isolated ${termButton("arm", "arms")}:
${termButton("solo")} has the skill installed, ${termButton("baseline")} has no skill at all
(group mode adds group and peers arms).</p>
<p>An arm's pass/fail is a majority vote over its ${termButton("trial", "trials")} - 1 to 5,
escalating on disagreement; infrastructure trials never vote.</p>
<p>The verdict is a comparison between arms: a pass with a failing baseline is
${termButton("load-bearing")}; a pass with a passing baseline is a ${termButton("no-op")}
(prune candidate); a case whose deciding arm was never graded is ${termButton("inconclusive")}.
Every dotted term on this page opens a refresher.</p>
</div></details>`;
}

interface SkillCaseCard {
  readonly action: SkillCaseAction;
  readonly result: CaseResult;
  readonly skillName: string;
}

// The skills remediation panel plus its per-case evidence popovers (appended before </body>).
function renderSkillActions(report: RunReport): {
  readonly panel: string;
  readonly popovers: string;
} {
  const cards: SkillCaseCard[] = [];
  for (const [skillName, skill] of Object.entries(report.skills)) {
    for (const result of skill.cases) {
      const action = skillCaseAction(result);
      if (CARDED_ACTIONS.includes(action)) cards.push({ action, result, skillName });
    }
  }
  if (cards.length === 0) return { panel: "", popovers: "" };
  cards.sort((a, b) => CARDED_ACTIONS.indexOf(a.action) - CARDED_ACTIONS.indexOf(b.action));

  const items = cards.map((card, index) => renderSkillCard(card, `case-${index + 1}`)).join("\n");
  const popovers = cards
    .map((card, index) => renderCasePopover(card, `case-${index + 1}`))
    .join("\n");
  const panel = `<section class="panel">
  <h2>What to change - skills</h2>
  <p class="lede">${cards.length} case${cards.length === 1 ? "" : "s"} need attention. Each card explains the causal chain behind its action.</p>
  <ul class="action-list">
${items}
  </ul>
</section>`;
  return { panel, popovers };
}

function renderSkillCard(card: SkillCaseCard, popoverId: string): string {
  const { action, result, skillName } = card;
  const where = `${skillName} / ${result.id}${result.rule === undefined ? "" : ` / ${result.rule}`}`;
  // A group-inconclusive verdict can be caused by a consulted arm (solo or peers) while the
  // deciding group arm passed, so its evidence spans every arm; other actions point at the
  // deciding arm, whose checks produced the verdict.
  const inconclusiveLoadout = result.loadout?.verdict === "inconclusive";
  const arm = decidingArm(result);
  const checks = inconclusiveLoadout
    ? result.arms.flatMap((candidate) => failingChecks(candidate)).slice(0, 3)
    : arm === undefined
      ? []
      : failingChecks(arm);
  const evidence = checks
    .map(
      (check) =>
        `<pre class="span"><code>${escapeHtml(check.name)}: ${escapeHtml(check.detail)}</code></pre>`,
    )
    .join("\n  ");
  return `<li class="action-item action-${action}">
  <div class="action-head">
    ${skillBadge(action)}
    <code class="where">${escapeHtml(where)}</code>
  </div>
  <p class="why">${skillCaseReason(card)}</p>
  ${evidence}
  <button class="qv-open" popovertarget="${popoverId}" type="button" aria-label="Full evidence for ${escapeHtml(where)}">Full evidence</button>
</li>`;
}

// The reason sentence teaches the causal chain, with each load-bearing term opening its quick-view.
// Returned as HTML (term buttons included); every dynamic value inside is already escaped.
function skillCaseReason(card: SkillCaseCard): string {
  const { action, result } = card;
  if (action === "rerun") {
    return `Every ${termButton("trial")} of the deciding ${termButton("arm")} hit an infrastructure failure (output overflow or timeout), leaving the case ${termButton("inconclusive")}. Nothing was graded or cached - rerun to grade fresh.`;
  }
  if (action === "prune-candidate") {
    return result.loadout === undefined
      ? `Both arms passed: ${termButton("baseline")} produced the behavior without the skill - a ${termButton("no-op")} on this model. Verify on a second model before pruning.`
      : `${termButton("peers")} passed without this skill - a ${termButton("no-op")} within this loadout.`;
  }
  if (action === "review") {
    return result.loadout?.verdict === "interference"
      ? `Works alone but the loadout breaks it - ${termButton("interference")} between this skill and the rest of the loadout.`
      : `${termButton("peers")} already produce this behavior - this skill is ${termButton("redundant")} within the loadout.`;
  }
  if (result.loadout === undefined && !result.pass && result.noop) {
    return `${termButton("solo")} failed while ${termButton("baseline")} passed. Read the evidence: either the assert is mis-keyed for what the model actually wrote (see the got: snippet) or the skill is hurting.`;
  }
  if (result.loadout?.verdict === "inconclusive") {
    // The group arm may well have PASSED here: the verdict is inconclusive because the arm
    // pattern does not decide, or a consulted arm (solo, peers) was never graded.
    return `The ${termButton("arm", "arms")} did not form a conclusive pattern - or a consulted arm (${termButton("solo")} or ${termButton("peers")}) was never graded - so no verdict stands. Open the full evidence and read each arm's state.`;
  }
  return `The deciding ${termButton("arm")} failed its checks. Read the failing check's evidence before blaming the skill - a too-strict pattern fails exactly the same way.`;
}

// The arm whose result decides the case: group in group mode, solo otherwise.
function decidingArm(result: CaseResult): ArmResult | undefined {
  const wanted: RuntimeArm = result.loadout === undefined ? "solo" : "group";
  return result.arms.find((arm) => arm.arm === wanted) ?? result.arms[0];
}

function failingChecks(arm: ArmResult): readonly Check[] {
  return arm.trials
    .flatMap((trial) => trial.checks)
    .filter((check) => !check.pass)
    .slice(0, 3);
}

// The full-evidence popover for one carded case: every arm, every trial, every check.
function renderCasePopover(card: SkillCaseCard, popoverId: string): string {
  const arms = card.result.arms
    .map((arm) => {
      const state = armState(arm);
      const stateText = state === "infra" ? "infra" : state === "pass" ? "pass" : "FAIL";
      const cached = arm.cached ? " (cached)" : "";
      const trials = arm.trials
        .map((trial, index) => {
          if (trial.checks.length === 0)
            return `<p class="qv-note">trial ${index + 1}: no checks recorded</p>`;
          const rows = trial.checks
            .map(
              (check) =>
                `<tr><td><code>${escapeHtml(check.name)}</code></td><td>${check.pass ? "pass" : "fail"}</td><td>${escapeHtml(check.detail)}</td></tr>`,
            )
            .join("\n");
          return `<table class="qv-checks">
  <caption>trial ${index + 1}</caption>
  <thead><tr><th>Check</th><th>Result</th><th>Detail</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>`;
        })
        .join("\n");
      return `<h4 class="qv-arm">${escapeHtml(arm.arm)} - ${stateText}${cached}</h4>
${trials === "" ? '<p class="qv-note">no trials recorded</p>' : trials}`;
    })
    .join("\n");
  return `<aside id="${popoverId}" class="quickview" popover role="dialog" aria-labelledby="${popoverId}-title">
  <header><span class="qv-kicker">evidence</span><h3 id="${popoverId}-title">${escapeHtml(`${card.skillName} / ${card.result.id}`)}</h3></header>
${arms}
  <button class="qv-close" popovertarget="${popoverId}" popovertargetaction="hide" type="button" autofocus>Close</button>
</aside>`;
}

function renderActionList(
  actionable: readonly { readonly finding: InstructionFinding; readonly targetId: string }[],
): string {
  if (actionable.length === 0) {
    return `<section class="panel">
  <h2>What to change</h2>
  <p class="empty">Nothing to change - no rule was flagged for deletion or review.</p>
</section>`;
  }

  const items = actionable
    .map(({ finding, targetId }) => {
      const reason =
        finding.verdict === "n/a"
          ? escapeHtml(finding.naReason ?? "not applicable to this executor")
          : escapeHtml(FINDING_REASON[finding.verdict]);
      return `<li class="action-item action-${finding.action}">
  <div class="action-head">
    ${badge(finding.action)}
    <code class="where">${escapeHtml(targetId)}${finding.file === "" ? "" : ` / ${escapeHtml(finding.file)}`}</code>
  </div>
  <pre class="span"><code>${escapeHtml(finding.span)}</code></pre>
  <p class="why">${reason}</p>
  ${armChips(finding)}
</li>`;
    })
    .join("\n");

  return `<section class="panel">
  <h2>What to change</h2>
  <p class="lede">${actionable.length} rule${actionable.length === 1 ? "" : "s"} need attention. Each shows the exact span to act on.</p>
  <ul class="action-list">
${items}
  </ul>
</section>`;
}

function renderTargets(report: RunReport): string {
  const targets = Object.values(report.instructions ?? {});
  if (targets.length === 0) return "";

  const sections = targets
    .map((target) => {
      const rows = target.findings
        .map((finding) => {
          const verdict =
            finding.verdict === "n/a"
              ? `<span class="verdict na">n/a</span><span class="na-reason">${escapeHtml(finding.naReason ?? "")}</span>`
              : `<span class="verdict">${escapeHtml(finding.verdict)}</span>`;
          return `<tr>
  <td><code>${escapeHtml(finding.caseId)}</code></td>
  <td>${finding.file === "" ? "-" : `<code>${escapeHtml(finding.file)}</code>`}</td>
  <td>${verdict}</td>
  <td>${badge(finding.action)}</td>
  <td>${armChips(finding)}</td>
</tr>`;
        })
        .join("\n");
      return `<article class="target">
  <h3><code>${escapeHtml(target.id)}</code></h3>
  <p class="path">${escapeHtml(target.directory)}</p>
  <div class="table-scroll">
  <table>
    <thead><tr><th>Case</th><th>File</th><th>Verdict</th><th>Action</th><th>Arms</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
  </div>
</article>`;
    })
    .join("\n");

  return `<section class="panel">
  <h2>Instruction files</h2>
${sections}
</section>`;
}

function renderSkills(report: RunReport): string {
  const names = Object.keys(report.skills);
  if (names.length === 0) return "";

  const rows = names
    .flatMap((name) => {
      const skill = report.skills[name];
      if (skill === undefined) return [];
      return skill.cases.map((result) => {
        const arms = result.arms.map((arm) => chip(arm.arm, armState(arm))).join("");
        return `<tr>
  <td><code>${escapeHtml(name)}</code></td>
  <td><code>${escapeHtml(result.id)}</code></td>
  <td>${skillVerdictCell(result)}${result.noop ? termButton("no-op", "no-op") : ""}</td>
  <td><div class="arms">${arms}</div></td>
</tr>`;
      });
    })
    .join("\n");

  return `<section class="panel">
  <h2>Skills</h2>
  <div class="table-scroll">
  <table>
    <thead><tr><th>Skill</th><th>Case</th><th>Result</th><th>Arms</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
  </div>
</section>`;
}

// The verdict word opens its quick-view when it is a glossary term; plain pass/FAIL stay text.
function skillVerdictCell(result: CaseResult): string {
  if (result.loadout === undefined) {
    if (result.inconclusive) return `<span class="verdict">${termButton("inconclusive")}</span>`;
    return `<span class="verdict">${result.pass ? "pass" : "FAIL"}</span>`;
  }
  const verdict = result.loadout.verdict;
  const button = verdict === "prune" ? termButton("prune-candidate", "prune") : termButton(verdict);
  return `<span class="verdict">${button}</span>`;
}

function allFindings(
  report: RunReport,
): readonly { readonly finding: InstructionFinding; readonly targetId: string }[] {
  return Object.values(report.instructions ?? {}).flatMap((target) =>
    target.findings.map((finding) => ({ finding, targetId: target.id })),
  );
}

function countActions(findings: readonly InstructionFinding[]): Record<InstructionAction, number> {
  const counts: Record<InstructionAction, number> = {
    delete: 0,
    investigate: 0,
    keep: 0,
    review: 0,
  };
  for (const finding of findings) counts[finding.action] += 1;
  return counts;
}

function statTile(label: string, value: number, tone: string): string {
  return `<div class="tile tone-${tone}">
  <div class="tile-value">${value}</div>
  <div class="tile-label">${escapeHtml(label)}</div>
</div>`;
}

function badge(action: InstructionAction): string {
  return `<span class="badge badge-${action}">${escapeHtml(ACTION_LABEL[action])}</span>`;
}

function skillBadge(action: SkillCaseAction): string {
  return `<span class="badge badge-${action}">${escapeHtml(SKILL_ACTION_LABEL[action])}</span>`;
}

function armChips(finding: InstructionFinding): string {
  if (finding.arms.length === 0)
    return '<div class="arms"><span class="chip chip-idle">no arms run</span></div>';
  return `<div class="arms">${finding.arms.map((arm) => chip(arm.arm, armState(arm))).join("")}</div>`;
}

// An infra arm was never graded, so its chip says so instead of masquerading as a content fail.
function chip(name: string, state: "fail" | "infra" | "pass"): string {
  if (state === "infra") return `<span class="chip chip-infra">${escapeHtml(name)} infra</span>`;
  return `<span class="chip ${state === "pass" ? "chip-pass" : "chip-fail"}">${escapeHtml(name)} ${state}</span>`;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const STYLES = `
:root {
  --bg: #fbfaf8; --surface: #fff; --line: #e6e2dc; --ink: #1c1b19; --muted: #6b6660;
  --accent: #7c4dff; --keep: #1f8a52; --delete: #c2410c; --review: #b45309; --idle: #6b6660;
  --warn: #d97706;
  --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #14130f; --surface: #1c1b17; --line: #2e2c26; --ink: #f2efe9; --muted: #a09a91;
    --keep: #4ade80; --delete: #fb923c; --review: #fbbf24; --idle: #a09a91; --warn: #f59e0b; }
}
* { box-sizing: border-box; }
body { margin: 0; padding: 2rem 1.25rem 4rem; background: var(--bg); color: var(--ink);
  font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
  max-width: 62rem; margin-inline: auto; }
.page-head { border-bottom: 1px solid var(--line); padding-bottom: 0; margin-bottom: 1.5rem; }
.brand { font-family: var(--mono); font-size: .8rem; letter-spacing: .12em; text-transform: uppercase;
  color: var(--accent); font-weight: 600; }
h1 { font-size: 1.85rem; margin: .35rem 0 .4rem; letter-spacing: -.02em; }
h2 { font-size: 1.15rem; margin: 0 0 .9rem; letter-spacing: -.01em; }
h3 { font-size: 1rem; margin: 0 0 .15rem; }
.meta, .path { color: var(--muted); font-size: .88rem; margin: 0; }
.lede { color: var(--muted); margin: -.4rem 0 1rem; font-size: .93rem; }
.summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr)); gap: .75rem;
  margin-bottom: 1.75rem; }
.tile { background: var(--surface); border: 1px solid var(--line); border-radius: .6rem;
  padding: .9rem 1rem; }
.tile-value { font-size: 1.7rem; font-weight: 650; line-height: 1; }
.tile-label { color: var(--muted); font-size: .82rem; margin-top: .3rem; }
.tone-delete .tile-value { color: var(--delete); }
.tone-review .tile-value { color: var(--review); }
.tone-keep .tile-value { color: var(--keep); }
.panel { background: var(--surface); border: 1px solid var(--line); border-radius: .7rem;
  padding: 1.25rem; margin-bottom: 1.5rem; }
.empty { color: var(--muted); margin: 0; }
.action-list { list-style: none; margin: 0; padding: 0; display: grid; gap: .9rem; }
.action-item { border: 1px solid var(--line); border-left: 3px solid var(--idle);
  border-radius: .5rem; padding: .9rem 1rem; background: var(--bg); }
.action-delete { border-left-color: var(--delete); }
.action-review { border-left-color: var(--review); }
.action-investigate { border-left-color: var(--warn); }
.action-rerun { border-left-color: var(--idle); }
.action-prune-candidate { border-left-color: var(--delete); }
.action-head { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; margin-bottom: .6rem; }
.where { color: var(--muted); font-size: .85rem; }
.span { margin: 0 0 .6rem; padding: .7rem .85rem; background: var(--surface);
  border: 1px solid var(--line); border-radius: .4rem; overflow-x: auto; }
.span code { font-family: var(--mono); font-size: .85rem; white-space: pre-wrap; word-break: break-word; }
.why { margin: 0 0 .6rem; font-size: .92rem; }
.badge { font-size: .72rem; font-weight: 650; letter-spacing: .04em; text-transform: uppercase;
  padding: .2rem .5rem; border-radius: .3rem; border: 1px solid currentColor; }
.badge-delete { color: var(--delete); }
.badge-review { color: var(--review); }
.badge-keep { color: var(--keep); }
.badge-investigate { color: var(--warn); }
.badge-rerun { color: var(--muted); }
.badge-prune-candidate { color: var(--delete); }
.arms { display: flex; gap: .35rem; flex-wrap: wrap; }
.chip { font-family: var(--mono); font-size: .74rem; padding: .16rem .45rem; border-radius: .3rem;
  border: 1px solid var(--line); color: var(--muted); white-space: nowrap; }
.chip-pass { color: var(--keep); border-color: currentColor; }
.chip-fail { color: var(--delete); border-color: currentColor; }
.chip-infra { color: var(--review); border-color: currentColor; }
.target { padding-top: 1rem; margin-top: 1rem; border-top: 1px solid var(--line); }
.target:first-of-type { border-top: 0; margin-top: 0; padding-top: 0; }
.table-scroll { overflow-x: auto; margin-top: .75rem; }
table { border-collapse: collapse; width: 100%; font-size: .9rem; }
th, td { text-align: left; padding: .5rem .6rem; border-bottom: 1px solid var(--line);
  vertical-align: top; }
th { font-size: .76rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted);
  font-weight: 600; }
code { font-family: var(--mono); font-size: .85em; }
.verdict { font-size: .85rem; }
.na, .na-reason { color: var(--muted); }
.na-reason { display: block; font-size: .78rem; margin-top: .15rem; }
.page-foot { color: var(--muted); font-size: .84rem; border-top: 1px solid var(--line);
  padding-top: 1rem; }
.page-foot code { word-break: break-all; }
.qv-open { margin-top: .2rem; font: inherit; font-size: .85rem; color: var(--muted);
  background: none; border: 1px solid var(--line); border-radius: .4rem; padding: .3rem .8rem;
  cursor: pointer; }
.qv-open:hover { color: var(--ink); }
.qv-open:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.qv-arm { margin: 1.1rem 0 .3rem; font-size: .95rem; }
.qv-checks { margin: .3rem 0 .8rem; font-size: .8rem; }
.qv-checks caption { caption-side: top; text-align: left; font-family: var(--mono);
  font-size: .72rem; color: var(--muted); padding-bottom: .25rem; }
.qv-checks td { word-break: break-word; }
.qv-note { color: var(--muted); font-size: .84rem; margin: .2rem 0 .6rem; }
`;
