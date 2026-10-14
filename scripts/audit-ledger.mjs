// Replays a session ledger against the `script`-tagged rules and prints violations by rule id. Zero dependencies.
//   node <plugin>/scripts/audit-ledger.mjs <ledger.jsonl> [--root .] [--profile .agents/project.md]
// Exit 1 on any violation, invalid line or profile gap. Event kinds (fields beyond ts, session, rule_version, kind):
//   triage{topic,sec,door,prod,track,files?}  agent_start{role,model,topic,phase?,fix_scope?,cap_reason?}
//   ci_run{sha,state}  review_start{branch,sha,ci_state}  merge_built{merge_sha,tree_equal,ci_state}
//   push{ref,chained}  issue_close{n,origin_base_sha,merge_sha}
// The ledger is self-reported by the operator; the audit finds drift, it does not prove honesty.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gaps, loadProfile, matchesAny } from "./profile.mjs";

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const file = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
if (!file) { console.error("usage: audit-ledger.mjs <ledger.jsonl> [--root .] [--profile path]"); process.exit(64); }

const { data: profile } = loadProfile(flag("root") ?? ".", flag("profile"));
const pg = gaps(profile).filter((g) => ["base_branch", "security_paths"].includes(g));
if (pg.length) { for (const g of pg) console.log(`profile gap: ${g}`); process.exit(1); }
const base = profile.base_branch;
const T = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "rules", "tracks.json"), "utf8"));

const violations = [];
const v = (id, n, msg) => violations.push(`${id} line ${n}: ${msg}`);
const KINDS = ["triage", "agent_start", "ci_run", "review_start", "merge_built", "push", "issue_close"];
const triage = {}, greens = new Set(), counts = {}, versions = new Set();
let n = 0, events = 0;
const norm = (r) => String(r).replace(/^refs\/heads\//, "").replace(/^origin\//, "");

for (const raw of readFileSync(file, "utf8").split("\n")) {
  n++;
  if (!raw.trim()) continue;
  let e;
  try { e = JSON.parse(raw); } catch { v("LEDGER", n, "invalid JSON"); continue; }
  if (!KINDS.includes(e.kind)) { v("LEDGER", n, `unknown kind ${e.kind}`); continue; }
  events++;
  if (e.rule_version) versions.add(Object.entries(e.rule_version).map(([k, x]) => `${k}=${x}`).join(","));
  switch (e.kind) {
    case "triage": {
      triage[e.topic] = e;
      if (Array.isArray(e.files) && e.sec !== "yes" && e.files.some((f) => matchesAny(f, profile.security_paths))) v("DEC-02", n, `topic ${e.topic} touches a security path but triage says security ${e.sec}`);
      break;
    }
    case "agent_start": {
      const t = triage[e.topic];
      if (e.role === "coder" && t && [t.sec, t.door, t.prod].includes("yes") && e.model !== "opus" && !(e.phase === "fix" && e.fix_scope === "tests-docs"))
        v("DEC-04", n, `coder on ${e.model} for ${e.topic} with a triage line yes (needs opus)`);
      if (T.roles.includes(e.role) && !e.cap_reason && !e.outside_cap) {
        const c = (counts[e.topic] ??= { total: 0 });
        c[e.role] = (c[e.role] ?? 0) + 1;
        c.total++;
        const caps = t && T.tracks[t.track];
        if (caps && (c[e.role] > caps[e.role][1] || c.total > caps.max)) v("DEC-03", n, `${e.topic}: ${e.role} call ${c[e.role]}, total ${c.total} exceeds the ${t.track} caps without a cap_reason`);
      }
      break;
    }
    case "ci_run": if (e.state === "green") greens.add(e.sha); break;
    case "review_start":
      if (e.ci_state !== "green" || !greens.has(e.sha)) v("DEC-01", n, `review of ${e.branch}@${String(e.sha).slice(0, 8)} started without a recorded green CI run (ci_state ${e.ci_state})`);
      break;
    case "merge_built":
      for (const id of ["DEC-05", "OPR-02"]) {
        if (e.tree_equal !== true) v(id, n, `merge ${String(e.merge_sha).slice(0, 8)}: merged tree not equal to the green tree`);
        if (e.ci_state !== "green") v(id, n, `merge ${String(e.merge_sha).slice(0, 8)}: CI on the merge commit is ${e.ci_state}, not green`);
      }
      break;
    case "push":
      if (norm(e.ref) === base && e.chained !== false) for (const id of ["DEC-06", "OPR-03"]) v(id, n, `base ${base} pushed chained after another command`);
      break;
    case "issue_close":
      if (e.origin_base_sha !== e.merge_sha) for (const id of ["DEC-07", "OPR-04"]) v(id, n, `issue #${e.n} closed while origin/${base} (${String(e.origin_base_sha).slice(0, 8)}) is not the merge sha (${String(e.merge_sha).slice(0, 8)})`);
      break;
  }
}
if (violations.length) {
  for (const x of violations.sort()) console.log(x);
  process.exit(1);
}
console.log(`audit ok: ${events} events, rule versions: ${[...versions].join(" | ") || "none recorded"}`);
