/**
 * The single source of truth for report terminology, and the no-script quick-view machinery that
 * teaches it. Reports are read weeks apart; the design assumption is a reader who has forgotten how
 * skillval works, so every load-bearing term self-explains at point of use. Both renderers import
 * this module - definitions exist once and cannot drift between pages.
 */
import { escapeHtml } from "./html-report.js";

export interface TermDefinition {
  // What to do with the information - the action a re-taught reader takes.
  readonly act: string;
  // How skillval computes it - the mechanism behind the word.
  readonly how: string;
  readonly title: string;
  // What the word means, in one or two plain sentences.
  readonly what: string;
}

// Keys are stable slugs used in popover ids; titles are the visible words.
export const TERMS = {
  arm: {
    act: "Read a case's arms side by side; every verdict is a comparison between them.",
    how: "Each arm runs the same prompt in a clean workspace with a different set of skills seeded, and is graded by the same checks.",
    title: "arm",
    what: "One isolated run configuration of a case: the same prompt with a particular set of skills installed.",
  },
  baseline: {
    act: "If baseline also passes, the skill did not cause the behavior - see no-op.",
    how: "The same prompt in a clean environment with no skill seeded at all.",
    title: "baseline",
    what: "The control arm: what the model does WITHOUT the skill.",
  },
  execution: {
    act: "The strongest deterministic evidence a case can carry - prefer it for runtime behavior.",
    how: "command_exit runs a grading script against the produced artifact (or json_schema / tsc validate it) and grades on the result.",
    title: "execution",
    what: "A grader rung: the case is decided by running the produced code and asserting what it does.",
  },
  inconclusive: {
    act: "Rerun the case - infrastructure results are never cached, so a rerun grades fresh.",
    how: "Every trial of the deciding arm hit a capture-layer failure (agent output too large, or a timeout), so nothing was graded.",
    title: "inconclusive",
    what: "The case has no content result: not a pass, not a failure, and never a no-op.",
  },
  interference: {
    act: "Review the loadout pairing - the finding is about how the skills combine, not the skill alone.",
    how: "solo passes, group fails, and peers (the loadout minus this skill) still passes - the skill's presence is what breaks the case.",
    title: "interference",
    what: "The skill works alone but breaks when loaded with your other skills.",
  },
  "load-bearing": {
    act: "Keep the rule; it is earning its context window.",
    how: "The with-skill arm passes and the without-skill control fails - removing the skill removes the behavior.",
    title: "load-bearing",
    what: "The skill is doing real work: behavior appears with it and disappears without it.",
  },
  "no-op": {
    act: "Treat as a prune candidate, but verify on a second model first - no-op is per-model.",
    how: "The without-skill control (baseline, or peers in group mode) passed the same behavioral checks.",
    title: "no-op",
    what: "The behavior happens without the skill: the case passes either way, so this rule changed nothing on this model.",
  },
  peers: {
    act: "peers passing while group passes means another skill already covers the behavior (redundant).",
    how: "Group mode seeds the configured loadout minus the skill under test.",
    title: "peers",
    what: "The without-this-skill control in group mode: your other skills, alone.",
  },
  "prune-candidate": {
    act: "Surface it, verify it cross-model, then decide - skillval flags, you prune.",
    how: "A no-op finding: the control arm passed, so the model already does this unaided.",
    title: "prune candidate",
    what: "A rule that looks like dead weight on this model: the behavior no longer needs teaching.",
  },
  redundant: {
    act: "Consider consolidating: another loadout member already teaches this.",
    how: "Both group and peers pass - the behavior survives removing this skill from the loadout.",
    title: "redundant",
    what: "Another skill in the loadout already produces this behavior.",
  },
  regex: {
    act: "Good for lexical conventions; a gap when it proxies runtime behavior - see execution.",
    how: "must_match / must_not_match patterns tested against the agent's output and produced files.",
    title: "regex",
    what: "A grader rung: the case is decided by text patterns - lexical presence, which a comment can satisfy.",
  },
  solo: {
    act: "solo alone proves the skill CAN produce the behavior; only a comparison proves it is needed.",
    how: "The skill under test is seeded into a clean workspace; nothing else is installed.",
    title: "solo",
    what: "The with-skill arm: what the model does with only this skill present.",
  },
  trial: {
    act: "Disagreement between trials is normal model noise; the vote absorbs it.",
    how: "An arm runs its configured trials (1-5); the majority of graded trials decides, and disagreement escalates up to five. Infrastructure failures never vote.",
    title: "trial",
    what: "One spawn of the agent for an arm. An arm's pass/fail is a majority vote over its trials.",
  },
  trigger: {
    act: "Trigger coverage is necessary but weak: it proves loading, not effect - see the grader rungs.",
    how: "The trace is checked for the executor's skill-invocation event (structured for claude and pi, command heuristic for codex). should_trigger: false asserts the skill correctly stayed quiet.",
    title: "trigger",
    what: "Whether the model actually loaded the skill when it should - or stayed quiet when it should not.",
  },
  ungraded: {
    act: "Give the case a grader or delete it - a check that cannot fail is ceremony.",
    how: "The case declares no should_trigger and no assert, so only trace completeness is checked.",
    title: "ungraded",
    what: "A case with no grader at all. It is evidence of nothing.",
  },
};

export type TermKey = keyof typeof TERMS;

