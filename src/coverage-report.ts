/** Renders the eval-coverage matrix as one self-contained HTML page, matching the run report's design. */
import type { CaseCoverage, CoverageReport, GraderRung, SkillCoverage } from "./coverage.js";
import { RUNG_ORDER } from "./coverage.js";
import { escapeHtml } from "./html-report.js";

// What each rung proves, worded for the segment tooltips and the legend. The ladder comes from the
// skillval-coverage skill: presence -> lexical output -> runtime behavior.
const RUNG_LABEL: Record<GraderRung, string> = {
  execution: "execution",
  regex: "regex",
  trigger: "trigger-only",
};
const RUNG_MEANING: Record<GraderRung, string> = {
  execution: "Runtime behavior, proven by command_exit / json_schema / tsc.",
  regex: "Lexical presence in the output; a comment can satisfy it.",
  trigger: "Proves the skill loads when it should; says nothing about what it changes.",
};

export interface CoverageReportContext {
  readonly generatedAt: string;
}

export function renderCoverageReport(
  report: CoverageReport,
  context: CoverageReportContext,
): string {
  const behavioral = report.counts.regex + report.counts.execution;
  const behavioralShare =
    report.caseCount === 0 ? 0 : Math.round((100 * behavioral) / report.caseCount);
  const missingBehavioral = report.skillsWithoutBehavioralCases;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>skillval coverage</title>
<style>${STYLES}</style>
</head>
<body>
<header class="page-head">
  <div class="brand">skillval</div>
  <h1>Eval coverage across every discoverable skill</h1>
  <p class="meta">
    ${report.skillCount} skills &middot; grader rungs: trigger-only &rarr; regex &rarr; execution
    &middot; ${escapeHtml(context.generatedAt)}
  </p>
</header>

<div class="tiles">
  <div class="tile"><b>${report.skillCount}</b><span>ready skills</span></div>
  <div class="tile"><b>${report.caseCount}</b><span>eval cases</span></div>
  <div class="tile t-trigger"><b>${report.counts.trigger}</b><span>trigger-only cases</span></div>
  <div class="tile t-regex"><b>${report.counts.regex}</b><span>regex-graded cases</span></div>
  <div class="tile t-execution"><b>${report.counts.execution}</b><span>execution-graded cases</span></div>
  <div class="tile"><b>${behavioralShare}%</b><span>cases with a behavioral grader</span></div>
</div>

<section class="overall">
  <h2>All ${report.caseCount} cases by grader rung</h2>
  ${compositionBar(report.counts, report.caseCount)}
  <div class="legend">
    <span class="l-trigger"><i></i>trigger-only (${report.counts.trigger}) - ${escapeHtml(RUNG_MEANING.trigger)}</span>
    <span class="l-regex"><i></i>regex (${report.counts.regex}) - ${escapeHtml(RUNG_MEANING.regex)}</span>
    <span class="l-execution"><i></i>execution (${report.counts.execution}) - ${escapeHtml(RUNG_MEANING.execution)}</span>
  </div>
  <p class="note">
    ${report.skillsWithBaselineComparison} of ${report.skillCount} skills compare against a baseline arm
    on at least one behavioral case &middot;
    ${
      report.skillsWithoutNegativeTrigger.length === 0
        ? "every skill ships at least one negative trigger case (no thin boundaries)"
        : `${report.skillsWithoutNegativeTrigger.length} skill(s) without a negative trigger case: ${report.skillsWithoutNegativeTrigger.map((name) => `<code>${escapeHtml(name)}</code>`).join(", ")}`
    } &middot;
    ${
      missingBehavioral.length === 0
        ? "every skill has at least one behavioral case"
        : `${missingBehavioral.length} skill(s) with zero behavioral cases: ${missingBehavioral.map((name) => `<code>${escapeHtml(name)}</code>`).join(", ")}`
    }
  </p>
</section>

${report.groups.map(renderGroup).join("\n")}

<footer class="page-foot">
  <p>Within each group, skills sort weakest-coverage-first (behavioral share, then suite size).
  The t / r / x column is the per-rung case count. Expand a skill for its case-level graders.
  Source of truth: each skill's <code>skillval.yml</code>.</p>
</footer>
</body>
</html>
`;
}

function renderGroup(group: {
  readonly caseCount: number;
  readonly label: string;
  readonly root: string;
  readonly skills: readonly SkillCoverage[];
}): string {
  return `<section class="group">
<h2>${escapeHtml(group.label)} <span class="g-meta">${group.skills.length} skills &middot; ${group.caseCount} cases</span></h2>
<p class="g-root">${escapeHtml(group.root)}</p>
<div class="col-head" aria-hidden="true"><span>skill</span><span>class</span><span>cases</span><span>composition</span><span>t / r / x</span><span>behavioral</span></div>
${group.skills.map(renderSkill).join("\n")}
</section>`;
}

function renderSkill(skill: SkillCoverage): string {
  const total = skill.cases.length;
  const share = total === 0 ? 0 : Math.round((100 * skill.behavioral) / total);
  return `<details class="skill">
<summary>
  <span class="s-name"><code>${escapeHtml(skill.name)}</code></span>
  <span class="s-class">${skill.class}</span>
  <span class="s-count">${total}</span>
  ${compositionBar(skill.counts, total)}
  <span class="s-mix">${skill.counts.trigger} / ${skill.counts.regex} / ${skill.counts.execution}</span>
  <span class="s-beh">${share}%</span>
</summary>
<div class="detail">
<div class="table-scroll">
<table>
<thead><tr><th>Case</th><th>Mode</th><th>Type</th><th>Graders</th><th>Arms</th><th class="num">Trials</th></tr></thead>
<tbody>
${skill.cases.map(renderCase).join("\n")}
</tbody>
</table>
</div>
</div>
</details>`;
}

function renderCase(item: CaseCoverage): string {
  const chips =
    item.graders.length === 0
      ? '<span class="chip chip-trigger">trigger only</span>'
      : item.graders
          .map((label) => `<span class="chip chip-${chipRung(label)}">${escapeHtml(label)}</span>`)
          .join("");
  return `<tr>
  <td><code>${escapeHtml(item.id)}</code></td>
  <td>${item.mode}</td>
  <td>${item.type ?? "-"}</td>
  <td class="chips-cell">${chips}</td>
  <td>${item.baseline ? "solo+baseline" : "solo"}</td>
  <td class="num">${item.trials}</td>
</tr>`;
}

function chipRung(label: string): GraderRung {
  if (label.startsWith("should_trigger")) return "trigger";
  if (label.startsWith("must_")) return "regex";
  return "execution";
}

// The stacked composition bar. Each segment carries a hover/focus tooltip naming its rung, its
// share, and what the rung proves - the bar is readable without the legend.
function compositionBar(counts: Readonly<Record<GraderRung, number>>, total: number): string {
  if (total === 0) return '<div class="bar bar-empty" aria-label="no cases"></div>';
  const segments = RUNG_ORDER.filter((rung) => counts[rung] > 0)
    .map((rung) => {
      const count = counts[rung];
      const tip = `${RUNG_LABEL[rung]} - ${count} of ${total} case${total === 1 ? "" : "s"} (${Math.round((100 * count) / total)}%). ${RUNG_MEANING[rung]}`;
      return `<span class="seg seg-${rung}" style="flex-grow:${count}" tabindex="0" role="img" aria-label="${escapeHtml(tip)}" data-tip="${escapeHtml(tip)}"></span>`;
    })
    .join("");
  return `<div class="bar">${segments}</div>`;
}

const STYLES = `
:root {
  --bg: #fbfaf8; --surface: #fff; --line: #e6e2dc; --ink: #1c1b19; --muted: #6b6660;
  --accent: #7c4dff; --r-trigger: #b45309; --r-regex: #7c4dff; --r-execution: #1f8a52;
  --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #14130f; --surface: #1c1b17; --line: #2e2c26; --ink: #f2efe9; --muted: #a09a91;
    --r-trigger: #cf7228; --r-regex: #9a75ff; --r-execution: #37a066; }
}
* { box-sizing: border-box; }
body { margin: 0 auto; padding: 2.5rem 1.25rem 4rem; max-width: 72rem; background: var(--bg);
  color: var(--ink); font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
.page-head { border-bottom: 1px solid var(--line); padding-bottom: 1.2rem; margin-bottom: 1.4rem; }
.brand { font-family: var(--mono); font-size: .78rem; letter-spacing: .12em; text-transform: uppercase;
  color: var(--accent); font-weight: 600; }
h1 { font-size: 1.7rem; margin: .3rem 0 .35rem; letter-spacing: -.02em; text-wrap: balance; }
.meta { color: var(--muted); font-size: .86rem; margin: 0; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr)); gap: .7rem;
  margin: 1.4rem 0; }
