// Checks the TDD evidence in a coder's report (DEC-21) or a reviewer's answer (DEC-22). Zero dependencies, no model.
//   node <plugin>/scripts/proof-check.mjs --coder <file|-> [--tests a,b] [--root .] [--profile .agents/project.md]
//   node <plugin>/scripts/proof-check.mjs --reviewer <file|-> [--tests a,b]
// Coder report lines (one or more per label; <test> runs up to the first ": "):
//   RED <test>: <excerpt of the test failing without the change>
//   GREEN <test>: <excerpt of the test passing with it>
//   CANNOT FAIL FIRST <test>: <reason>            (docs only, a pure refactor, a check that cannot fail first)
//   TEST FIRST <test>: <sha>                      (only when the profile says test_first_commit: yes: the commit of the failing test, before the fix)
// Each test needs RED and GREEN, or a CANNOT FAIL FIRST reason (GREEN optional then). The excerpts are checked for presence, not content.
// Reviewer answer lines: `PROOF CHECK <test>: fails|passes|not checked[ <detail>]`; a `passes` needs a CONFIRMED finding that says
// "proof does not prove" and names the test.
// --tests: names that must have evidence (the brief's proof tests, the fix round's tests); without it, at least one entry.
// Output: one `proof gap: <what>` line per gap; exit 0 ok, 2 gaps, 64 bad usage.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadProfile } from "./profile.mjs";

const LINE = /^\s*(?:[-*]\s+)?(RED|GREEN|CANNOT FAIL FIRST|TEST FIRST|PROOF CHECK) (.+?):(?: (.*))?$/;

export function parse(text) {
  const out = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(LINE);
    if (!m) continue;
    const name = m[2].trim().replace(/^`(.*)`$/, "$1");
    const e = out.get(name) ?? { RED: [], GREEN: [], "CANNOT FAIL FIRST": [], "TEST FIRST": [], "PROOF CHECK": [] };
    e[m[1]].push((m[3] ?? "").trim());
    out.set(name, e);
  }
  return out;
}

const filled = (xs) => xs.some((x) => x !== "");

export function checkCoder(text, { tests = [], testFirst = false } = {}) {
  const p = parse(text), gaps = [];
  const names = [...p.keys()].filter((n) => ["RED", "GREEN", "CANNOT FAIL FIRST", "TEST FIRST"].some((k) => p.get(n)[k].length));
  if (!names.length && !tests.length) gaps.push("no RED/GREEN or CANNOT FAIL FIRST lines in the report");
  for (const t of tests) if (!names.includes(t)) gaps.push(`${t}: no evidence`);
  for (const n of names) {
    const e = p.get(n), cannot = e["CANNOT FAIL FIRST"];
    if (cannot.length) {
      if (!filled(cannot)) gaps.push(`${n}: CANNOT FAIL FIRST needs a reason`);
      continue;
    }
    if (!filled(e.RED)) gaps.push(`${n}: no RED excerpt (the test failing without the change)`);
    if (!filled(e.GREEN)) gaps.push(`${n}: no GREEN excerpt (the test passing with the change)`);
    if (testFirst && !e["TEST FIRST"].some((s) => /^[0-9a-f]{7,40}$/i.test(s))) gaps.push(`${n}: test_first_commit is yes but no TEST FIRST <sha> line`);
  }
  return gaps;
}

export function checkReviewer(text, { tests = [] } = {}) {
  const p = parse(text), gaps = [];
  const names = [...p.keys()].filter((n) => p.get(n)["PROOF CHECK"].length);
  if (!names.length && !tests.length) gaps.push("no PROOF CHECK lines in the answer");
  for (const t of tests) if (!names.includes(t)) gaps.push(`${t}: no PROOF CHECK line`);
  const confirmed = text.split(/\r?\n/).filter((l) => /CONFIRMED/.test(l) && /proof does not prove/i.test(l));
  for (const n of names) {
    for (const r of p.get(n)["PROOF CHECK"]) {
      const res = r.match(/^(fails|passes|not checked)\b/i)?.[1].toLowerCase();
      if (!res) gaps.push(`${n}: PROOF CHECK result must be fails, passes or not checked, got ${JSON.stringify(r)}`);
      else if (res === "passes" && !confirmed.some((l) => l.includes(n))) gaps.push(`${n}: passes without the change but no CONFIRMED "proof does not prove" finding names it`);
    }
  }
  return gaps;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const flag = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
  const role = args.includes("--coder") ? "coder" : args.includes("--reviewer") ? "reviewer" : null;
  const src = role && flag(role);
  if (!role || !src || (args.includes("--coder") && args.includes("--reviewer"))) { console.error("usage: proof-check.mjs --coder|--reviewer <file|-> [--tests a,b] [--root .] [--profile f]"); process.exit(64); }
  let text;
  try { text = readFileSync(src === "-" ? 0 : src, "utf8"); } catch { console.error(`proof-check: cannot read ${src}`); process.exit(64); }
  const tests = (flag("tests") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const testFirst = role === "coder" && loadProfile(flag("root") ?? ".", flag("profile")).data?.test_first_commit === "yes";
  const gaps = role === "coder" ? checkCoder(text, { tests, testFirst }) : checkReviewer(text, { tests });
  for (const g of gaps) console.log(`proof gap: ${g}`);
  if (gaps.length) process.exit(2);
  console.log(`proof ok: ${role}`);
}
