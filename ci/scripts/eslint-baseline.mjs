// Runs eslint and fails on every finding not in the baseline (ci/eslint-baseline.json), and on every baseline entry that
// no longer matches, so fixing a finding shrinks the list. Prints `path:line:col rule: message` lines.
// Usage: node ci/scripts/eslint-baseline.mjs <quality|security>
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { spawnSync } from "node:child_process";

const kind = process.argv[2];
const config = { quality: "eslint.config.mjs", security: "eslint.security.mjs" }[kind];
if (!config) { console.log("eslint-baseline.mjs:1 usage: <quality|security>"); process.exit(2); }
const baseline = JSON.parse(readFileSync(new URL("../eslint-baseline.json", import.meta.url), "utf8"))[kind] ?? [];
const run = spawnSync("/opt/ci/node_modules/.bin/eslint", ["-c", `/opt/ci/${config}`, "-f", "json", "--no-warn-ignored", "."], { encoding: "utf8", maxBuffer: 1 << 28 });
let results;
try { results = JSON.parse(run.stdout); } catch { console.log(`eslint:1 no JSON from eslint (exit ${run.status}): ${run.stderr.slice(0, 300)}`); process.exit(1); }
const hits = new Map();
let bad = 0;
for (const r of results) {
  const file = relative(process.cwd(), r.filePath);
  for (const m of r.messages) {
    const rule = m.ruleId ?? "parse";
    if (baseline.some((b) => b.file === file && rule in b.counts)) { hits.set(`${file} ${rule}`, (hits.get(`${file} ${rule}`) ?? 0) + 1); continue; }
    bad++;
    console.log(`${file}:${m.line}:${m.column} ${rule}: ${m.message}`);
  }
}
for (const b of baseline) for (const [rule, expected] of Object.entries(b.counts)) {
  const n = hits.get(`${b.file} ${rule}`) ?? 0;
  if (n === expected) continue;
  bad++;
  console.log(n < expected
    ? `ci/eslint-baseline.json:1 stale entry ${b.file} ${rule}: ${n} hit(s), baseline says ${expected}; lower or remove it`
    : `${b.file}:1 ${rule}: ${n} hit(s), baseline allows ${expected}; a new finding in a baselined file`);
}
process.exit(bad ? 1 : 0);
