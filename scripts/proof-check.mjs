// Checks the TDD evidence in a coder's report (DEC-21) or a reviewer's answer (DEC-22). Zero dependencies, no model.
//   node <plugin>/scripts/proof-check.mjs --coder <file|-> [--test <name>]... [--root .] [--profile .agents/project.md] [--json]
//   node <plugin>/scripts/proof-check.mjs --reviewer <file|-> (--coder-report <file> | --test <name>...)
// Lines: a label, a space, the exact test name, ` -- `, then the text. The name ends at the first ` -- ` (pytest ids,
// Go subtests and names with spaces or colons are fine; a name that contains ` -- ` is not supported). A leading `- ` or `* ` is allowed.
//   RED <test> -- <a line of the test failing without the change>       (one or more)
//   GREEN <test> -- <a line of the test passing with it>                (one or more)
//   CANNOT FAIL FIRST <test> -- <reason>      exempt from the revert check (docs only, a pure refactor, no targeted-test command in the profile)
//   TEST FIRST <test> -- <sha>                when the profile says test_first_commit: yes: the commit of the failing test, before the fix
//   PROOF CHECK <test> -- fails | passes | not checked: <reason> | exempt [<one line on the coder's reason>]
// Coder: each test needs RED and GREEN, or CANNOT FAIL FIRST with a reason; every --test name needs one of them. The lines are
// checked for presence, not content. --json prints {required, exempt, gaps}: required are the tests with RED/GREEN (the ledger's
// coder_report `tests`), exempt the CANNOT FAIL FIRST ones.
// Reviewer: every required test (from --coder-report, or the --test names) needs a PROOF CHECK line whose last result is fails,
// passes or `not checked: <reason>`; an exempt test needs none, or `exempt` or `not checked: <reason>`; `exempt` is refused for a
// required test. A `passes` needs a CONFIRMED finding line that says "proof does not prove" and names the test exactly.
// `fails` means the test built, ran and failed; a build failure or anything that kept it from running is `not checked: <reason>`.
// Output: one `proof gap: <what>` line per gap; exit 0 ok, 2 gaps, 64 bad usage.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadProfile } from "./profile.mjs";

const LABELS = ["RED", "GREEN", "CANNOT FAIL FIRST", "TEST FIRST", "PROOF CHECK"];
const LINE = /^\s*(?:[-*]\s+)?(RED|GREEN|CANNOT FAIL FIRST|TEST FIRST|PROOF CHECK) (.+?) --(?: (.*))?$/;

export function parse(text) {
  const out = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(LINE);
    if (!m) continue;
    const name = m[2].trim();
    if (!out.has(name)) out.set(name, Object.fromEntries(LABELS.map((l) => [l, []])));
    out.get(name)[m[1]].push((m[3] ?? "").trim());
  }
  return out;
}

const filled = (xs) => xs.some((x) => x !== "");

// The tests a coder's report proves (RED/GREEN) and the ones it declares exempt (CANNOT FAIL FIRST).
export function coderTests(text) {
  const p = parse(text), required = [], exempt = [];
  for (const [n, e] of p) {
    if (e["CANNOT FAIL FIRST"].length) exempt.push(n);
    else if (e.RED.length || e.GREEN.length) required.push(n);
  }
  return { required, exempt };
}

export function checkCoder(text, { tests = [], testFirst = false } = {}) {
  const p = parse(text), gaps = [], { required, exempt } = coderTests(text);
  if (!required.length && !exempt.length && !tests.length) gaps.push("no RED/GREEN or CANNOT FAIL FIRST lines in the report");
  for (const t of tests) if (!required.includes(t) && !exempt.includes(t)) gaps.push(`${t}: no evidence`);
  for (const n of exempt) {
    if (!filled(p.get(n)["CANNOT FAIL FIRST"])) gaps.push(`${n}: CANNOT FAIL FIRST needs a reason`);
    if (p.get(n).RED.length) gaps.push(`${n}: both RED and CANNOT FAIL FIRST`);
  }
  for (const n of required) {
    const e = p.get(n);
    if (!filled(e.RED)) gaps.push(`${n}: no RED line (the test failing without the change)`);
    if (!filled(e.GREEN)) gaps.push(`${n}: no GREEN line (the test passing with the change)`);
    if (testFirst && !e["TEST FIRST"].some((s) => /^[0-9a-f]{7,40}$/i.test(s))) gaps.push(`${n}: test_first_commit is yes but no TEST FIRST <sha> line`);
  }
  return gaps;
}

