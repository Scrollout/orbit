// Fails a merge-ready topic while a security condition has no proof test. Zero dependencies, no model.
//   node <plugin>/scripts/condition-check.mjs [<ledger.jsonl>] [--topic <branch>] [--root .] [--profile .agents/project.md] [--json]
// Reads the `condition` events of the session ledger (default: the profile's ledger_path): `topic`, `id`, `step`, `test` (the proof
// test name) and `status` (`open` or `proved`). The latest event of an id on a topic counts. The security officer's `conditions`
// verdict opens one event per condition; the operator appends `proved` when the test is proved. A condition is a gap when:
//   - its status is not `open` or `proved`, or its step or test is empty
//   - it is still `open`
//   - it is `proved` but its test is in no `coder_report` `tests` of the topic and in no `proof_check` of it with result `fails`
//     that comes after the condition's first (opening) event, or the last `proof_check` of that test is `passes`
// Without --topic every topic is checked; with --topic and no condition event of that topic it fails (`no conditions for topic`).
// Lines that are not JSON objects are skipped. Output: one `condition gap: <topic> <id>: <what>` line per gap; exit 0 ok, 2 gaps,
// 64 no readable ledger or bad usage. The ledger is self-reported: this finds a missing proof, it does not prove honesty.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadProfile } from "./profile.mjs";

export function conditionGaps(events, topic) {
  const latest = new Map(), opened = new Map(), proved = new Map(), failsAt = new Map(), lastCheck = new Map();
  let seen = false;
  events.forEach((e, i) => {
    if (!e || typeof e !== "object" || Array.isArray(e)) return;
    if (e.kind === "condition" && typeof e.topic === "string" && typeof e.id === "string") {
      const k = `${e.topic}\n${e.id}`;
      latest.set(k, e);
      if (!opened.has(k)) opened.set(k, i);
      if (e.topic === topic) seen = true;
    }
    const b = e.branch;
    if (e.kind === "coder_report" && typeof b === "string" && Array.isArray(e.tests)) for (const t of e.tests) proved.set(`${b}\n${t}`, i);
    if (e.kind === "proof_check" && typeof b === "string") { lastCheck.set(`${b}\n${e.test}`, e.result); if (e.result === "fails") failsAt.set(`${b}\n${e.test}`, i); }
  });
  const gaps = [];
  if (topic && !seen) gaps.push(`${topic}: no conditions for topic`);
  for (const [k, c] of latest) {
    if (topic && c.topic !== topic) continue;
    const g = (m) => gaps.push(`${c.topic} ${c.id}: ${m}`);
    if (!["open", "proved"].includes(c.status)) { g(`status must be open or proved, got ${JSON.stringify(c.status ?? null)}`); continue; }
    if (typeof c.step !== "string" || !c.step) g("no step");
    if (typeof c.test !== "string" || !c.test) { g("no proof test name"); continue; }
    if (c.status === "open") { g(`open, proof test ${c.test} not proved yet`); continue; }
    const key = `${c.topic}\n${c.test}`, res = lastCheck.get(key), from = opened.get(k);
    if (res === "passes") g(`proof test ${c.test} passes without the change: it does not prove the condition`);
    else if (!(proved.get(key) > from) && !(failsAt.get(key) > from)) g(`proof test ${c.test} is in no coder_report and has no failing proof_check of the topic after the condition was opened`);
  }
  return gaps;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const flag = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
  for (const n of ["topic", "root", "profile"]) if (args.includes(`--${n}`) && (flag(n) === undefined || flag(n).startsWith("--"))) { console.error(`condition-check: --${n} needs a value`); process.exit(64); }
  const file = args.find((a, i) => !a.startsWith("--") && !(i > 0 && ["--topic", "--root", "--profile"].includes(args[i - 1])))
    ?? resolve(flag("root") ?? ".", loadProfile(flag("root") ?? ".", flag("profile")).data?.ledger_path || ".agents/ledger.jsonl");
  if (!existsSync(file)) { console.error(`condition-check: cannot read ledger ${file}`); process.exit(64); }
  const events = [];
  for (const l of readFileSync(file, "utf8").split("\n")) { try { events.push(JSON.parse(l)); } catch { /* the audit reports invalid lines */ } }
  const gaps = conditionGaps(events, flag("topic"));
  if (args.includes("--json")) { console.log(JSON.stringify({ gaps })); process.exit(gaps.length ? 2 : 0); }
  for (const g of gaps) console.log(`condition gap: ${g}`);
  if (gaps.length) process.exit(2);
  console.log("condition ok");
}