.tile { background: var(--surface); border: 1px solid var(--line); border-radius: .55rem;
  padding: .85rem .95rem; }
.tile b { display: block; font-size: 1.65rem; font-weight: 650; line-height: 1.15;
  font-variant-numeric: tabular-nums; }
.tile span { color: var(--muted); font-size: .8rem; }
.tile.t-trigger b { color: var(--r-trigger); }
.tile.t-regex b { color: var(--r-regex); }
.tile.t-execution b { color: var(--r-execution); }
.overall { background: var(--surface); border: 1px solid var(--line); border-radius: .65rem;
  padding: 1.05rem 1.15rem 1.15rem; margin-bottom: 1.6rem; }
.overall h2 { margin: 0 0 .65rem; font-size: 1rem; }
.bar { display: flex; gap: 2px; height: 14px; flex: 1; min-width: 7rem; }
.bar-empty { background: var(--line); border-radius: 4px; }
.seg { min-width: 3px; position: relative; }
.seg:first-child { border-radius: 4px 0 0 4px; }
.seg:last-child { border-radius: 0 4px 4px 0; }
.seg:only-child { border-radius: 4px; }
.seg-trigger { background: var(--r-trigger); }
.seg-regex { background: var(--r-regex); }
.seg-execution { background: var(--r-execution); }
.seg:hover::after, .seg:focus-visible::after {
  content: attr(data-tip); position: absolute; bottom: calc(100% + 8px); left: 50%;
  transform: translateX(-50%); z-index: 6; width: max-content; max-width: 17rem;
  background: var(--ink); color: var(--bg); font-size: .78rem; line-height: 1.4;
  padding: .45rem .6rem; border-radius: .4rem; white-space: normal; pointer-events: none;
  box-shadow: 0 2px 10px rgba(0, 0, 0, .25); }
