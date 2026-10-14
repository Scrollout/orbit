// Replays a session ledger against the `script`-tagged rules and prints violations by rule id. Zero dependencies.
//   node <plugin>/scripts/audit-ledger.mjs <ledger.jsonl> [--root .] [--profile .agents/project.md]
// The ledger defaults to the profile's ledger_path. Exit 64: no readable ledger. Exit 1 on any violation, invalid line, empty ledger or profile gap. Every event has ts (ISO 8601 with UTC offset,
// non-decreasing per session), session, rule_version and kind. Kinds and their fields (README, Session ledger):
//   triage{topic,sec,door,prod,track,files?}   topic is the branch name
//   agent_start{role,model,topic,phase?,fix_scope?,cap_reason?,outside_cap?,resumed?,worker?,reason?}   phase: design | build | fix | delivery
//   ci_run{branch?,sha,workflow?,state|conclusion}   branch (= topic) makes that topic's reviewers delivery reviewers by default; without it the run counts for no topic. green = state green or conclusion success
//   review_start{branch,sha,ci_state,role?}    role reviewer (default) or re-reviewer
//   merge_built{branch (required),merge_sha,tree_equal,ci_state,waived?,waiver_reason?}   waived: a profile standing_waivers entry, or "owner" + waiver_reason
//   push{ref,sha,chained,by}                   by: agent or owner, compared with the profile's base_pusher
//   issue_close{n,origin_base_sha,merge_sha}
// The ledger is self-reported by the operator: the audit finds drift, it does not prove honesty.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gaps, loadProfile, matchesAny } from "./profile.mjs";

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
let file = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
const { data: profile } = loadProfile(flag("root") ?? ".", flag("profile"));
if (!file) file = resolve(flag("root") ?? ".", profile?.ledger_path || ".agents/ledger.jsonl");
if (!existsSync(file)) { console.error(`audit-ledger: cannot read ledger ${file}`); process.exit(64); }
const pg = gaps(profile).filter((g) => ["base_branch", "security_paths", "base_pusher"].includes(g));
if (pg.length) { for (const g of pg) console.log(`profile gap: ${g}`); process.exit(1); }
const base = profile.base_branch;
const T = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "rules", "tracks.json"), "utf8"));

