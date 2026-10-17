// Renders the check records (ci/out/*.jsonl) as Markdown on stdout: the GitHub job summary and the local report.
// A target that recorded nothing, or whose file is missing or empty, is a failed target; a corrupt line is a failed record.
// Usage: node ci/scripts/report.mjs [dir]   (default ci/out)
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const LIMIT = 1000000; // bytes; GitHub's job summary limit is 1 MiB (1048576)
export const TARGETS = ["vet", "quality", "security"];
const ICON = { pass: "✅", fail: "❌", skipped: "⏭️" };
// Text from a log or a file name goes into table cells and code fences: no HTML, no backticks, no pipes, no line breaks.
const cell = (s) => String(s).replace(/\\/g, "\\\\").replace(/[|]/g, "\\|").replace(/[\r\n]/g, " ").replace(/</g, "&lt;").replace(/`/g, "'");
const code = (s) => String(s).replace(/</g, "‹").replace(/`/g, "'").replace(/[\r\n]/g, " ");

const failed = (target, check, why) => ({ check, target, status: "fail", duration_s: 0, tool: "-", version: "-", findings: 1, excerpts: [why] });

export function load(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().flatMap((f) => {
    const target = f.slice(0, -".jsonl".length);
    return readFileSync(join(dir, f), "utf8").split("\n").map((l, i) => [l, i + 1]).filter(([l]) => l !== "").map(([l, n]) => {
      try {
        const r = JSON.parse(l);
        if (r && typeof r === "object" && typeof r.check === "string" && ["pass", "fail", "skipped"].includes(r.status) && Array.isArray(r.excerpts)) return r;
        throw new Error("not a record");
      } catch { return failed(target, "corrupt record", `${f}:${n} is not a valid check record`); }
    });
  });
}

export function render(input, limit = LIMIT, expected = TARGETS) {
  const records = [...input];
  for (const t of expected) if (!records.some((r) => r.target === t)) records.push(failed(t, "(target)", "no result recorded"));
  const rank = (t) => (expected.indexOf(t) + 1 || 99);
  const targets = [...new Set(records.map((r) => r.target))].sort((a, b) => rank(a) - rank(b));
  const count = (s) => records.filter((r) => r.status === s).length;
  const total = records.reduce((n, r) => n + (Number(r.duration_s) || 0), 0);
  const head = [`# CI report: ${count("fail") ? "❌ failed" : "✅ passed"}`, "",
    `${count("pass")} passed, ${count("fail")} failed, ${count("skipped")} skipped, ${total} s in checks.`, ""];
  const tables = targets.flatMap((t) => [`## ${cell(t)}`, "", "| | Check | Tool | Version | Findings | Seconds |", "|---|---|---|---|---|---|",
    ...records.filter((r) => r.target === t).map((r) => `| ${ICON[r.status]} | ${cell(r.check)}${r.note ? ` (${cell(r.note)})` : ""} | ${cell(r.tool)} | ${cell(r.version)} | ${cell(r.findings)} | ${cell(r.duration_s)} |`), ""]);
  // One string per failing check, cut only between whole blocks, never inside a <details> or a fence.
  const blocks = records.filter((r) => r.status === "fail").map((r) => [
    `<details><summary>${cell(r.target)}/${cell(r.check)}: ${cell(r.findings)} finding(s)${r.log ? `, full log in the ci-report artifact: ${cell(r.log)}` : ""}</summary>`, "", "```",
    ...r.excerpts.map(code), ...(r.findings > r.excerpts.length ? [`... ${r.findings - r.excerpts.length} more not shown`] : []), "```", "", "</details>", ""].join("\n"));
  const note = "\n_Report truncated at the 1 MiB job-summary limit; the full records and logs are in the `ci-report` artifact._\n";
  const out = [...head, ...tables];
  let size = Buffer.byteLength(out.join("\n")) + Buffer.byteLength(note);
  let cut = false;
  for (const b of blocks) {
    size += Buffer.byteLength(b) + 1;
    if (size > limit) { cut = true; break; }
    out.push(b);
  }
  if (cut) out.push(note);
  return out.join("\n") + "\n";
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.stdout.write(render(load(process.argv[2] ?? "ci/out")));