// The name appears in the line as a whole: not inside a longer name (TestA in TestAB, TestA/sub or test_a[1]).
export function namesExactly(line, name) {
  for (let i = line.indexOf(name); i >= 0; i = line.indexOf(name, i + 1)) {
    const before = i === 0 ? "" : line[i - 1], after = line.slice(i + name.length);
    const okBefore = before === "" || !/[\w/\[:.-]/.test(before);
    const okAfter = after === "" || /^[\s`'"(),;]/.test(after) || /^[.:](\s|$)/.test(after);
    if (okBefore && okAfter) return true;
  }
  return false;
}

export function checkReviewer(text, { required = [], exempt = [] } = {}) {
  const p = parse(text), gaps = [];
  const confirmed = text.split(/\r?\n/).filter((l) => /\bCONFIRMED\b/i.test(l) && /proof does not prove/i.test(l));
  const results = new Map();
  for (const [n, e] of p) {
    if (!e["PROOF CHECK"].length) continue;
    const r = e["PROOF CHECK"].at(-1);
    const res = /^(fails|passes)$/i.test(r) ? r.toLowerCase() : /^not checked:\s*\S/i.test(r) ? "not checked" : /^exempt\b/i.test(r) ? "exempt" : null;
    if (!res) { gaps.push(`${n}: PROOF CHECK must be fails, passes, not checked: <reason> or exempt, got ${JSON.stringify(r)}`); continue; }
    results.set(n, res);
    if (res === "passes" && !confirmed.some((l) => namesExactly(l, n))) gaps.push(`${n}: passes without the change but no CONFIRMED "proof does not prove" finding names it`);
    if (res === "exempt" && !exempt.includes(n)) gaps.push(`${n}: exempt only for a test the coder declared CANNOT FAIL FIRST`);
  }
  for (const t of required) if (!results.has(t)) gaps.push(`${t}: no PROOF CHECK line`);
  return gaps;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const flag = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
  const many = (n) => args.flatMap((a, i) => (a === `--${n}` && i + 1 < args.length ? [args[i + 1]] : []));
  const usage = () => { console.error("usage: proof-check.mjs --coder <file|-> [--test <name>]... [--root .] [--profile f] [--json]\n       proof-check.mjs --reviewer <file|-> (--coder-report <file> | --test <name>...)"); process.exit(64); };
  const read = (f) => { try { return readFileSync(f === "-" ? 0 : f, "utf8"); } catch { console.error(`proof-check: cannot read ${f}`); process.exit(64); } };
  const role = args.includes("--coder") ? "coder" : args.includes("--reviewer") ? "reviewer" : null;
  const src = role && flag(role), tests = many("test");
  if (!role || !src || (args.includes("--coder") && args.includes("--reviewer"))) usage();
  if (args.includes("--test") && (!tests.length || tests.some((t) => t.startsWith("--")))) usage();
  const text = read(src);
  let gaps;
  if (role === "coder") {
    const testFirst = loadProfile(flag("root") ?? ".", flag("profile")).data?.test_first_commit === "yes";
    gaps = checkCoder(text, { tests, testFirst });
    if (args.includes("--json")) { console.log(JSON.stringify({ ...coderTests(text), gaps })); process.exit(gaps.length ? 2 : 0); }
  } else {
    const cr = flag("coder-report");
    if (!cr && !tests.length) usage();
    const from = cr ? coderTests(read(cr)) : { required: [], exempt: [] };
    gaps = checkReviewer(text, { required: [...new Set([...from.required, ...tests])], exempt: from.exempt });
  }
  for (const g of gaps) console.log(`proof gap: ${g}`);
  if (gaps.length) process.exit(2);
  console.log(`proof ok: ${role}`);
}