const violations = [];
const v = (ids, n, msg) => { for (const id of [].concat(ids)) violations.push({ id, n, line: `${id} line ${n}: ${msg}` }); };
const KINDS = ["triage", "agent_start", "ci_run", "review_start", "merge_built", "push", "issue_close"];
const short = (s) => String(s).slice(0, 8);
const norm = (r) => String(r).replace(/^\+/, "").split(":").pop().replace(/^refs\/heads\//, "").replace(/^origin\//, "");
const dict = () => Object.create(null);
const NEEDS = { triage: ["topic", "sec", "door", "prod", "track"], agent_start: ["role", "model", "topic"], ci_run: ["sha"], review_start: ["branch", "sha"], merge_built: ["branch", "merge_sha"], push: ["ref"], issue_close: ["merge_sha"] };
const isGreen = (e) => e.state === "green" || e.conclusion === "success";
const isRed = (e) => e.state === "red" || ["failure", "cancelled", "timed_out", "startup_failure"].includes(e.conclusion);

const triage = dict(), sticky = dict(), counts = dict(), ci = dict(), versions = new Set(), lastTs = dict(), lastCoder = dict(), workerModel = dict();
const branchState = dict();           // per branch: reviewed shas, fixSince, reReviews since the last fix
const merges = dict(), basePushes = new Set();
const sawCi = new Set(), warns = [];   // sawCi: topics (branches) with a ci_run
let n = 0, events = 0;

for (const raw of readFileSync(file, "utf8").split("\n")) {
  n++;
  if (!raw.trim()) continue;
  let e;
  try { e = JSON.parse(raw); } catch { v("LEDGER", n, "invalid JSON"); continue; }
  if (!KINDS.includes(e.kind)) { v("LEDGER", n, `unknown kind ${e.kind}`); continue; }
  events++;
  const t = Date.parse(e.ts);
  if (typeof e.ts !== "string" || !/^\d{4}-\d\d-\d\dT[\d:.]+(Z|[+-]\d\d:\d\d)$/.test(e.ts) || Number.isNaN(t)) v("LEDGER", n, "ts missing or not ISO 8601 with a UTC offset");
  else {
    if (lastTs[e.session] > t) v("LEDGER", n, `ts goes backwards in session ${e.session}`);
    lastTs[e.session] = t;
  }
  if (typeof e.session !== "string" || !e.session) v("LEDGER", n, "missing session");
  if (!e.rule_version || typeof e.rule_version !== "object") v("LEDGER", n, "missing rule_version");
  const missing = NEEDS[e.kind].filter((f) => e[f] === undefined || e[f] === null || e[f] === "");
  if (e.kind === "ci_run" && e.state === undefined && e.conclusion === undefined) missing.push("state or conclusion");
  for (const f of missing) v("LEDGER", n, `${e.kind} needs ${f}`);
  if (e.kind === "agent_start" && "worker" in e && (typeof e.worker !== "string" || e.worker === "")) { v("LEDGER", n, "agent_start worker must be a non-empty string"); continue; }
  if (missing.length) continue;
  if (e.rule_version) versions.add(Object.entries(e.rule_version).map(([k, x]) => `${k}=${x}`).join(","));
  const bs = (b) => (branchState[b] ??= { reviewed: new Set(), lastSha: null, fixSince: false, reReviews: 0, reviewed_any: false });

  switch (e.kind) {
    case "triage": {
      if (!Array.isArray(e.files)) warns.push(`warn: line ${n}: triage without files: DEC-02 not checked for topic ${e.topic}`);
      const forced = Array.isArray(e.files) && e.files.some((f) => matchesAny(f, profile.security_paths));
      if (forced && e.sec !== "yes") v("DEC-02", n, `topic ${e.topic} touches a security path but triage says security ${e.sec}`);
      if (sticky[e.topic] && e.sec !== "yes") v("DEC-02", n, `topic ${e.topic}: security was yes and a later triage says ${e.sec}`);
      if (e.sec === "yes" || forced) sticky[e.topic] = true;
      if (!T.tracks[e.track]) v("LEDGER", n, `unknown track ${e.track}`);
      triage[e.topic] = { ...e, sec: sticky[e.topic] ? "yes" : e.sec };
      break;
    }
    case "agent_start": {
      const tr = triage[e.topic];
      if (!tr) v("DEC-03", n, `${e.role} started on ${e.topic} with no triage event before it`);
      if (e.role === "coder") {
        const prev = lastCoder[e.topic], wprev = e.worker !== undefined ? workerModel[e.worker] : undefined;
        if (e.resumed === true && prev && prev !== e.model) v("DEC-04", n, `resumed coder on ${e.topic} changed model ${prev} -> ${e.model}; a resumed worker keeps its model, start a fresh coder to change it`);
        else if (wprev && wprev !== e.model) v("DEC-04", n, `worker ${e.worker} on ${e.topic} changed model ${wprev} -> ${e.model}; a resumed worker keeps its model, start a fresh coder (new worker id) to change it`);
        if (e.worker !== undefined) workerModel[e.worker] ??= e.model;
        if (e.reason === "ci-failed-twice" && e.model !== "opus") v("DEC-04", n, `coder re-run after CI failed twice on ${e.topic} needs opus, got ${e.model}`);
        lastCoder[e.topic] = e.model;
        if (e.phase === "fix") { bs(e.topic).fixSince = true; bs(e.topic).reReviews = 0; }
        if (tr && [tr.sec, tr.door, tr.prod].includes("yes") && e.model !== "opus" && !(e.phase === "fix" && e.fix_scope === "tests-docs"))
          v("DEC-04", n, `coder on ${e.model} for ${e.topic} with a triage line yes (needs opus)`);
      }
      if (e.role === "reviewer" && e.model !== "opus") v("DEC-19", n, `reviewer on ${e.model}, needs opus`);
      if (e.role === "re-reviewer" && e.model !== "opus" && !(e.model === "sonnet" && e.fix_scope === "tests-docs")) v("DEC-19", n, `re-reviewer on ${e.model} (sonnet only for a tests-or-docs-only fix round)`);
      const phase = e.phase ?? (e.role === "reviewer" ? (sawCi.has(e.topic) ? "delivery" : "design") : undefined);
      const delivery = e.role === "reviewer" && phase === "delivery";
      if (delivery && e.phase === "delivery" && !sawCi.has(e.topic)) v("DEC-03", n, `${e.topic}: delivery reviewer with no ci_run for the topic before it`);
      if (e.outside_cap && !e.cap_reason) v("DEC-03", n, `${e.topic}: outside_cap without a cap_reason`);
      if (T.roles.includes(e.role) && !delivery && !e.cap_reason && !e.outside_cap) {
        const c = (counts[e.topic] ??= Object.assign(dict(), { total: 0 }));
        c[e.role] = (c[e.role] ?? 0) + 1;
        c.total++;
        const caps = tr && T.tracks[tr.track];
        if (caps && (c[e.role] > caps[e.role][1] || c.total > caps.max)) v("DEC-03", n, `${e.topic}: ${e.role} call ${c[e.role]}, total ${c.total} exceeds the ${tr.track} caps without a cap_reason`);
      }
      break;
    }
    case "ci_run": {
      if (e.branch) sawCi.add(e.branch);
      ((ci[e.sha] ??= {})[e.workflow ?? "default"] = isGreen(e) ? "green" : isRed(e) ? "red" : "pending");
      break;
    }
    case "review_start": {
      const runs = Object.values(ci[e.sha] ?? {});
      const red = runs.includes("red");
      const green = runs.length > 0 && runs.every((s) => s === "green");
      if (e.ci_state !== "green" || !green) v("DEC-01", n, `review of ${e.branch}@${short(e.sha)} started without green CI on every recorded workflow (ci_state ${e.ci_state})`);
      if (red || e.ci_state === "red") v("DEC-16", n, `review of ${e.branch}@${short(e.sha)} started on a red CI run`);
      if (!triage[e.branch]) warns.push(`warn: line ${n}: review_start branch ${e.branch} has no triage topic (topic must equal the branch name)`);
      const b = bs(e.branch), role = e.role ?? "reviewer";
      b.reviewed_any = true;
      if (role === "re-reviewer") {
        if (!b.fixSince) v("DEC-14", n, `re-reviewer on ${e.branch} with no fix round since the last review`);
        if (++b.reReviews > 1) v("DEC-14", n, `re-reviewer ran more than once on ${e.branch} for one fix round`);
      }
      if (b.fixSince && e.sha === b.lastSha) v("DEC-14", n, `fix-round review on ${e.branch} used the old sha ${short(e.sha)}`);
      else if (!b.fixSince && b.reviewed.has(e.sha) && role !== "re-reviewer") v("DEC-14", n, `${e.branch}@${short(e.sha)} reviewed twice without a fix in between`);
      b.reviewed.add(e.sha); b.lastSha = e.sha; b.fixSince = false;
      break;
    }
    case "merge_built": {
      for (const id of ["DEC-05", "OPR-02"]) {
        if (e.tree_equal !== true) v(id, n, `merge ${short(e.merge_sha)}: merged tree not equal to the branch tree`);
        if (e.ci_state !== "green") v(id, n, `merge ${short(e.merge_sha)}: CI on the catch-up merge commit is ${e.ci_state}, not green`);
      }
      if (!bs(e.branch).reviewed_any) {
        const standing = profile.standing_waivers ?? [];
        if (e.waived === undefined || e.waived === false) v("DEC-20", n, `merge of ${e.branch} with no review_start on it and no waiver`);
        else if (e.waived === "owner") { if (!e.waiver_reason) v("DEC-20", n, `merge of ${e.branch}: owner waiver needs a waiver_reason`); }
        else if (!standing.includes(e.waived)) v("DEC-20", n, `merge of ${e.branch}: waived must cite a standing waiver of the profile (${standing.join(", ") || "none defined"}) or be "owner", got ${JSON.stringify(e.waived)}`);
      }
      merges[e.merge_sha] = e;
      break;
    }
    case "push": {
      if (norm(e.ref) !== base) break;
      if (e.chained !== false) v(["DEC-06", "OPR-03"], n, `base ${base} pushed chained after another command`);
      if (e.by !== profile.base_pusher) v(["DEC-06", "OPR-03"], n, `base ${base} pushed by ${e.by ?? "unknown"}, the profile says ${profile.base_pusher}`);
      if (!merges[e.sha]) v(["DEC-06", "OPR-03"], n, `base ${base} pushed at ${short(e.sha)} with no merge_built for that sha before it`);
      basePushes.add(e.sha);
      break;
    }
    case "issue_close": {
      if (!merges[e.merge_sha]) v(["DEC-07", "OPR-04"], n, `issue #${e.n} closed for ${short(e.merge_sha)}, which no merge_built built`);
      if (!basePushes.has(e.merge_sha)) v(["DEC-07", "OPR-04"], n, `issue #${e.n} closed before a base push of ${short(e.merge_sha)}`);
      if (e.origin_base_sha !== e.merge_sha) v(["DEC-07", "OPR-04"], n, `issue #${e.n} closed while origin/${base} (${short(e.origin_base_sha)}) is not the merge sha (${short(e.merge_sha)})`);
      break;
    }
  }
}
for (const w of warns) console.log(w);
if (!events && !violations.length) v("LEDGER", 1, "empty ledger");
if (violations.length) {
  for (const x of violations.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.n - b.n))) console.log(x.line);
  process.exit(1);
}
console.log(`audit ok: ${events} events, rule versions: ${[...versions].join(" | ") || "none recorded"}`);
