// Replays a session ledger against the `script`-tagged rules and prints violations by rule id. Zero dependencies.
//   node <plugin>/scripts/audit-ledger.mjs <ledger.jsonl> [--root .] [--profile .agents/project.md] [--go-log <file>]
//   --go-log: the capture hook's go log (default ~/.claude/orbit/unattended/go-log.jsonl, which the guard keeps agents from writing).
// The ledger defaults to the profile's ledger_path. Exit 64: no readable ledger. Exit 1 on any violation, invalid line, empty ledger or profile gap. Every event has ts (ISO 8601 with UTC offset,
// non-decreasing per session), session, rule_version and kind. Kinds and their fields (README, Session ledger):
//   triage{topic,sec,door,prod,track,files?,tdd?,trigger?,why?,decision_topic?}   topic is the branch name; tdd: true when the profile says tdd: yes (sticky per topic)
//                                              trigger: asked | unasked (unasked needs why), required from rules 1.12.1; files: the changed paths, re-recorded after every coder run (DEC-02);
//                                              every triage starts a new segment (the call order restarts); decision_topic: a plan step decided elsewhere, that topic's security and tech lead calls count at merge_built
//   agent_start{role,model,topic,phase?,fix_scope?,files?,extra?,cap_reason?,outside_cap?,resumed?,worker?,reason?}   phase: design | build | fix | ci-fix | delivery (fix and ci-fix record files)
//                                              extra: research | missing-fact | rebuttal | hypotheses | research-answer | missing-fact-answer (once per topic each; an answer only after its research or missing-fact; rebuttal only on a door=yes triage); files: a fix coder's changed paths, checked against fix_scope
//   owner_go{topic,why?}                       the owner's go to a further fix round after a re-reviewer run (DEC-14)
//   intent{milestone,phase}                    phase: questions | draft | checked | approved | written (approved needs checked, written needs approved)
//   handoff{topic,from,to}                     from and to: decide | intent | operator; at most one handoff per direction per topic
//   ci_run{branch?,sha,workflow?,state|conclusion}   branch (= topic) makes that topic's reviewers delivery reviewers by default; without it the run counts for no topic. green = state green or conclusion success
//   review_start{branch,sha,ci_state,role?}    role reviewer (default) or re-reviewer
//   merge_built{branch (required),merge_sha,tree_equal,ci_state,catchup_sha?,waived?,waiver_reason?,release_skip?}   catchup_sha: head of the catch-up merge, must have a green ci_run (required from rules 1.12.1)   waived: a profile standing_waivers entry, or "owner" + waiver_reason; release_skip: why this merge is not released
//   push{ref,sha,chained,by}                   by: agent or owner, compared with the profile's base_pusher
//   outward{class,subcommand,refs?,sha?,session_kind?,agent_id?,exit_code?}   a shared or destructive action the capture hook saw run (class go: the unattended go's own action, with the sha pushed); recorded, never an authorisation, except that a go base push with a matching go log record is the owner's push for DEC-06
//   issue_close{n,origin_base_sha,merge_sha}
//   tag_push{tag,ref,sha,by,annotated,chained,signed?}   ref: refs/tags/<tag>   by: agent or owner (ci when a release_tool tags)
//   release{tag,url?,via?,verify_tag?,latest?,prerelease?}   via: session (default) or ci
//   coder_report{branch,evidence,tests,exempt?,sha?}   evidence: ok or gap, the exit of scripts/proof-check.mjs --coder (DEC-21); tests: the proved
//                                              (RED/GREEN) test names, exempt: the CANNOT FAIL FIRST ones (proof-check --json)
//   proof_check{branch,sha,test,result}        result: fails, passes, not-checked or exempt, one per PROOF CHECK line (DEC-22)
//   condition{topic,id,step,test,status}       a security condition and its proof test; status open or proved (checked by scripts/condition-check.mjs)
// DEC-21 and DEC-22 apply only to a topic whose triage recorded tdd: true (unset or false: neither, as before 0.15.0).
// DEC-21 applies to a review when the last coder run (or, without one, the review) is stamped with rules 1.7.0 or later; DEC-22's
// coverage when the coder_report before the review is. A rules version going backwards in the ledger is a LEDGER violation.
// The loop-cap checks (re-triage, order, minimums, unknown role, extras, handoff, track vs triage, incident Opus, owner_go, trigger, catchup_sha, fix files) apply only to events stamped
// with rules 1.12.1 or later; an older ledger audits as before.
// The ledger is self-reported by the operator: the audit finds drift, it does not prove honesty.
import { semverExec } from "./rx.mjs";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gaps, loadProfile, matchesAny } from "./profile.mjs";
import { codeFiles } from "./paths.mjs";
import { suggestTdd } from "./tdd-suggest.mjs";

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
const KINDS = ["triage", "agent_start", "ci_run", "review_start", "merge_built", "push", "issue_close", "tag_push", "release", "coder_report", "proof_check", "condition", "intent", "handoff", "owner_go", "outward"];
const short = (s) => String(s).slice(0, 8);
const norm = (r) => String(r).replace(/^\+/, "").split(":").pop().replace(/^refs\/heads\//, "").replace(/^origin\//, "");
const dict = () => Object.create(null);
const NEEDS = { triage: ["topic", "sec", "door", "prod", "track"], agent_start: ["role", "model", "topic"], ci_run: ["sha"], review_start: ["branch", "sha"], merge_built: ["branch", "merge_sha"], push: ["ref"], issue_close: ["merge_sha"], tag_push: ["tag", "sha", "by"], release: ["tag"], coder_report: ["branch", "evidence", "tests"], proof_check: ["branch", "sha", "test", "result"], condition: ["topic", "id", "step", "test", "status"], intent: ["milestone", "phase"], handoff: ["topic", "from", "to"], owner_go: ["topic"], outward: ["class", "subcommand"] };
const isGreen = (e) => e.state === "green" || e.conclusion === "success";
// DEC-21, DEC-22: only for events stamped with rules 1.7.0 or later
const semParts = (x) => { const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(x ?? "")); return m ? m.slice(1).map(Number) : null; };
const verCmp = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
const tddRules = (e) => { const r = semParts(e?.rule_version?.rules); return !!r && verCmp(r, [1, 7, 0]) >= 0; };
const newRules = (e) => { const r = semParts(e?.rule_version?.rules); return !!r && verCmp(r, [1, 12, 1]) >= 0; };   // the loop-cap checks: an event stamped below 1.12.1 audits as before
const ROLES = [...T.roles, "coder", "re-reviewer"], EXTRAS = ["research", "missing-fact", "rebuttal", "hypotheses", "research-answer", "missing-fact-answer"], ANSWERS = { "research-answer": "research", "missing-fact-answer": "missing-fact" };
const RANK = { analyst: 0, engineer: 1, reviewer: 2, security: 3, techlead: 4 };   // design-call order; incident: security first
const INTENT_PHASES = ["questions", "draft", "checked", "approved", "written"], PARTIES = ["decide", "intent", "operator"];
const decisionTopic = dict(), made = dict(), extras = dict(), maxRank = dict(), lastFix = dict(), coderLine = dict(), triageFilesLine = dict(), handoffs = dict(), intentSeen = dict();
const gated = dict();      // topics with an event stamped rules 1.12.1 or later
const maxRules = dict();   // per tdd-on topic
let maxRulesAll = null;    // ledger-wide, with the profile's tdd yes or auto
const tddOn = new Set();   // topics whose triage recorded tdd: true
const rulesSeen = dict();
// Two shas name the same commit when one is a prefix of the other (a hand-appended event may carry a short sha).
const sameSha = (a, b) => typeof a === "string" && typeof b === "string" && a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a));
const isRed = (e) => e.state === "red" || ["failure", "cancelled", "timed_out", "startup_failure"].includes(e.conclusion);

