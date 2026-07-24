/** Renders a run report as one self-contained HTML page: what to change, why, and the evidence. */
import type { InstructionAction, InstructionFinding, RunReport } from "./runner.js";
import type { Verdict } from "./verdict.js";

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

export interface HtmlReportContext {
  readonly generatedAt: string;
  readonly reportPath: string;
}

export function renderHtmlReport(report: RunReport, context: HtmlReportContext): string {
  const findings = allFindings(report);
  const actionable = findings.filter(
    ({ finding }) => finding.action === "delete" || finding.action === "review",
  );
  const counts = countActions(findings.map(({ finding }) => finding));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>skillval report</title>
<style>${STYLES}</style>
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
</header>

<section class="summary">
  ${statTile("Delete", counts.delete, "delete")}
  ${statTile("Review", counts.review, "review")}
  ${statTile("Keep", counts.keep, "keep")}
  ${statTile("Investigate", counts.investigate, "investigate")}
</section>

${renderActionList(actionable)}
${renderTargets(report)}
${renderSkills(report)}

<footer class="page-foot">
  <p>Raw JSON: <code>${escapeHtml(context.reportPath)}</code></p>
  <p>Every finding is backed by its arm results: <strong>group</strong> is the whole file,
     <strong>peers</strong> is the file with that one rule removed, <strong>solo</strong> is the rule alone.</p>
</footer>
</body>
</html>
`;
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
        const arms = result.arms.map((arm) => chip(arm.arm, arm.pass)).join("");
        const verdict =
          result.loadout === undefined ? (result.pass ? "pass" : "FAIL") : result.loadout.verdict;
        return `<tr>
  <td><code>${escapeHtml(name)}</code></td>
  <td><code>${escapeHtml(result.id)}</code></td>
  <td><span class="verdict">${escapeHtml(verdict)}</span>${result.noop ? '<span class="verdict na">no-op</span>' : ""}</td>
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

function armChips(finding: InstructionFinding): string {
  if (finding.arms.length === 0)
    return '<div class="arms"><span class="chip chip-idle">no arms run</span></div>';
  return `<div class="arms">${finding.arms.map((arm) => chip(arm.arm, arm.pass)).join("")}</div>`;
}

function chip(name: string, pass: boolean): string {
  return `<span class="chip ${pass ? "chip-pass" : "chip-fail"}">${escapeHtml(name)} ${pass ? "pass" : "fail"}</span>`;
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
  --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #14130f; --surface: #1c1b17; --line: #2e2c26; --ink: #f2efe9; --muted: #a09a91;
    --keep: #4ade80; --delete: #fb923c; --review: #fbbf24; --idle: #a09a91; }
}
* { box-sizing: border-box; }
body { margin: 0; padding: 2rem 1.25rem 4rem; background: var(--bg); color: var(--ink);
  font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
  max-width: 62rem; margin-inline: auto; }
.page-head { border-bottom: 1px solid var(--line); padding-bottom: 1.25rem; margin-bottom: 1.5rem; }
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
.badge-investigate { color: var(--idle); }
.arms { display: flex; gap: .35rem; flex-wrap: wrap; }
.chip { font-family: var(--mono); font-size: .74rem; padding: .16rem .45rem; border-radius: .3rem;
  border: 1px solid var(--line); color: var(--muted); white-space: nowrap; }
.chip-pass { color: var(--keep); border-color: currentColor; }
.chip-fail { color: var(--delete); border-color: currentColor; }
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
`;
