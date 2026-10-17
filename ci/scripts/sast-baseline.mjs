// Applies ci/sast-baseline.json to the Opengrep and Checkov results of make sast. Prints every finding not in the baseline
// as `path:line rule: message`, and every entry whose count no longer matches (higher: a new finding, all of the pair's
// findings printed; lower: stale), so fixing a finding shrinks the list. An entry is { rule, file, count, reason } and
// needs a non-empty reason. On a failure it ends with the proposed baseline: every current finding grouped by rule and file,
// with the reason of the matching entry or an empty one to write. Either result missing or empty also fails.
// Usage: node ci/scripts/sast-baseline.mjs <opengrep.json> <checkov results_json.json>
import { readFileSync } from "node:fs";

const [ogFile, ckFile] = process.argv.slice(2);
const FRAMEWORKS = ["dockerfile", "github_actions"]; // as in ci/scripts/sast.sh: each must report, so none passes on nothing
const { entries = [] } = JSON.parse(readFileSync(new URL("../sast-baseline.json", import.meta.url), "utf8"));
const one = (s) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
const rel = (p) => String(p ?? "").replace(/^\.?\//, "");
const key = (rule, file) => `${rule}\0${file}`;
let bad = 0;
const fail = (line) => { bad++; console.log(line); };

/** @type {{ file: string, line: number, rule: string, message: string }[]} */
const findings = [];
try {
  const og = JSON.parse(readFileSync(ogFile, "utf8"));
  if (!og.paths?.scanned?.length) fail(`${ogFile}:1 opengrep: no file scanned`);
  for (const r of og.results ?? []) findings.push({ file: rel(r.path), line: r.start?.line ?? 1, rule: r.check_id, message: one(r.extra?.message) });
  for (const e of og.errors ?? []) console.log(`note: opengrep ${e.level ?? "error"} ${one(e.type)}: ${one(e.message)}`);
} catch (e) { fail(`${ogFile}:1 no Opengrep result: ${one(/** @type {Error} */ (e).message)}`); }
try {
  const ck = JSON.parse(readFileSync(ckFile, "utf8"));
  const reports = Array.isArray(ck) ? ck : [ck];
  for (const f of FRAMEWORKS) if (!reports.some((r) => r.check_type === f)) fail(`${ckFile}:1 checkov: no ${f} report (no file scanned?)`);
  for (const r of reports) {
    for (const c of r.results?.failed_checks ?? []) findings.push({ file: rel(c.repo_file_path ?? c.file_path), line: c.file_line_range?.[0] || 1, rule: c.check_id, message: one(c.check_name) });
    for (const p of r.results?.parsing_errors ?? []) fail(`${rel(p)}:1 checkov: ${r.check_type} parsing error`);
  }
} catch (e) { fail(`${ckFile}:1 no Checkov result: ${one(/** @type {Error} */ (e).message)}`); }

const byKey = new Map();
for (const f of findings) byKey.set(key(f.rule, f.file), [...(byKey.get(key(f.rule, f.file)) ?? []), f]);
const show = (f) => `${f.file}:${f.line} ${f.rule}: ${f.message}`;
entries.forEach((b, i) => {
  if (typeof b.rule !== "string" || typeof b.file !== "string" || !Number.isInteger(b.count) || b.count < 1 || typeof b.reason !== "string" || !b.reason.trim())
    fail(`ci/sast-baseline.json:1 entry ${i + 1} (${b.rule} ${b.file}): needs rule, file, a count of 1 or more and a reason`);
});
const known = new Set(entries.map((b) => key(b.rule, b.file)));
for (const f of findings) if (!known.has(key(f.rule, f.file))) fail(show(f));
for (const b of entries) {
  const hits = byKey.get(key(b.rule, b.file)) ?? [];
  if (hits.length === b.count) continue;
  if (hits.length > b.count) { hits.forEach((f) => console.log(show(f))); fail(`${b.file}:1 ${b.rule}: ${hits.length} hit(s), baseline allows ${b.count}; a new finding in a baselined pair`); }
  else fail(`ci/sast-baseline.json:1 stale entry ${b.file} ${b.rule}: ${hits.length} hit(s), baseline says ${b.count}; lower or remove it`);
}
console.log(`sast: ${findings.length} finding(s), ${entries.length} baseline entr${entries.length === 1 ? "y" : "ies"}, ${bad} problem(s)`);
if (bad) {
  const reason = new Map(entries.map((b) => [key(b.rule, b.file), b.reason]));
  const proposed = [...byKey.values()].map((fs) => ({ rule: fs[0].rule, file: fs[0].file, count: fs.length, reason: reason.get(key(fs[0].rule, fs[0].file)) ?? "" }))
    .sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule));
  console.log("--- proposed ci/sast-baseline.json (write a reason for every entry; an empty one fails):");
  console.log(JSON.stringify({ entries: proposed }, null, 2));
}
process.exit(bad ? 1 : 0);
