// Checks a milestone plan written by the intent skill before the owner approves it. Zero dependencies.
//   node <plugin>/scripts/intent-plan.mjs --root . --plan <path|-> [--plan <path> ...] [--profile path] [--max-chars n]
// `-` reads the plan from stdin (the operator session writes nothing in the repo). Several --plan docs are one plan
// split by track: step ids are unique across them and Depends may cross them.
// Each doc gets the OKF per-doc checks (scripts/okf-lib.mjs; --max-chars, else maxDocChars in .agents/okf.json, else
// 4000) plus the plan rules: an `## Intent` section; `## Steps` with Step, Builds, Files, Proof, Depends and Hint
// columns (by header name); `## Exit tests` with Test and Step. A gap: a placeholder or empty Builds, Proof or Intent;
// no Files on a step that is not decide-first; a wildcard outside the last segment; an unknown or cyclic Depends;
// an exit test naming no or an unknown step; a Hint other than `sec=yes|no door=yes|no [prod=yes|no]` (prod required
// when the profile names a production_env) or `decide-first`.
// Files entries are paths, directories ending in `/`, or a wildcard in the last segment. A step whose entries may touch a
// profile security path is forced to sec=yes: an exact path by the glob itself, a directory or wildcard by its literal
// prefix (one prefix inside the other), which over-reports and never misses ("may touch").
// Prints forced lines, the dispatch waves (dependencies first, no two steps of a wave touching the same paths) and the
// steps that go to /decide first. Exit codes: 0 ok, 1 profile gap (security_paths only), 2 plan gap, 64 usage.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gaps, globMatch, loadProfile } from "./profile.mjs";
import { checkDoc } from "./okf-lib.mjs";

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const plans = args.flatMap((a, i) => (args[i - 1] === "--plan" ? [a] : []));
const usage = "usage: intent-plan.mjs --root . --plan <path|-> [--plan <path> ...] [--profile path] [--max-chars n]";
if (!plans.length || plans.some((p) => p === undefined || p.startsWith("--")) || plans.filter((p) => p === "-").length > 1) { console.error(usage); process.exit(64); }
const root = resolve(flag("root") ?? ".");
const texts = plans.map((p) => {
  try { return [p === "-" ? "stdin" : p, readFileSync(p === "-" ? 0 : resolve(root, p), "utf8")]; }
  catch { console.error(`intent-plan: cannot read ${p === "-" ? "stdin" : p}`); process.exit(64); }
});

const { data: profile } = loadProfile(root, flag("profile"));
if (gaps(profile).includes("security_paths")) { console.log("profile gap: security_paths"); process.exit(1); }
const securityPaths = profile.security_paths;
const prodEnv = profile.production_env;
const needProd = prodEnv !== undefined && !/^none$/i.test(String(prodEnv).trim());
let okfConfig = {};
try { okfConfig = JSON.parse(readFileSync(join(root, ".agents/okf.json"), "utf8")); } catch {}
const maxChars = Number(flag("max-chars") ?? okfConfig.maxDocChars ?? 4000);

const gapsOut = [];
const gap = (m) => gapsOut.push(m);
const placeholder = (s) => !s.trim() || /<[^>]*>/.test(s);

