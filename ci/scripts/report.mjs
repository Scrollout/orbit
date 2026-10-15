// Renders the check records (ci/out/*.jsonl) as Markdown on stdout: the GitHub job summary and the local report.
// Usage: node ci/scripts/report.mjs [dir]   (default ci/out)
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const LIMIT = 1000000; // bytes; GitHub's job summary limit is 1 MiB (1048576)
const ICON = { pass: "✅", fail: "❌", skipped: "⏭️" };
const ORDER = ["vet", "quality", "security"];
const cell = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");

export function load(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().flatMap((f) =>
    readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
}

export function render(records, limit = LIMIT) {
  const targets = [...new Set(records.map((r) => r.target))].sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99));
  const count = (rs, s) => rs.filter((r) => r.status === s).length;
  const total = records.reduce((n, r) => n + r.duration_s, 0);
  const head = [`# CI report: ${count(records, "fail") ? "❌ failed" : "✅ passed"}`, "",
    `${count(records, "pass")} passed, ${count(records, "fail")} failed, ${count(records, "skipped")} skipped, ${total} s in checks.`, ""];
  const tables = targets.flatMap((t) => {
    const rs = records.filter((r) => r.target === t);
    return [`## ${t}`, "", "| | Check | Tool | Version | Findings | Seconds |", "|---|---|---|---|---|---|",
      ...rs.map((r) => `| ${ICON[r.status] ?? r.status} | ${cell(r.check)}${r.note ? ` (${cell(r.note)})` : ""} | ${cell(r.tool)} | ${cell(r.version)} | ${r.findings} | ${r.duration_s} |`), ""];
  });
  const details = [];
  for (const r of records.filter((x) => x.status === "fail")) {
    details.push(`<details><summary>${r.target}/${cell(r.check)}: ${r.findings} finding(s)</summary>`, "", "```", ...r.excerpts.map((e) => e.replace(/```/g, "'''")),
      ...(r.findings > r.excerpts.length ? [`... ${r.findings - r.excerpts.length} more not shown`] : []), "```", "", "</details>", "");
  }
  const note = "\n_Report truncated at the 1 MiB job-summary limit; the full records are in the `ci-report` artifact._\n";
  const out = [...head, ...tables];
  let size = Buffer.byteLength(out.join("\n"));
  let cut = false;
  for (let i = 0; i < details.length; i++) {
    size += Buffer.byteLength(details[i]) + 1;
    if (size > limit - note.length) { cut = true; break; }
    out.push(details[i]);
  }
  if (cut) {
    // Close a <details> left open by the cut.
    const open = out.filter((l) => l.startsWith("<details>")).length - out.filter((l) => l === "</details>").length;
    if (open > 0) out.push("```", "</details>");
    out.push(note);
  }
  return out.join("\n") + "\n";
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const records = load(process.argv[2] ?? "ci/out");
  process.stdout.write(records.length ? render(records) : "# CI report\n\nNo check records found.\n");
}
