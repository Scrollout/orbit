// Golden scenarios: scripted cases whose outcome is pinned, so a rule, script or skill edit that changes behaviour fails until the scenario is updated on purpose. Zero dependencies.
//   node <plugin>/scripts/scenarios.mjs --list              name and description of every scenario
//   node <plugin>/scripts/scenarios.mjs --print <name>      the actual outcome as JSON (paste into its expect after reviewing it)
//   node <plugin>/scripts/scenarios.mjs [--run] [name]       compare actual with expect; exit 1 on any difference
// A scenario is one file scenarios/<name>.json (one file each keeps the plugin under the portal's file limit): {description,
// profile?, profile_extra?, triage?, report?, expect, ledger? (the ledger's lines, kept as text so a bad line stays bad),
// go_log? (the go log's lines), report_md? (with report), coder_md? (optional, a reviewer scenario's coder report)}.
//   profile: fixture name (scripts/fixtures/<name>.md, default real-profile); profile_extra: lines added to the machine block (e.g. "standing_waivers: [docs-only]").
//   triage: {files: [...], lines?: "sec=no,door=no,prod=no", kind?: "small|design|incident"}, run through decide-triage.mjs --files.
//   report: {role: "coder"|"reviewer", tests?: [...]}: report.md (a coder's report or a reviewer's answer) run through proof-check.mjs,
//   each test as a --test, and coder.md as --coder-report when it exists.
//   expect keys (only those present for the parts the scenario has): report_exit (default 0) and report_gaps (the `proof gap:` lines, when any) for a report; track, caps, coder_model, triage_exit (default 0), gaps (the `triage gap:` names, when any) for a triage; violations ({rule id: count}, default {}) and exit (default 0) for a ledger.
// scenarios/pin.json pins the versions of /decide, the operator skill and the rules the scenarios were reviewed against (see scenarios.test.mjs).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { violationIds } from "./rx.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const dir = join(here, "..", "scenarios");
export const names = () => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith(".json") && d.name !== "pin.json").map((d) => d.name.slice(0, -5)).sort() : []);
const readJson = (f) => JSON.parse(readFileSync(f, "utf8"));
export const scenario = (name) => readJson(join(dir, `${name}.json`));
const node = (script, args) => spawnSync(process.execPath, [join(here, script), ...args], { encoding: "utf8" });

export function actual(name) {
  const sc = scenario(name);
  const root = mkdtempSync(join(tmpdir(), "scn-"));
  mkdirSync(join(root, ".agents"));
  let text = readFileSync(join(here, "fixtures", `${sc.profile ?? "real-profile"}.md`), "utf8");
  if (sc.profile_extra) text = text.replace(/^(ci_policy: .*)$/m, (m) => [m, ...sc.profile_extra].join("\n"));
  writeFileSync(join(root, ".agents", "project.md"), text);
  try { return run(sc, root); } finally { rmSync(root, { recursive: true, force: true }); }
}

function run(sc, root) {
  const out = {};
  if (sc.triage) {
    const t = sc.triage;
    const r = node("decide-triage.mjs", ["--root", root, "--files", t.files.join(","), ...(t.lines ? ["--lines", t.lines] : []), ...(t.kind ? ["--kind", t.kind] : [])]);
    out.triage_exit = r.status;
    out.gaps = [...r.stdout.matchAll(/^triage gap: (.*)$/gm)].map((m) => m[1]);
    if (!out.gaps.length) delete out.gaps;
    for (const [k, re] of [["track", /^track: (.*)$/m], ["caps", /^caps: (.*)$/m], ["coder_model", /^coder model: (.*)$/m]]) { const m = r.stdout.match(re); if (m) out[k] = m[1]; }
  }
  if (sc.report) {
    const cr = join(root, "coder.md");
    writeFileSync(join(root, "report.md"), sc.report_md);
    if (typeof sc.coder_md === "string") writeFileSync(cr, sc.coder_md);
    const r = node("proof-check.mjs", [`--${sc.report.role}`, join(root, "report.md"), "--root", root, ...(sc.report.tests ?? []).flatMap((t) => ["--test", t]), ...(typeof sc.coder_md === "string" ? ["--coder-report", cr] : [])]);
    out.report_exit = r.status;
    out.report_gaps = [...r.stdout.matchAll(/^proof gap: (.*)$/gm)].map((m) => m[1]);
    if (!out.report_gaps.length) delete out.report_gaps;
  }
  if (Array.isArray(sc.ledger)) {
    writeFileSync(join(root, "ledger.jsonl"), sc.ledger.join("\n"));
    // The go log (a hook-written file under ~/.claude) comes from the scenario, never from the host's home.
    if (Array.isArray(sc.go_log)) writeFileSync(join(root, "go-log.jsonl"), sc.go_log.join("\n"));
    const r = node("audit-ledger.mjs", [join(root, "ledger.jsonl"), "--root", root, "--go-log", join(root, "go-log.jsonl")]);
    out.exit = r.status;
    out.violations = {};
    for (const id of violationIds(r.stdout)) out.violations[id] = (out.violations[id] ?? 0) + 1;
  }
  return out;
}

export function expected(name) {
  const sc = scenario(name), e = sc.expect;
  const out = {};
  if (sc.triage) out.triage_exit = 0;
  if (sc.report) out.report_exit = 0;
  if (Array.isArray(sc.ledger)) Object.assign(out, { exit: 0, violations: {} });
  return Object.assign(out, e);
}

// key order does not matter
const canon = (o) => JSON.stringify(o, (k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v));
export const differs = (name) => {
  const a = actual(name), e = expected(name);
  return canon(a) === canon(e) ? null : { expected: e, actual: a };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const rest = args.filter((a) => !a.startsWith("--"));
  if (args.includes("--list")) for (const n of names()) console.log(`${n}: ${scenario(n).description}`);
  else if (args.includes("--print")) { if (!rest[0] || !names().includes(rest[0])) { console.error("usage: scenarios.mjs --print <name>"); process.exit(64); } console.log(JSON.stringify(actual(rest[0]), null, 2)); }
  else {
    const todo = rest.length ? rest : names();
    let bad = 0;
    for (const n of todo) {
      if (!names().includes(n)) { console.error(`no scenario ${n}`); process.exit(64); }
      const d = differs(n);
      if (d) { bad++; console.log(`FAIL ${n}\n  expected ${canon(d.expected)}\n  actual   ${canon(d.actual)}`); } else console.log(`ok   ${n}`);
    }
    process.exit(bad ? 1 : 0);
  }
}
