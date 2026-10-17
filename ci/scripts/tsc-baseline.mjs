// Runs `tsc -p .` (JSDoc types, no emit) and fails on every finding not in the baseline (ci/tsc-baseline.json), and on every
// baseline entry that no longer matches, so fixing a finding shrinks the list. Prints `path:line:col TSxxxx: message` lines.
// An entry is { file, counts: { TSxxxx: n }, reason }; "skip" lists files whose findings are not counted yet, with a reason.
// TSC_BIN overrides the toolbox's tsc (a local run); its sibling @types directory supplies the node types.
// Usage: node ci/scripts/tsc-baseline.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const { entries = [], skip = [] } = JSON.parse(readFileSync(new URL("../tsc-baseline.json", import.meta.url), "utf8"));
const bin = process.env.TSC_BIN ?? "/opt/ci/node_modules/.bin/tsc";
const run = spawnSync(bin, ["-p", ".", "--pretty", "false", "--typeRoots", join(dirname(bin), "..", "@types")], { encoding: "utf8", maxBuffer: 1 << 28 });
const found = run.stdout.split("\n").map((l) => /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(l)).filter(Boolean);
if (!found.length && run.status !== 0 && !/(^|\n)(?:[^(\n]*: )?error TS\d+: /.test(run.stdout)) { console.log(`tsc:1 no findings parsed from tsc (exit ${run.status}): ${(run.stdout + run.stderr).slice(0, 300)}`); process.exit(1); }
const hits = new Map();
let bad = 0;
// Global errors (no file position, e.g. `error TS6053: File 'x' not found.`) are findings that no baseline entry covers.
for (const l of run.stdout.split("\n")) {
  const g = /^(?:[^(]*: )?error (TS\d+): (.*)$/.exec(l);
  if (g && !/\(\d+,\d+\)/.test(l)) { bad++; console.log(`tsc:1 ${g[1]}: ${g[2]}`); }
}
for (const [, file, line, col, code, msg] of found) {
  if (skip.some((s) => s.file === file)) continue;
  if (entries.some((b) => b.file === file && code in b.counts)) { hits.set(`${file} ${code}`, (hits.get(`${file} ${code}`) ?? 0) + 1); continue; }
  bad++;
  console.log(`${file}:${line}:${col} ${code}: ${msg}`);
}
for (const b of entries) for (const [code, expected] of Object.entries(b.counts)) {
  const n = hits.get(`${b.file} ${code}`) ?? 0;
  if (n === expected) continue;
  bad++;
  console.log(n < expected
    ? `ci/tsc-baseline.json:1 stale entry ${b.file} ${code}: ${n} hit(s), baseline says ${expected}; lower or remove it`
    : `${b.file}:1 ${code}: ${n} hit(s), baseline allows ${expected}; a new finding in a baselined file`);
}
process.exit(bad ? 1 : 0);