const triage = dict(), sticky = dict(), counts = dict(), ci = dict(), versions = new Set(), lastTs = dict(), lastCoder = dict(), workerModel = dict();
const branchState = dict();           // per branch: reviewed shas, fixSince, reReviews since the last fix
const merges = dict(), basePushes = new Set();
// OPR-09: releases. release_when TODO or unset: per-event checks only, and a warn once a base push exists.
const isSet = (x) => typeof x === "string" && x !== "" && !/^TODO\b/i.test(x);
const relWhen = ["change-set", "milestone", "never"].includes(profile.release_when) ? profile.release_when : null;
const relVia = ["ci", "session"].includes(profile.release_via) ? profile.release_via : null;
const relTool = isSet(profile.release_tool) && profile.release_tool !== "none" ? profile.release_tool : null;
const semCmp = (a, b) => { for (let i = 1; i <= 3; i++) { const d = Number(a[i]) - Number(b[i]); if (d) return d; } return 0; };
const linePushes = new Set();         // pushes to a release/X.Y maintenance line, alone and by base_pusher: its tags are allowed
const tagSha = dict(), releasedTags = new Set(), releasedShas = new Set();
let pendingRelease = null;            // change-set mode without a release tool: the last base-pushed merge awaiting its release
const sawCi = new Set(), warns = [];   // sawCi: topics (branches) with a ci_run
let n = 0, events = 0;
// The unattended go is the owner's approval (threat model): a base push its `go` event records (same session, sha, exit 0) is the
// owner's push for DEC-06, only when the go log (written by the capture hook under ~/.claude, guard-protected) has the same record.
const goLogFile = flag("go-log") ?? (process.env.HOME ? join(process.env.HOME, ".claude", "orbit", "unattended", "go-log.jsonl") : null);
const goLogged = new Set();
if (goLogFile && existsSync(goLogFile)) {
  for (const raw of readFileSync(goLogFile, "utf8").split("\n")) {
    try { const e = JSON.parse(raw); if (e?.subcommand === "push" && e.exit_code === 0 && typeof e.sha === "string") goLogged.add(`${e.session} ${e.sha}`); } catch { /* a torn line counts for nothing */ }
  }
}
const goPushes = new Set();
for (const raw of readFileSync(file, "utf8").split("\n")) {
  try { const e = JSON.parse(raw); if (e?.kind === "outward" && e.class === "go" && e.subcommand === "push" && e.exit_code === 0 && e.sha && goLogged.has(`${e.session} ${e.sha}`)) goPushes.add(`${e.session} ${e.sha}`); } catch { /* reported below */ }
}

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
  const bs = (b) => (branchState[b] ??= { reviewed: new Set(), lastSha: null, fixSince: false, reReviews: 0, reviewed_any: false, evidence: null, coderEvent: null, report: null, required: null, checked: new Set(), blocked: new Set(), reRan: false, go: false, ciRed: false });

  switch (e.kind) {
    case "triage": {
      if ("tdd" in e && typeof e.tdd !== "boolean") v("LEDGER", n, `triage tdd must be true or false, got ${JSON.stringify(e.tdd)}`);
      if (e.tdd === true) tddOn.add(e.topic);
      if (profile.tdd === "yes" && tddRules(e) && !tddOn.has(e.topic)) v("LEDGER", n, `triage of ${e.topic} has no tdd: true, but the profile says tdd: yes`);
      if (profile.tdd === "auto" && e.tdd === false && Array.isArray(e.files)) {
        // reproducible from the ledger: tests present only if the triage files include one (the repo is not read)
        const s = suggestTdd({ targetedTest: profile.targeted_test, files: e.files, sec: e.sec, door: e.door, proof: [], repoHasTests: false });
        const code = codeFiles(e.files);
        if (s.tdd && (e.sec === "yes" || e.door === "yes")) v("LEDGER", n, `triage of ${e.topic} records tdd false, but tdd-suggest says yes (${s.reason})`);
        else if (code.length) warns.push(`warn: line ${n}: triage of ${e.topic} touches production code (${code.slice(0, 5).join(", ")}) with tdd false under tdd: auto`);
      }
      if (profile.tdd === "auto" && tddRules(e) && typeof e.tdd !== "boolean" && !tddOn.has(e.topic)) v("LEDGER", n, `triage of ${e.topic} has no tdd true or false, but the profile says tdd: auto (record decide-triage's tdd line)`);
      if (!Array.isArray(e.files)) warns.push(`warn: line ${n}: triage without files: DEC-02 not checked for topic ${e.topic}`);
      const forced = Array.isArray(e.files) && e.files.some((f) => matchesAny(f, profile.security_paths));
      if (forced && e.sec !== "yes") v("DEC-02", n, `topic ${e.topic} touches a security path but triage says security ${e.sec}`);
      if (sticky[e.topic] && e.sec !== "yes") v("DEC-02", n, `topic ${e.topic}: security was yes and a later triage says ${e.sec}`);
      if (e.sec === "yes" || forced) sticky[e.topic] = true;
      if (!T.tracks[e.track]) v("LEDGER", n, `unknown track ${e.track}`);
      const eff = { ...e, sec: sticky[e.topic] ? "yes" : e.sec };
      if (newRules(e) && T.tracks[e.track] && [eff.sec, eff.door, eff.prod].includes("yes") && !["full review", "incident"].includes(e.track)) v("DEC-03", n, `topic ${e.topic}: a triage line is yes, so the track is full review or incident, not ${e.track}`);
      if (newRules(e)) {
        if ("trigger" in e && !["asked", "unasked"].includes(e.trigger)) v("LEDGER", n, `triage trigger must be asked or unasked, got ${JSON.stringify(e.trigger)}`);
        else if (!("trigger" in e)) v("LEDGER", n, "triage needs trigger (asked or unasked)");
        else if (e.trigger === "unasked" && (typeof e.why !== "string" || !e.why.trim())) v("LEDGER", n, `triage of ${e.topic} started unasked, so it needs why (one line: why the question qualifies)`);
      }
      if (Array.isArray(e.files)) triageFilesLine[e.topic] = n;
      if (newRules(e)) delete maxRank[e.topic];   // every triage starts a new segment: the call order restarts, the minimums stay topic-wide
      if ("decision_topic" in e) {
        if (newRules(e) && (typeof e.decision_topic !== "string" || !e.decision_topic)) v("LEDGER", n, "triage decision_topic must be the topic name of the decision's calls");
        else if (newRules(e) && (e.decision_topic === e.topic || !triage[e.decision_topic])) v("LEDGER", n, `triage decision_topic ${JSON.stringify(e.decision_topic)} must name a different topic with a triage earlier in the ledger (its calls are not counted)`);
        else decisionTopic[e.topic] = e.decision_topic;
      }
      triage[e.topic] = eff;
      break;
    }
    case "agent_start": {
      const tr = triage[e.topic], nw = newRules(e);
      if (!tr) v("DEC-03", n, `${e.role} started on ${e.topic} with no triage event before it`);
      if (nw && !ROLES.includes(e.role)) v("LEDGER", n, `unknown role ${JSON.stringify(e.role)} (${ROLES.join(", ")})`);
      if (nw && "files" in e && !(Array.isArray(e.files) && e.files.every((f) => typeof f === "string"))) v("LEDGER", n, "agent_start files must be a list of paths");
      const x = nw && EXTRAS.includes(e.extra) ? e.extra : undefined;
      if (nw && e.extra !== undefined && !x) v("LEDGER", n, `agent_start extra must be ${EXTRAS.join(", ")}, got ${JSON.stringify(e.extra)}`);
      if (x) {
        const ex = (extras[e.topic] ??= dict());
        ex[x] = (ex[x] ?? 0) + 1;
        if (ex[x] > 1) v("DEC-03", n, `${e.topic}: second ${x} round (once per topic; a cap_reason does not excuse it)`);
        if (ANSWERS[x] && !ex[ANSWERS[x]]) v("DEC-03", n, `${e.topic}: ${x} with no ${ANSWERS[x]} round before it`);
        if (x === "rebuttal") {
          if (tr && tr.door !== "yes") v("DEC-13", n, `${e.topic}: rebuttal on a triage with door ${tr.door} (only a one-way door has a Contest)`);
          if (e.role !== "techlead") v("DEC-13", n, `${e.topic}: the rebuttal is the same tech lead, got role ${e.role}`);
        }
      }
      if (e.role === "coder") {
        const prev = lastCoder[e.topic], wprev = e.worker !== undefined ? workerModel[e.worker] : undefined;
        if (e.resumed === true && prev && prev !== e.model) v("DEC-04", n, `resumed coder on ${e.topic} changed model ${prev} -> ${e.model}; a resumed worker keeps its model, start a fresh coder to change it`);
        else if (wprev && wprev !== e.model) v("DEC-04", n, `worker ${e.worker} on ${e.topic} changed model ${wprev} -> ${e.model}; a resumed worker keeps its model, start a fresh coder (new worker id) to change it`);
        if (e.worker !== undefined) workerModel[e.worker] ??= e.model;
        if (nw && tr?.track === "incident" && e.model !== "opus") v("DEC-04", n, `coder on ${e.model} for ${e.topic} on the incident track (needs opus)`);
        const fixRun = nw && (e.phase === "fix" || e.phase === "ci-fix");
        if (fixRun && !Array.isArray(e.files)) v("LEDGER", n, `coder run with phase ${e.phase} on ${e.topic} needs files (the fix's changed paths), so the fix_scope check can run`);
        if (nw && e.phase === "fix" && e.fix_scope === "tests-docs" && Array.isArray(e.files) && codeFiles(e.files).length) v("DEC-04", n, `fix_scope tests-docs for ${e.topic}, but the fix's files include code (${codeFiles(e.files).slice(0, 5).join(", ")})`);
        coderLine[e.topic] = n;
        if (e.reason === "ci-failed-twice" && e.model !== "opus") v("DEC-04", n, `coder re-run after CI failed twice on ${e.topic} needs opus, got ${e.model}`);
        lastCoder[e.topic] = e.model;
        bs(e.topic).evidence = null; bs(e.topic).report = null; bs(e.topic).coderEvent = e;   // DEC-21: each coder run needs its own report
        if (nw && e.phase === "ci-fix") {
          const b = bs(e.topic);
          if (!b.ciRed) v("DEC-14", n, `ci-fix coder run on ${e.topic} with no failed ci_run as the latest run of the branch (a review finding is phase fix; a cancelled run is not a failure)`);
          else if (b.headSha && !sameSha(b.redSha, b.headSha)) v("DEC-14", n, `ci-fix coder run on ${e.topic}: the failed run is on ${short(b.redSha)}, the branch head is ${short(b.headSha)}`);
        }
        bs(e.topic).ciRed = false;   // every coder run answers the red run before it
        if (e.phase === "fix") {
          const b = bs(e.topic);
          if (nw && b.reRan && !b.go) v("DEC-14", n, `a further fix round on ${e.topic} after the re-reviewer ran needs an owner_go event (still open after one fix round: stop and show the owner both positions)`);
          b.fixSince = true; b.reReviews = 0; b.reRan = false; b.go = false; lastFix[e.topic] = e;
        }
        if (tr && [tr.sec, tr.door, tr.prod].includes("yes") && e.model !== "opus" && !(e.phase === "fix" && e.fix_scope === "tests-docs"))
          v("DEC-04", n, `coder on ${e.model} for ${e.topic} with a triage line yes (needs opus)`);
      }
      if (e.role === "reviewer" && e.model !== "opus") v("DEC-19", n, `reviewer on ${e.model}, needs opus`);
      if (e.role === "re-reviewer" && e.model !== "opus" && !(e.model === "sonnet" && e.fix_scope === "tests-docs")) v("DEC-19", n, `re-reviewer on ${e.model} (sonnet only for a tests-or-docs-only fix round)`);
      if (e.role === "re-reviewer") {
        bs(e.topic).reRan = true;
        const lf = lastFix[e.topic];
        if (nw && e.model === "sonnet" && e.fix_scope === "tests-docs" && (!lf || lf.fix_scope !== "tests-docs" || (Array.isArray(lf.files) && codeFiles(lf.files).length))) v("DEC-19", n, `re-reviewer on sonnet for ${e.topic}, but the fix round's coder did not record fix_scope tests-docs with no code files`);
      }
      const phase = e.phase ?? (e.role === "reviewer" ? (sawCi.has(e.topic) ? "delivery" : "design") : undefined);
      const delivery = e.role === "reviewer" && phase === "delivery";
      if (delivery && e.phase === "delivery" && !sawCi.has(e.topic)) v("DEC-03", n, `${e.topic}: delivery reviewer with no ci_run for the topic before it`);
      if (e.outside_cap && !e.cap_reason) v("DEC-03", n, `${e.topic}: outside_cap without a cap_reason`);
      if (T.roles.includes(e.role) && !delivery && !x) {
        const m = (made[e.topic] ??= dict());
        m[e.role] = (m[e.role] ?? 0) + 1;
        const track = tr?.track, rk = track === "incident" && e.role === "security" ? 0 : RANK[e.role];
        const hi = maxRank[e.topic];
        if (nw && T.tracks[track] && hi && rk < hi.rank) v("DEC-03", n, `${e.topic}: ${e.role} started after a ${hi.role} call (order: analysts, engineers, design reviewers, security, tech lead last${track === "incident" ? "; on an incident security goes first" : ""})`);
        if (T.tracks[track] && (!hi || rk > hi.rank)) maxRank[e.topic] = { rank: rk, role: e.role };
      }
      if (T.roles.includes(e.role) && !delivery && !e.cap_reason && !e.outside_cap && !x) {
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
      if (e.branch) {   // only a failure is red for ci-fix; a green run of the same workflow, or any run on a later sha, clears it
        const b = bs(e.branch), wf = e.workflow ?? "default";
        if (e.state === "red" || e.conclusion === "failure") { b.ciRed = true; b.redSha = e.sha; b.redWf = wf; }
        else if (!b.ciRed || !sameSha(b.redSha, e.sha) || (wf === b.redWf && isGreen(e))) b.ciRed = false;
        b.headSha = e.sha;
      }
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
      if (tddOn.has(e.branch) && tddRules(b.coderEvent ?? e) && b.evidence !== "ok") v("DEC-21", n, `review of ${e.branch}@${short(e.sha)} started with no coder_report evidence ok since the last coder run (scripts/proof-check.mjs --coder)`);
      // DEC-22: this review must proof-check the proved tests of the coder_report before it, on this sha
      b.required = tddOn.has(e.branch) && b.report && tddRules(b.report) ? { sha: e.sha, tests: b.report.tests } : null;
      b.reviewed_any = true;
      if (newRules(e) && triage[e.branch] && coderLine[e.branch] !== undefined && !(triageFilesLine[e.branch] > coderLine[e.branch])) v("DEC-02", n, `review of ${e.branch}@${short(e.sha)} started with no triage with files after the last coder run (line ${coderLine[e.branch]}); run decide-triage.mjs --branch again and record it`);
      if (role === "re-reviewer") {
        b.reRan = true;
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
      if (newRules(e)) {
        const runs = Object.values(ci[e.catchup_sha] ?? {});
        if (!e.catchup_sha) v("DEC-05", n, `merge ${short(e.merge_sha)}: needs catchup_sha, the head of the catch-up merge whose CI run was green`);
        else if (!runs.length || !runs.every((s) => s === "green")) v("DEC-05", n, `merge ${short(e.merge_sha)}: catchup_sha ${short(e.catchup_sha)} has no green ci_run on every recorded workflow in the ledger`);
      }
      if (newRules(e)) {
        const tr = triage[e.branch], caps = tr && T.tracks[tr.track], dt = decisionTopic[e.branch];
        const calls = (role) => (made[e.branch]?.[role] ?? 0) + (dt ? made[dt]?.[role] ?? 0 : 0);   // a plan step decided elsewhere: the decision topic's calls count
        if (caps) for (const role of ["security", "techlead"]) if (calls(role) < caps[role][0]) v("DEC-03", n, `merge of ${e.branch}: the ${tr.track} track needs at least ${caps[role][0]} ${role} call, the ledger has ${calls(role)}${dt ? ` (with decision_topic ${dt})` : ""}`);
      }
      if (!bs(e.branch).reviewed_any) {
        const standing = profile.standing_waivers ?? [];
        if (e.waived === undefined || e.waived === false) v("DEC-20", n, `merge of ${e.branch} with no review_start on it and no waiver`);
        else if (e.waived === "owner") { if (!e.waiver_reason) v("DEC-20", n, `merge of ${e.branch}: owner waiver needs a waiver_reason`); }
        else if (!standing.includes(e.waived)) v("DEC-20", n, `merge of ${e.branch}: waived must cite a standing waiver of the profile (${standing.join(", ") || "none defined"}) or be "owner", got ${JSON.stringify(e.waived)}`);
      }
      {
        const b = bs(e.branch);
        if (b.required) for (const t of b.required.tests) if (!b.checked.has(`${b.required.sha} ${t}`)) v("DEC-22", n, `merge of ${e.branch}: no proof_check of ${t} on the reviewed head ${short(b.required.sha)}`);
        if (tddOn.has(e.branch)) for (const t of b.blocked) v("DEC-22", n, `merge of ${e.branch}: proof does not prove, ${t} passed without the change and no later proof_check of it fails`);
      }
      if ("release_skip" in e && (typeof e.release_skip !== "string" || !e.release_skip)) v("OPR-09", n, `merge ${short(e.merge_sha)}: release_skip must give the reason as a string`);
      merges[e.merge_sha] = e;
      break;
    }
    case "push": {
      if (/^release\//.test(norm(e.ref)) && e.chained === false && e.by === profile.base_pusher) linePushes.add(e.sha);
      if (norm(e.ref) !== base) { if (e.sha) bs(norm(e.ref)).headSha = e.sha; break; }
      if (e.chained !== false) v(["DEC-06", "OPR-03"], n, `base ${base} pushed chained after another command`);
      if (e.by !== profile.base_pusher && !(profile.base_pusher === "owner" && goPushes.has(`${e.session} ${e.sha}`))) v(["DEC-06", "OPR-03"], n, `base ${base} pushed by ${e.by ?? "unknown"}, the profile says ${profile.base_pusher}`);
      if (!merges[e.sha]) v(["DEC-06", "OPR-03"], n, `base ${base} pushed at ${short(e.sha)} with no merge_built for that sha before it`);
      basePushes.add(e.sha);
      if (relWhen === "change-set" && !relTool) {
        if (pendingRelease && pendingRelease.sha !== e.sha && !releasedShas.has(pendingRelease.sha))
          v("OPR-09", n, `base ${base} pushed at ${short(e.sha)} while merge ${short(pendingRelease.sha)} (pushed line ${pendingRelease.n}) has no release`);
        if (!(pendingRelease && pendingRelease.sha === e.sha)) pendingRelease = typeof merges[e.sha]?.release_skip === "string" && merges[e.sha].release_skip ? null : { sha: e.sha, n };
      }
      break;
    }
    case "issue_close": {
      if (!merges[e.merge_sha]) v(["DEC-07", "OPR-04"], n, `issue #${e.n} closed for ${short(e.merge_sha)}, which no merge_built built`);
      if (!basePushes.has(e.merge_sha)) v(["DEC-07", "OPR-04"], n, `issue #${e.n} closed before a base push of ${short(e.merge_sha)}`);
      if (e.origin_base_sha !== e.merge_sha) v(["DEC-07", "OPR-04"], n, `issue #${e.n} closed while origin/${base} (${short(e.origin_base_sha)}) is not the merge sha (${short(e.merge_sha)})`);
      break;
    }
    case "tag_push": {
      const r = (m) => v("OPR-09", n, `tag ${e.tag}: ${m}`);
      if (relWhen === "never") r("pushed, but the profile's release_when is never");
      if (!semverExec(e.tag)) r("not SemVer (vMAJOR.MINOR.PATCH, optional -pre-release)");
      const toolTag = relTool && e.by === "ci";   // a release tool tags the merge of its release PR, which the ledger did not see pushed
      if (!toolTag && e.ref !== `refs/tags/${e.tag}`) r(`pushed as ${JSON.stringify(e.ref ?? null)}, not by its full ref refs/tags/${e.tag}`);
      if (!toolTag && !basePushes.has(e.sha) && !linePushes.has(e.sha)) r(`on ${short(e.sha)}, which no earlier push of ${base} (or of a release/X.Y line) pushed`);
      if (e.annotated !== true) r("not annotated (git tag -a, or -s when signing)");
      if (e.chained !== false) r("pushed chained after another command (push it alone, by its full ref)");
      const tagger = toolTag ? "ci" : profile.base_pusher;
      if (e.by !== tagger) r(`pushed by ${e.by}, the profile's base_pusher is ${profile.base_pusher}`);
      if (tagSha[e.tag] && tagSha[e.tag] !== e.sha) r(`moved from ${short(tagSha[e.tag])} to ${short(e.sha)} (never move a published tag; fix forward)`);
      tagSha[e.tag] ??= e.sha;
      break;
    }
    case "release": {
      const r = (m) => v("OPR-09", n, `release ${e.tag}: ${m}`);
      const sv = semverExec(e.tag), pre = sv?.[4], via = e.via ?? "session";
      if (!tagSha[e.tag]) r("no tag_push of that tag before it");
      if (!["ci", "session"].includes(via)) r(`via must be ci or session, got ${JSON.stringify(via)}`);
      else if (relVia && via !== relVia) r(`made by ${via}, the profile's release_via is ${relVia}`);
      if (via === "session" && e.verify_tag !== true) r("created without --verify-tag");
      if (pre && e.prerelease !== true) r("a pre-release version not marked prerelease");
      if (pre && e.latest === true) r("a pre-release marked latest");
      if (sv && !pre && e.latest === true) {
        const higher = Object.keys(tagSha).map((t) => [t, semverExec(t)]).filter(([, x]) => x && !x[4] && semCmp(x, sv) > 0).map(([t]) => t);
        if (higher.length) r(`marked latest, but ${higher.join(", ")} is higher`);
      }
      if (releasedTags.has(e.tag)) r("created twice (never delete or re-create a published release)");
      releasedTags.add(e.tag);
      if (tagSha[e.tag]) releasedShas.add(tagSha[e.tag]);
      break;
    }
    case "coder_report": {
      if (!["ok", "gap"].includes(e.evidence)) { v("LEDGER", n, `coder_report evidence must be ok or gap, got ${JSON.stringify(e.evidence)}`); break; }
      const names = (x) => Array.isArray(x) && x.every((t) => typeof t === "string" && t !== "");
      if (!names(e.tests) || ("exempt" in e && !names(e.exempt))) { v("LEDGER", n, "coder_report tests and exempt must be lists of test names"); break; }
      bs(e.branch).evidence = e.evidence;
      bs(e.branch).report = e;
      const code = codeFiles(triage[e.branch]?.files);
      if (tddOn.has(e.branch) && !e.tests.length && (e.exempt ?? []).length && code.length) warns.push(`warn: line ${n}: every test of ${e.branch}'s coder_report is exempt but the step touches production code (${code.slice(0, 5).join(", ")})`);
      break;
    }
    case "owner_go": {
      bs(e.topic).go = true;
      break;
    }
    case "intent": {
      if (!INTENT_PHASES.includes(e.phase)) { v("LEDGER", n, `intent phase must be ${INTENT_PHASES.join(", ")}, got ${JSON.stringify(e.phase)}`); break; }
      const seen = (intentSeen[e.milestone] ??= new Set());
      const need = { approved: "checked", written: "approved" }[e.phase];
      if (need && !seen.has(need)) v("LEDGER", n, `intent ${e.milestone}: ${e.phase} with no ${need} event before it${need === "checked" ? " (intent-plan.mjs must pass before the owner approves)" : ""}`);
      seen.add(e.phase);
      break;
    }
    case "handoff": {
      if (!PARTIES.includes(e.from) || !PARTIES.includes(e.to) || e.from === e.to) { v("LEDGER", n, `handoff from and to must be two of ${PARTIES.join(", ")}, got ${JSON.stringify(e.from)} -> ${JSON.stringify(e.to)}`); break; }
      const k = `${e.topic} ${e.from}>${e.to}`;
      handoffs[k] = (handoffs[k] ?? 0) + 1;
      if (newRules(e) && handoffs[k] > 1) v("DEC-03", n, `${e.topic}: second handoff ${e.from} -> ${e.to} (at most one each way per topic: stop and report)`);
      break;
    }
    case "condition": {
      if (!["open", "proved"].includes(e.status)) v("LEDGER", n, `condition status must be open or proved, got ${JSON.stringify(e.status)}`);
      break;
    }
    case "proof_check": {
      if (!["fails", "passes", "not-checked", "exempt"].includes(e.result)) { v("LEDGER", n, `proof_check result must be fails, passes, not-checked or exempt, got ${JSON.stringify(e.result)}`); break; }
      const b = bs(e.branch);
      // a required test is covered by fails, passes or not-checked; exempt covers only a CANNOT FAIL FIRST test (not required)
      if (e.result !== "exempt") b.checked.add(`${e.sha} ${e.test}`);
      if (e.result === "passes") b.blocked.add(e.test);
      if (e.result === "fails") b.blocked.delete(e.test);   // only a later fails clears a pass
      if (e.result === "not-checked") warns.push(`warn: line ${n}: proof check of ${e.test} on ${e.branch} not checked (see the reviewer's reason)`);
      break;
    }
  }
  // rules versions: with the profile's tdd yes or auto, never backwards anywhere in the ledger; otherwise only on tdd-on
  // topics (a ledger without tdd audits as before). Mixed versions on a tdd-on topic warn.
  const topic = e.topic ?? e.branch, rv = semParts(e.rule_version?.rules);
  // the 1.12.1 gate cannot be bypassed: once a topic has an event at 1.12.1 or later, a later event on it needs a rules stamp that is not older
  if (topic !== undefined && newRules(e)) gated[topic] = true;
  else if (topic !== undefined && gated[topic]) v("LEDGER", n, `event on ${topic} ${rv ? `stamped with rules ${rv.join(".")}` : "with no rules stamp"} after rules 1.12.1 on the same topic; the loop-cap checks cannot be turned off by an older stamp`);
  if (rv && ["yes", "auto"].includes(profile.tdd)) {
    if (maxRulesAll && verCmp(rv, maxRulesAll) < 0) v("LEDGER", n, `rules version goes backwards: ${rv.join(".")} after ${maxRulesAll.join(".")}`);
    else maxRulesAll = rv;
    if (topic !== undefined && tddOn.has(topic)) (rulesSeen[topic] ??= new Set()).add(rv.join("."));
  } else if (topic !== undefined && rv && tddOn.has(topic)) {
    (rulesSeen[topic] ??= new Set()).add(rv.join("."));
    if (maxRules[topic] && verCmp(rv, maxRules[topic]) < 0) v("LEDGER", n, `rules version goes backwards: ${rv.join(".")} after ${maxRules[topic].join(".")} on topic ${topic}`);
    else maxRules[topic] = rv;
  }
}
if (pendingRelease && !releasedShas.has(pendingRelease.sha)) warns.push(`warn: line ${pendingRelease.n}: merge ${short(pendingRelease.sha)} pushed to ${base} has no release yet (OPR-09: release it before the next merge is pushed)`);
if (basePushes.size && !relWhen) warns.push(`warn: release_when ${profile.release_when === undefined ? "unset" : `is ${JSON.stringify(profile.release_when)}`} in the profile: OPR-09 checks release events but not when they are due`);
for (const [t, s] of Object.entries(rulesSeen)) if (s.size > 1) warns.push(`warn: mixed rules versions on topic ${t} (${[...s].join(", ")}): DEC-21 and DEC-22 apply only to work stamped 1.7.0 or later`);
for (const w of warns) console.log(w);
if (!events && !violations.length) v("LEDGER", 1, "empty ledger");
if (violations.length) {
  for (const x of violations.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.n - b.n))) console.log(x.line);
  process.exit(1);
}
console.log(`audit ok: ${events} events, rule versions: ${[...versions].join(" | ") || "none recorded"}`);
