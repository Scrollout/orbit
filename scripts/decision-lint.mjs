// Lints a /decide decision record (refs/decide/record.md, step 8). Zero dependencies, no model.
//   node <plugin>/scripts/decision-lint.mjs <file|-> [--json]
// Table: the columns Call, Model, Verdict, Confidence, Key reason, Conditions, Tokens, a PM row, and a row per call. Verdict words by
// call: security accept | conditions | block; PM, techlead and architect adopt | reject <proposal>; engineers, designers and reviewers
// for | against <proposal>; an analyst or explorer may give `-`. A `conditions` verdict needs a non-empty Conditions cell. No cell
// may be empty or a placeholder (`...`, TODO, <...>), except Conditions (empty is fine unless the verdict is `conditions`) and Tokens
// (`-` is fine). After the table, each at the start of a line (a list marker and bold are fine) with its exact label and a colon: the three triage
// lines `Security paths:`, `One-way door:` and `Touches real:` (or `Touches the profile's production-like environment:`), answered yes or no
// (the last may be n/a when the profile defines none).
// Output: one `decision gap: <what>` line per gap; exit 0 ok, 2 gaps, 64 bad usage. It checks the shape, not whether the call was right.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const COLUMNS = ["Call", "Model", "Verdict", "Confidence", "Key reason", "Conditions", "Tokens"];
const cells = (line) => {
  const out = []; let cur = "";
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, (m, i, s) => (s[i - 1] === "\\" ? m : ""));
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\" && body[i + 1] === "|") { cur += "|"; i++; }
    else if (body[i] === "|") { out.push(cur.trim()); cur = ""; }
    else cur += body[i];
  }
  out.push(cur.trim());
  return out;
};
const placeholder = (s) => s === "" || /^(\.\.\.|…|todo|tbd|<[^>]*>)$/i.test(s);
const roleOf = (call) => call.replace(/[`*]/g, "").split(":")[0].trim().toLowerCase();
const WORDS = (role) => /^(pm|techlead|tech lead|architect)$/.test(role) ? ["adopt", "reject"] : role === "security" ? ["accept", "conditions", "block"] : /^(analyst|explorer)$/.test(role) ? null : ["for", "against"];

export function lint(text) {
  const gaps = [], lines = text.split(/\r?\n/);
  let tableEnd = 0;
  const h = lines.findIndex((l) => l.trim().startsWith("|") && /\bcall\b/i.test(l) && /\bverdict\b/i.test(l));
  if (h < 0) gaps.push("no decision table (a header row with Call and Verdict)");
  else {
    const head = cells(lines[h]).map((c) => c.toLowerCase());
    const idx = Object.fromEntries(COLUMNS.map((c) => [c, head.indexOf(c.toLowerCase())]));
    for (const c of COLUMNS) if (idx[c] < 0) gaps.push(`column ${c} missing`);
    const rows = [];
    for (let i = h + 1; i < lines.length && lines[i].trim().startsWith("|"); i++) if (!/^\|?[\s:|-]+\|?$/.test(lines[i].trim())) rows.push([i + 1, cells(lines[i])]);
    tableEnd = rows.length ? rows.at(-1)[0] : h + 1;
    if (!rows.length) gaps.push("the table has no rows");
    if (rows.length && !rows.some(([, r]) => roleOf(r[idx.Call] ?? "") === "pm")) gaps.push("no PM row");
    if (!Object.values(idx).includes(-1)) for (const [n, r] of rows) {
      const call = r[idx.Call] ?? "", g = (m) => gaps.push(`line ${n} (${call || "?"}): ${m}`);
      if (r.length !== head.length) g(`${r.length} cells, the header has ${head.length}`);
      if (placeholder(call)) { g("empty Call"); continue; }
      for (const c of ["Model", "Confidence", "Key reason"]) if (placeholder(r[idx[c]] ?? "")) g(`${c} is empty or a placeholder`);
      if (/^(\.\.\.|…|todo|tbd)$/i.test(r[idx.Conditions] ?? "") || /^<[^>]*>$/.test(r[idx.Conditions] ?? "")) g("Conditions is a placeholder");
      if (placeholder(r[idx.Tokens] ?? "")) g("Tokens is empty or a placeholder (use - when none)");
      const verdict = (r[idx.Verdict] ?? "").replace(/[`*]/g, "").trim(), words = WORDS(roleOf(call));
      if (placeholder(verdict)) { g("Verdict is empty or a placeholder"); continue; }
      if (!words) { if (verdict !== "-") g(`Verdict ${JSON.stringify(verdict)}: an analyst gives -`); continue; }
      const [w, ...rest] = verdict.split(/\s+/);
      if (!words.includes(w.toLowerCase())) g(`Verdict ${JSON.stringify(verdict)} must start with ${words.join(", ")}`);
      else if (["for", "against", "adopt", "reject"].includes(w.toLowerCase()) && !rest.join("").trim()) g(`Verdict ${w} needs the proposal`);
      if (w.toLowerCase() === "conditions" && /^(|-|none|n\/a)$/i.test((r[idx.Conditions] ?? "").trim())) g("Verdict conditions needs a Conditions cell");
    }
  }
  const after = lines.slice(tableEnd);
  const norm = (l) => l.replace(/[*_`]/g, "").replace(/^\s*[-+]?\s*/, "");
  const answer = (label) => { for (const l of after) { const m = new RegExp(`^(?:${label})\\s*:\\s*(.*)$`).exec(norm(l)); if (m) return m[1].trim(); } return undefined; };
  for (const [name, label, ok] of [["Security paths", "Security paths", /^(yes|no)\b/], ["One-way door", "One-way door", /^(yes|no)\b/], ["Touches real", "Touches real|Touches the profile's production-like environment", /^(yes|no|n\/a)\b/]]) {
    const a = answer(label);
    if (a === undefined) gaps.push(`triage line ${name} missing (after the table, at the start of a line, as "${name}:")`);
    else if (!ok.test(a)) gaps.push(`triage line ${name}: answer must start with ${name === "Touches real" ? "yes, no or n/a" : "yes or no"}, got ${JSON.stringify(a.slice(0, 30))}`);
  }
  return gaps;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), src = args.find((a) => a === "-" || !a.startsWith("--"));
  if (!src) { console.error("usage: decision-lint.mjs <file|-> [--json]"); process.exit(64); }
  let text; try { text = readFileSync(src === "-" ? 0 : src, "utf8"); } catch { console.error(`decision-lint: cannot read ${src}`); process.exit(64); }
  const gaps = lint(text);
  if (args.includes("--json")) { console.log(JSON.stringify({ gaps })); process.exit(gaps.length ? 2 : 0); }
  for (const g of gaps) console.log(`decision gap: ${g}`);
  if (gaps.length) process.exit(2);
  console.log("decision ok");
}
