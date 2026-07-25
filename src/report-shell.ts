/**
 * Renders the single-file HTML shell that hydrates the embedded React report app. The page stays
 * self-contained - the app bundle and stylesheet are inlined, report data is embedded as JSON, and
 * nothing references the network - so a report file can be archived, mailed, or opened from
 * file:// and still work. Untrusted report content never touches this template: it travels inside
 * the JSON payload and is rendered by React, which escapes by construction.
 */
import { REPORT_APP_CSS, REPORT_APP_JS } from "./generated/report-assets.js";
import { PAYLOAD_GLOBAL, type ReportPayload } from "./report-payload.js";

// Serialized JSON is inert inside a script tag only if it cannot close the tag or open a comment:
// escape the three dangerous characters (plus the JS line separators JSON permits raw).
function embedJson(payload: ReportPayload): string {
  return JSON.stringify(payload)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export function renderReportShell(payload: ReportPayload, title: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<script>
// Theme before first paint: follow the system, no flash. The .dark class drives Tailwind tokens.
(function () {
  if (typeof window.matchMedia !== "function") return;
  var media = window.matchMedia("(prefers-color-scheme: dark)");
  var apply = function () {
    document.documentElement.classList.toggle("dark", media.matches);
  };
  apply();
  media.addEventListener("change", apply);
})();
</script>
<style>${REPORT_APP_CSS}</style>
</head>
<body>
<div id="root"></div>
<script>window.${PAYLOAD_GLOBAL} = ${embedJson(payload)};</script>
<script>${REPORT_APP_JS}</script>
</body>
</html>
`;
}