.seg:hover::before, .seg:focus-visible::before {
  content: ""; position: absolute; bottom: calc(100% + 3px); left: 50%;
  transform: translateX(-50%); z-index: 6; border: 5px solid transparent;
  border-top-color: var(--ink); border-bottom: 0; pointer-events: none; }
.seg:first-child::after { left: 0; transform: none; }
.seg:last-child::after { left: auto; right: 0; transform: none; }
.seg:only-child::after { left: 0; right: auto; transform: none; }
.seg:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.overall .bar { height: 20px; }
.legend { display: flex; gap: 1.1rem; flex-wrap: wrap; margin-top: .6rem; font-size: .83rem;
  color: var(--muted); }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 3px;
  margin-right: .35rem; }
.legend .l-trigger i { background: var(--r-trigger); }
.legend .l-regex i { background: var(--r-regex); }
.legend .l-execution i { background: var(--r-execution); }
.note { color: var(--muted); font-size: .85rem; margin: .55rem 0 0; }
.group { margin-bottom: 1.9rem; }
.group h2 { font-size: 1.08rem; margin: 0 0 .1rem; }
.g-meta { color: var(--muted); font-weight: 400; font-size: .84rem; margin-left: .4rem; }
.g-root { color: var(--muted); font-family: var(--mono); font-size: .74rem; margin: 0 0 .5rem; }
.col-head, summary { display: grid;
  grid-template-columns: minmax(11rem, 1.25fr) 6rem 3rem minmax(8rem, 1fr) 5.5rem 5rem;
  gap: .9rem; align-items: center; }
.col-head { font-size: .72rem; text-transform: uppercase; letter-spacing: .07em;
  color: var(--muted); padding: .25rem .85rem; }
details.skill { background: var(--surface); border: 1px solid var(--line); border-radius: .5rem;
  margin-bottom: .45rem; }
summary { padding: .55rem .85rem; cursor: pointer; list-style: none; }
summary::-webkit-details-marker { display: none; }
summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: .5rem; }
.s-name code { font-family: var(--mono); font-size: .85rem; font-weight: 600; }
.s-class { font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; color: var(--muted);
  border: 1px solid var(--line); border-radius: .3rem; padding: .1rem .4rem; text-align: center; }
.s-count, .s-mix, .s-beh { font-variant-numeric: tabular-nums; font-size: .85rem; }
.s-count { text-align: right; padding-right: .4rem; }
.s-mix { color: var(--muted); font-family: var(--mono); font-size: .78rem; }
.s-beh { text-align: right; color: var(--muted); }
.detail { border-top: 1px solid var(--line); padding: .7rem .85rem .85rem; }
.table-scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: .85rem; }
th, td { text-align: left; padding: .4rem .55rem; border-bottom: 1px solid var(--line);
  vertical-align: top; }
th { font-size: .71rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted);
  font-weight: 600; }
tr:last-child td { border-bottom: 0; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
code { font-family: var(--mono); font-size: .92em; }
.chip { display: inline-block; font-family: var(--mono); font-size: .72rem; padding: .1rem .4rem;
  border: 1px solid; border-radius: .3rem; margin: .06rem .18rem .06rem 0; white-space: nowrap; }
.chip-trigger { color: var(--r-trigger); }
.chip-regex { color: var(--r-regex); }
.chip-execution { color: var(--r-execution); }
.chips-cell { min-width: 14rem; }
.page-foot { color: var(--muted); font-size: .82rem; border-top: 1px solid var(--line);
  padding-top: 1rem; margin-top: 2rem; }
@media (max-width: 44rem) {
  .col-head, summary { grid-template-columns: 1fr 3rem minmax(6rem, 1fr); }
  .s-class, .s-mix, .s-beh { display: none; }
  .col-head span:nth-child(2), .col-head span:nth-child(5), .col-head span:nth-child(6) { display: none; }
}
`;