// An inline term reference: a real button (keyboard-reachable) that opens the term's quick-view
// sidebar. Visible text defaults to the term's title but can be any inflection of it.
export function termButton(key: TermKey, text?: string): string {
  const term: TermDefinition = TERMS[key];
  return `<button class="term" popovertarget="term-${key}" type="button">${escapeHtml(text ?? term.title)}</button>`;
}

// The quick-view panels, one per term, appended once per page. Native popovers: light-dismiss and
// Esc for free, floated as a right sidebar by the shared styles, and no scripts involved.
export function renderTermPanels(): string {
  return Object.entries(TERMS)
    .map(
      ([
        key,
        term,
      ]) => `<aside id="term-${key}" class="quickview" popover role="dialog" aria-labelledby="term-${key}-title">
  <header><span class="qv-kicker">terminology</span><h3 id="term-${key}-title">${escapeHtml(term.title)}</h3></header>
  <dl>
    <dt>What it means</dt><dd>${escapeHtml(term.what)}</dd>
    <dt>How it is computed</dt><dd>${escapeHtml(term.how)}</dd>
    <dt>What to do</dt><dd>${escapeHtml(term.act)}</dd>
  </dl>
  <button class="qv-close" popovertarget="term-${key}" popovertargetaction="hide" type="button" autofocus>Close</button>
</aside>`,
    )
    .join("\n");
}

// The tab bar shared by the two report pages. Relative links within the reports directory, so it
// works from file:// with no scripts; the active page is a non-link. A hash-named archived run
// must not claim to be the latest: it gets its own "This run" tab, with "Latest run" as a live
// link to the alias.
export function renderReportNav(active: "coverage" | "run" | "run-archive"): string {
  const parts: string[] = [];
  if (active === "run") {
    parts.push('<span class="tab tab-active" aria-current="page">Latest run</span>');
  } else {
    parts.push('<a class="tab" href="latest.html">Latest run</a>');
  }
  if (active === "run-archive") {
    parts.push('<span class="tab tab-active" aria-current="page">This run (archived)</span>');
  }
  if (active === "coverage") {
    parts.push('<span class="tab tab-active" aria-current="page">Coverage</span>');
  } else {
    parts.push('<a class="tab" href="coverage.html">Coverage</a>');
  }
  return `<nav class="tabs" aria-label="report pages">${parts.join("")}</nav>`;
}

// Styles for the nav, the term buttons, and the right-sidebar quick-views. Shared verbatim by both
// renderers so the affordances look identical across tabs.
export const TERM_STYLES = `
.tabs { display: flex; gap: .25rem; margin: 1rem 0 0; }
.tab { font-size: .85rem; font-weight: 600; color: var(--muted); text-decoration: none;
  padding: .35rem .8rem; border: 1px solid var(--line); border-bottom: 0;
  border-radius: .5rem .5rem 0 0; background: transparent; }
.tab:hover { color: var(--ink); }
.tab-active { color: var(--accent); background: var(--surface); position: relative; }
.tab-active::after { content: ""; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px;
  background: var(--surface); }
.term { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: help;
  text-decoration: underline dotted; text-underline-offset: 3px;
  text-decoration-color: var(--accent); }
.term:hover { color: var(--accent); }
.term:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 2px; }
.quickview { position: fixed; inset: 0 0 0 auto; margin: 0; width: min(34rem, 94vw); height: 100%;
  max-height: 100%; border: 0; border-left: 1px solid var(--line); background: var(--surface);
  color: var(--ink); padding: 1.4rem 1.5rem; overflow-y: auto;
  box-shadow: -12px 0 40px rgba(0, 0, 0, .18); }
.quickview::backdrop { background: rgba(0, 0, 0, .28); }
.quickview header { display: flex; flex-direction: column; gap: .15rem; margin-bottom: .9rem;
  border-bottom: 1px solid var(--line); padding-bottom: .7rem; }
.qv-kicker { font-family: var(--mono); font-size: .72rem; letter-spacing: .1em;
  text-transform: uppercase; color: var(--accent); }
.quickview h3 { margin: 0; font-size: 1.15rem; }
.quickview dl { margin: 0; }
.quickview dt { font-size: .72rem; text-transform: uppercase; letter-spacing: .07em;
  color: var(--muted); font-weight: 600; margin-top: .8rem; }
.quickview dd { margin: .25rem 0 0; font-size: .92rem; line-height: 1.55; }
.qv-close { margin-top: 1.2rem; font: inherit; font-size: .85rem; color: var(--muted);
  background: none; border: 1px solid var(--line); border-radius: .4rem; padding: .3rem .8rem;
  cursor: pointer; }
.qv-close:hover { color: var(--ink); }
.qv-close:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.primer { background: var(--surface); border: 1px solid var(--line); border-radius: .6rem;
  margin: 0 0 1.2rem; }
.primer > summary { padding: .6rem .9rem; cursor: pointer; font-size: .88rem; font-weight: 600;
  color: var(--muted); list-style: none; }
.primer > summary::-webkit-details-marker { display: none; }
.primer > summary::before { content: "\\2192  "; color: var(--accent); }
.primer[open] > summary { border-bottom: 1px solid var(--line); color: var(--ink); }
.primer .primer-body { padding: .8rem .9rem .9rem; font-size: .9rem; line-height: 1.6; }
.primer .primer-body p { margin: 0 0 .6rem; }
.primer .primer-body p:last-child { margin-bottom: 0; }
`;