// A markdown table under `## <heading>`: rows of cells keyed by the lower-cased header.
function table(text, heading) {
  const m = text.match(new RegExp(`^## ${heading}[ \\t]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m"));
  if (!m) return null;
  const rows = m[1].split("\n").filter((l) => /^\s*\|/.test(l)).map((l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => h.toLowerCase());
  return rows.slice(2).map((cells) => Object.fromEntries(head.map((h, i) => [h, cells[i] ?? ""])));
}
const list = (s) => s.replace(/`/g, "").split(",").map((x) => x.trim()).filter((x) => x && !/^(-|none)$/i.test(x));

const steps = new Map(), exits = [];
for (const [name, text] of texts) {
  const doc = checkDoc(text, { maxChars });
  for (const m of doc.errors) gap(`${name}: okf: ${m}`);
  for (const m of doc.warnings) console.log(`warn: ${name}: okf: ${m}`);
  const intent = text.match(/^## Intent[ \t]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m);
  if (!intent || placeholder(intent[1])) gap(`${name}: no ## Intent section, or it still has placeholders`);
  const rows = table(text, "Steps");
  if (!rows?.length) { gap(`${name}: no ## Steps table`); continue; }
  for (const c of ["step", "builds", "files", "proof", "depends", "hint"]) if (!(c in rows[0])) gap(`${name}: Steps has no ${c} column`);
  for (const r of rows) {
    const id = r.step ?? "";
    if (!id) { gap(`${name}: a step has no id`); continue; }
    if (steps.has(id)) { gap(`step ${id}: duplicate id`); continue; }
    steps.set(id, { id, doc: name, builds: r.builds ?? "", files: list(r.files ?? ""), proof: r.proof ?? "", depends: list(r.depends ?? ""), hint: (r.hint ?? "").trim() });
  }
  for (const r of table(text, "Exit tests") ?? []) exits.push({ doc: name, test: r.test ?? "", steps: list(r.step ?? "") });
}
if (!exits.length) gap("no ## Exit tests table with a row (in any plan doc)");

// Literal prefix: the segments before the first one holding a wildcard. `dir` marks a trailing `/`.
const parse = (e) => {
  const segs = e.replace(/^\.?\//, "").split("/").filter(Boolean);
  const wild = segs.findIndex((s) => /[*?]/.test(s));
  return { e, segs, dir: e.endsWith("/"), wild, prefix: wild < 0 ? segs : segs.slice(0, wild) };
};
const concrete = (x) => x.wild < 0 && !x.dir;
const isPrefix = (a, b) => a.length <= b.length && a.every((s, i) => s === b[i]);
// May the paths an entry names meet the paths a glob (or another entry) names? Exact when one side is a concrete path
// or a last-segment pattern against a glob with a literal last segment; otherwise one literal prefix inside the other.
const wildFile = (x) => !x.dir && x.wild >= 0 && x.wild === x.segs.length - 1;
function wildFileMeets(a, g) {
  if (a.prefix.length && globMatch(g.e, a.prefix.join("/"))) return true;
  const last = g.segs[g.segs.length - 1] ?? "";
  if (!/[*?]/.test(last)) return globMatch(a.segs[a.segs.length - 1], last) && globMatch(g.e, [...a.prefix, last].join("/"));
  return isPrefix(a.prefix, g.prefix) || isPrefix(g.prefix, a.prefix);
}
function meets(a, b) {
  if (concrete(a) && concrete(b)) return a.segs.join("/") === b.segs.join("/");
  if (concrete(a)) return globMatch(b.e, a.segs.join("/"));
  if (concrete(b)) return globMatch(a.e, b.segs.join("/"));
  if (wildFile(a) && wildFile(b)) return a.prefix.join("/") === b.prefix.join("/");
  if (wildFile(a)) return wildFileMeets(a, b);
  if (wildFile(b)) return wildFileMeets(b, a);
  return isPrefix(a.prefix, b.prefix) || isPrefix(b.prefix, a.prefix);
}

const hintRe = needProd ? /^sec=(yes|no) door=(yes|no) prod=(yes|no)$/ : /^sec=(yes|no) door=(yes|no)( prod=(yes|no))?$/;
const forced = [];
for (const s of steps.values()) {
  const first = s.hint === "decide-first";
  if (!first && !hintRe.test(s.hint.replace(/\s+/g, " "))) gap(`step ${s.id}: hint '${s.hint}' is not 'sec=yes|no door=yes|no${needProd ? " prod=yes|no" : " [prod=yes|no]"}' or 'decide-first'`);
  if (placeholder(s.builds)) gap(`step ${s.id}: Builds is empty or a placeholder`);
  if (placeholder(s.proof) && !first) gap(`step ${s.id}: Proof is empty or a placeholder`);
  if (!s.files.length && !first) gap(`step ${s.id}: no Files`);
  s.parsed = s.files.map(parse);
  for (const x of s.parsed) if (x.wild >= 0 && x.wild < x.segs.length - 1) gap(`step ${s.id}: '${x.e}' has a wildcard outside the last segment`);
  for (const d of s.depends) if (!steps.has(d)) gap(`step ${s.id}: depends on unknown step ${d}`);
  const hits = securityPaths.filter((g) => s.parsed.some((x) => meets(x, parse(g))));
  if (hits.length) {
    s.sec = true;
    const exact = s.parsed.every(concrete);
    forced.push(`step ${s.id}: sec=yes (forced${exact ? "" : ", may touch"}: ${hits.join(", ")})`);
  } else s.sec = /sec=yes/.test(s.hint);
}
for (const x of exits) {
  if (!x.steps.length) gap(`${x.doc}: exit test '${x.test}' names no step`);
  for (const id of x.steps) if (!steps.has(id)) gap(`${x.doc}: exit test '${x.test}' names unknown step ${id}`);
}
// Cycles: depth-first over the known Depends.
const state = new Map();
const visit = (id, path) => {
  if (state.get(id) === 2) return;
  if (state.get(id) === 1) { gap(`dependency cycle: ${[...path.slice(path.indexOf(id)), id].join(" -> ")}`); return; }
  state.set(id, 1);
  for (const d of steps.get(id).depends) if (steps.has(d)) visit(d, [...path, id]);
  state.set(id, 2);
};
for (const id of steps.keys()) visit(id, []);

for (const f of forced) console.log(f);
if (gapsOut.length) { for (const g of gapsOut) console.log(`plan gap: ${g}`); process.exit(2); }

// Waves: in listing order, a step joins the current wave once its dependencies are in earlier waves and it touches
// none of the paths of a step already in the wave.
const done = new Set(), waves = [];
while (done.size < steps.size) {
  const wave = [];
  for (const s of steps.values()) {
    if (done.has(s.id) || !s.depends.every((d) => done.has(d))) continue;
    if (wave.some((w) => w.parsed.some((a) => s.parsed.some((b) => meets(a, b))))) continue;
    wave.push(s);
  }
  wave.forEach((s) => done.add(s.id));
  waves.push(wave.map((s) => s.id));
}
waves.forEach((w, i) => console.log(`wave ${i + 1}: ${w.join(", ")}`));
const decide = [...steps.values()].filter((s) => s.hint === "decide-first" || s.sec || /door=yes/.test(s.hint));
console.log(`decide first: ${decide.map((s) => `${s.id} (${s.hint === "decide-first" ? "decide-first" : s.sec ? "sec=yes" : "door=yes"})`).join(", ") || "none"}`);
console.log(`steps: ${steps.size}`);
