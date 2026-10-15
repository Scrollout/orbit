import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const audit = join(here, "audit-ledger.mjs");
const append = join(here, "ledger.mjs");
const profile = join(here, "fixtures", "real-profile.md");
const mkProfile = (extraLine) => {
  const f = join(mkdtempSync(join(tmpdir(), "prof-")), "p.md");
  writeFileSync(f, readFileSync(profile, "utf8").replace("ci_policy: ci-only", `ci_policy: ci-only\n${extraLine}`));
  return f;
};
const T0 = "2026-10-14T10:00:00Z";
const ev = (kind, o = {}) => ({ ts: T0, session: "s1", rule_version: { decide: "1.0.0", operator: "1.0.0" }, kind, ...o });
const SHA = "a".repeat(40), MERGE = "b".repeat(40);
const clean = () => [
  ev("triage", { topic: "t", sec: "yes", door: "no", prod: "no", track: "full review", files: ["docs/a.md", "Makefile"] }),
  ev("agent_start", { role: "engineer", model: "sonnet", topic: "t" }),
  ev("agent_start", { role: "security", model: "fable", topic: "t" }),
  ev("agent_start", { role: "coder", model: "opus", topic: "t", phase: "build" }),
  ev("ci_run", { branch: "t", sha: SHA, workflow: "checks", conclusion: "success" }),
  ev("review_start", { branch: "t", sha: SHA, ci_state: "green" }),
  ev("merge_built", { branch: "t", merge_sha: MERGE, tree_equal: true, ci_state: "green" }),
  ev("push", { ref: "t", sha: SHA, chained: false, by: "agent" }),
  ev("push", { ref: "main", sha: MERGE, chained: false, by: "owner" }),
  ev("issue_close", { n: 7, origin_base_sha: MERGE, merge_sha: MERGE }),
];
const run = (events, ...extra) => {
  const f = join(mkdtempSync(join(tmpdir(), "led-")), "ledger.jsonl");
  writeFileSync(f, events.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("\n") + "\n");
  return spawnSync("node", [audit, f, "--profile", profile, ...extra], { encoding: "utf8" });
};
const mutate = (fn) => { const e = clean(); fn(e); return e; };
const eng = (o = {}) => ev("agent_start", { role: "engineer", model: "sonnet", topic: "t", ...o });
const fix = (o = {}) => ev("agent_start", { role: "coder", model: "opus", topic: "t", phase: "fix", ...o });
const SHA2 = "d".repeat(40);

test("a clean ledger passes", () => {
  const r = run(clean());
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /audit ok: 10 events/);
  assert.match(r.stdout, /decide=1\.0\.0/);
});

const bad = [
  ["DEC-01", "reviewer started before green CI", (e) => { e[5].ci_state = "pending"; }],
  ["DEC-01", "review_start with no recorded green run for that sha", (e) => { e.splice(4, 1); }],
  ["DEC-01", "one workflow green, a second recorded workflow still pending", (e) => { e.splice(5, 0, ev("ci_run", { sha: SHA, workflow: "ui", state: "pending" })); }],
  ["DEC-01", "a later red run of one workflow supersedes its earlier green", (e) => { e.splice(5, 0, ev("ci_run", { sha: SHA, workflow: "checks", conclusion: "failure" })); }],
  ["DEC-16", "review sent on a red run", (e) => { e.splice(5, 0, ev("ci_run", { sha: SHA, workflow: "ui", conclusion: "failure" })); }],
  ["DEC-02", "branch touches a security path but triage says sec=no", (e) => { e[0].sec = "no"; }],
  ["DEC-02", "a later triage with sec=no overwrites a yes", (e) => { e.splice(1, 0, ev("triage", { topic: "t", sec: "no", door: "no", prod: "no", track: "full review" })); }],
  ["DEC-03", "more engineers than the track allows", (e) => { e.splice(2, 0, eng(), eng()); }],
  ["DEC-03", "agent started on a topic with no triage", (e) => { e.splice(0, 1); }],
  ["DEC-04", "coder on sonnet when security=yes", (e) => { e[3].model = "sonnet"; }],
  ["DEC-19", "reviewer on sonnet", (e) => { e.splice(5, 0, ev("agent_start", { role: "reviewer", model: "sonnet", topic: "t", phase: "delivery" })); }],
  ["DEC-19", "re-reviewer on sonnet after a code fix", (e) => { e.splice(6, 0, ev("agent_start", { role: "re-reviewer", model: "sonnet", topic: "t", fix_scope: "code" })); }],
  ["DEC-14", "same sha reviewed twice with no fix between", (e) => { e.splice(6, 0, ev("review_start", { branch: "t", sha: SHA, ci_state: "green" })); }],
  ["DEC-14", "fix-round review on the old sha", (e) => { e.splice(6, 0, fix(), ev("review_start", { branch: "t", sha: SHA, ci_state: "green", role: "re-reviewer" })); }],
  ["DEC-14", "re-reviewer twice for one fix round", (e) => { e.splice(6, 0, fix(), ev("ci_run", { sha: SHA2, workflow: "checks", conclusion: "success" }), ev("review_start", { branch: "t", sha: SHA2, ci_state: "green", role: "re-reviewer" }), ev("review_start", { branch: "t", sha: SHA2, ci_state: "green", role: "re-reviewer" })); }],
  ["DEC-20", "merge of a branch nobody reviewed, no waiver", (e) => { e.splice(4, 2); }],
  ["DEC-20", "waived:true does not cite a standing waiver", (e) => { e.splice(4, 2); e[4].waived = true; }],
  ["DEC-05", "tree mismatch", (e) => { e[6].tree_equal = false; }],
  ["OPR-02", "merge built without green CI on the catch-up merge", (e) => { e[6].ci_state = "red"; }],
  ["DEC-06", "chained base push", (e) => { e[8].chained = true; }],
  ["OPR-03", "chained base push", (e) => { e[8].chained = true; }],
  ["DEC-06", "base pushed by the agent when the profile says owner", (e) => { e[8].by = "agent"; }],
  ["DEC-06", "base pushed with no merge_built for that sha", (e) => { e.splice(6, 1); }],
  ["DEC-06", "HEAD:main counts as the base", (e) => { e[8].ref = "HEAD:main"; e[8].chained = true; }],
  ["DEC-06", "origin/main counts as the base", (e) => { e[8].ref = "origin/main"; e[8].chained = true; }],
  ["DEC-06", "refs/heads/main counts as the base", (e) => { e[8].ref = "refs/heads/main"; e[8].chained = true; }],
  ["DEC-07", "issue closed before origin/base equals the merge sha", (e) => { e[9].origin_base_sha = "c".repeat(40); }],
  ["DEC-07", "issue closed with no base push before it", (e) => { e.splice(8, 1); }],
  ["DEC-07", "issue closed before the base push event", (e) => { e.splice(8, 0, e.pop()); }],
  ["DEC-07", "close for a merge sha no merge_built built", (e) => { e[9].merge_sha = "e".repeat(40); e[9].origin_base_sha = e[9].merge_sha; }],
  ["OPR-04", "issue closed before origin/base equals the merge sha", (e) => { e[9].origin_base_sha = "c".repeat(40); }],
  ["LEDGER", "ts missing", (e) => { delete e[2].ts; }],
  ["LEDGER", "ts goes backwards in a session", (e) => { e[3].ts = "2026-10-14T09:00:00Z"; }],
  ["LEDGER", "ts without a UTC offset", (e) => { e[1].ts = "2026-10-14T10:00:00"; }],
];
for (const [id, name, fn] of bad) {
  test(`${id} fails: ${name}`, () => {
    const r = run(mutate(fn));
    assert.equal(r.status, 1, r.stdout);
    assert.ok(r.stdout.split("\n").some((l) => l.startsWith(`${id} `)), r.stdout);
  });
}

test("a delivery reviewer is not counted against the design-review caps (explicit phase, or by order after CI)", () => {
  const e = clean();
  e.splice(5, 0, ev("agent_start", { role: "reviewer", model: "opus", topic: "t", phase: "delivery" }), ev("agent_start", { role: "reviewer", model: "opus", topic: "t" }));
  e.splice(2, 0, ev("agent_start", { role: "reviewer", model: "opus", topic: "t", phase: "design" }));
  const r = run(e);
  assert.equal(r.status, 0, r.stdout);
  e.splice(2, 0, ev("agent_start", { role: "reviewer", model: "opus", topic: "t", phase: "design" }));
  assert.match(run(e).stdout, /^DEC-03 /m, "a second design reviewer exceeds the cap of 1");
});

test("branches interleave: state is per branch", () => {
  const e = clean();
  e.splice(6, 0, ev("review_start", { branch: "u", sha: SHA2, ci_state: "green" }));
  e.splice(5, 0, ev("ci_run", { sha: SHA2, workflow: "checks", conclusion: "success" }));
  assert.equal(run(e).status, 0, run(e).stdout);
});

test("a fix round, new sha, one re-reviewer passes; a tests-or-docs fix may stay on sonnet", () => {
  const e = clean();
  e.splice(6, 0, fix({ model: "sonnet", fix_scope: "tests-docs" }), ev("ci_run", { sha: SHA2, workflow: "checks", conclusion: "success" }),
    ev("agent_start", { role: "re-reviewer", model: "sonnet", topic: "t", fix_scope: "tests-docs" }), ev("review_start", { branch: "t", sha: SHA2, ci_state: "green", role: "re-reviewer" }));
  assert.equal(run(e).status, 0, run(e).stdout);
});

test("a cap_reason excuses an extra call", () => {
  const e = clean();
  e.splice(2, 0, eng(), eng({ cap_reason: "second real design" }));
  assert.equal(run(e).status, 0, run(e).stdout);
  e.splice(2, 0, eng());
  assert.equal(run(e).status, 1);
});

test("an empty ledger fails", () => {
  const r = run([]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^LEDGER .*empty ledger/m);
});

test("malformed line and unknown kind are reported", () => {
  const r = run([...clean(), "{not json", ev("mystery")]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^LEDGER line 11: invalid JSON/m);
  assert.match(r.stdout, /^LEDGER line 12: unknown kind mystery/m);
});

test("a profile gap stops the audit instead of guessing", () => {
  const f = join(mkdtempSync(join(tmpdir(), "led-")), "p.md");
  writeFileSync(f, "# no block\n");
  const l = join(dirname(f), "l.jsonl");
  writeFileSync(l, JSON.stringify(ev("push", { ref: "main", sha: SHA, chained: false, by: "agent" })) + "\n");
  const r = spawnSync("node", [audit, l, "--profile", f], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /profile gap: base_branch/);
});

test("ledger.mjs appends one stamped JSON line per event", () => {
  const dir = mkdtempSync(join(tmpdir(), "led-"));
  const f = join(dir, "l.jsonl");
  const r = spawnSync("node", [append, "--root", join(here, ".."), "--ledger", f, "--session", "s9", "push", "ref=main", "chained:=false", "sha=1234567", "by=owner"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const e = JSON.parse(readFileSync(f, "utf8").trim());
  assert.equal(e.kind, "push");
  assert.equal(e.session, "s9");
  assert.equal(e.chained, false);
  assert.equal(e.sha, "1234567");
  assert.match(e.ts, /^\d{4}-\d\d-\d\dT.*Z$/);
  assert.match(e.rule_version.decide, /^\d+\.\d+\.\d+$/);
  assert.match(run([e]).stdout, /^DEC-06 .*no merge_built/m, "a stamped event parses and is audited");
});

test("the delivery default is per topic: A's ci_run does not make B's phase-less reviewer a delivery reviewer", () => {
  const tri = (t) => ev("triage", { topic: t, sec: "no", door: "no", prod: "no", track: "full review" });
  const rv = (t) => ev("agent_start", { role: "reviewer", model: "opus", topic: t });
  const base = [tri("a"), tri("b"), ev("ci_run", { branch: "a", sha: SHA, workflow: "w", conclusion: "success" })];
  assert.equal(run([...base, rv("a"), rv("a"), rv("b")]).status, 0, "A's reviewers are delivery (outside caps), B's one design reviewer fits");
  const r = run([...base, rv("b"), rv("b")]);
  assert.equal(r.status, 1, "B has no ci_run: its second phase-less reviewer is a design reviewer over the cap of 1");
  assert.match(r.stdout, /^DEC-03 .*b: reviewer call 2/m);
});

test("a ci_run without a branch counts for no topic", () => {
  const e = [ev("triage", { topic: "b", sec: "no", door: "no", prod: "no", track: "full review" }), ev("ci_run", { sha: SHA, workflow: "w", conclusion: "success" })];
  for (let i = 0; i < 2; i++) e.push(ev("agent_start", { role: "reviewer", model: "opus", topic: "b" }));
  assert.match(run(e).stdout, /^DEC-03 /m);
});

test("a review_start on a branch with no triage topic warns without failing", () => {
  const e = clean();
  e.splice(6, 0, ev("ci_run", { sha: SHA2, workflow: "checks", conclusion: "success" }), ev("review_start", { branch: "orphan", sha: SHA2, ci_state: "green" }));
  const r = run(e);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /^warn: line 8: review_start branch orphan has no triage topic/m);
  assert.doesNotMatch(run(clean()).stdout, /warn: line/);
});

const sh = (script, args, cwd) => spawnSync("node", [join(here, script), ...args], { encoding: "utf8", cwd });

test("ledger.mjs: manifest is found relative to the script, from a foreign cwd and a foreign --root", () => {
  const f = join(mkdtempSync(join(tmpdir(), "led-")), "l.jsonl");
  const r = sh("ledger.mjs", ["--root", "/", "--ledger", f, "--session", "s", "push", "ref=x"], "/");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Object.keys(JSON.parse(readFileSync(f, "utf8")).rule_version).length >= 3);
});

test("ledger.mjs refuses reserved keys and bad json with exit 64", () => {
  const f = join(mkdtempSync(join(tmpdir(), "led-")), "l.jsonl");
  for (const field of ["ts=1", "session=x", "kind=y", "rule_version:={}"]) {
    const r = sh("ledger.mjs", ["--ledger", f, "--session", "s", "push", field]);
    assert.equal(r.status, 64, field);
    assert.match(r.stderr, /^ledger: /);
  }
  const bad = sh("ledger.mjs", ["--ledger", f, "--session", "s", "push", "x:={nope"]);
  assert.equal(bad.status, 64);
  assert.match(bad.stderr, /^ledger: bad JSON for x/);
  assert.equal(existsSync(f), false);
});

test("ledger.mjs and audit-ledger.mjs default to the profile's ledger_path", () => {
  const root = mkdtempSync(join(tmpdir(), "led-"));
  mkdirSync(join(root, ".agents"));
  writeFileSync(join(root, ".agents/project.md"), readFileSync(profile, "utf8").replace("ci_policy: ci-only", "ci_policy: ci-only\nledger_path: .agents/my.jsonl"));
  assert.equal(sh("ledger.mjs", ["--root", root, "--session", "s", "triage", "topic=t", "sec=no", "door=no", "prod=no", "track=just do it", "files:=[]"]).status, 0);
  assert.ok(existsSync(join(root, ".agents/my.jsonl")));
  const a = sh("audit-ledger.mjs", ["--root", root], undefined);
  assert.equal(a.status, 0, a.stdout + a.stderr);
  const d = mkdtempSync(join(tmpdir(), "led-"));
  mkdirSync(join(d, ".agents"));
  writeFileSync(join(d, ".agents/project.md"), readFileSync(profile, "utf8"));
  sh("ledger.mjs", ["--root", d, "--session", "s", "push", "ref=x"]);
  assert.ok(existsSync(join(d, ".agents/ledger.jsonl")), "default path");
});

test("audit-ledger.mjs on a missing ledger exits 64 with one line", () => {
  const r = sh("audit-ledger.mjs", ["/nonexistent/ledger.jsonl", "--profile", profile]);
  assert.equal(r.status, 64);
  assert.match(r.stderr, /^audit-ledger: cannot read /);
});

test("DEC-03: outside_cap needs a cap_reason; an explicit delivery phase needs a ci_run for the topic", () => {
  const e = clean();
  e.splice(2, 0, eng({ outside_cap: true }));
  assert.match(run(e).stdout, /^DEC-03 .*outside_cap without a cap_reason/m);
  const f = clean();
  f.splice(1, 0, ev("agent_start", { role: "reviewer", model: "opus", topic: "t", phase: "delivery" }));
  assert.match(run(f).stdout, /^DEC-03 .*delivery reviewer.*no ci_run/m);
});

test("topics named like Object.prototype members do not break the audit", () => {
  for (const name of ["constructor", "toString", "__proto__"]) {
    const e = [ev("triage", { topic: name, sec: "no", door: "no", prod: "no", track: "light review", files: [] }),
      ev("agent_start", { role: "engineer", model: "sonnet", topic: name }),
      ev("agent_start", { role: "engineer", model: "sonnet", topic: name })];
    const r = run(e);
    assert.equal(r.status, 1, name + r.stdout);
    assert.match(r.stdout, /^DEC-03 .*engineer call 2/m, name);
  }
});

test("required fields per kind: missing session, rule_version, sha, door, prod are LEDGER violations; triage without files warns", () => {
  const e = clean();
  delete e[1].session;
  delete e[2].rule_version;
  delete e[4].sha;
  delete e[0].door;
  const r = run(e);
  assert.equal(r.status, 1);
  for (const m of [/LEDGER line 2: missing session/, /LEDGER line 3: missing rule_version/, /LEDGER line 5: ci_run needs sha/, /LEDGER line 1: triage needs door/]) assert.match(r.stdout, m);
  const w = clean();
  delete w[0].files;
  const r2 = run(w);
  assert.match(r2.stdout, /^warn: line 1: triage without files: DEC-02 not checked/m);
});

test("a force-push refspec still counts as the base (+main, +HEAD:main)", () => {
  for (const ref of ["+main", "+HEAD:main"]) {
    const e = mutate((x) => { x[8].ref = ref; x[8].chained = true; });
    assert.match(run(e).stdout, /^DEC-06 /m, ref);
  }
});

test("waived must cite a standing waiver of the profile or be an owner waiver with a reason", () => {
  const mk = (w, extra = {}) => { const e = clean(); e.splice(4, 2); e[4].waived = w; Object.assign(e[4], extra); return e; };
  const p = mkProfile("standing_waivers: [docs-only]");
  const runP = (events) => { const f = join(mkdtempSync(join(tmpdir(), "led-")), "l.jsonl"); writeFileSync(f, events.map((x) => JSON.stringify(x)).join("\n") + "\n"); return spawnSync("node", [audit, f, "--profile", p], { encoding: "utf8" }); };
  assert.equal(runP(mk("docs-only")).status, 0, runP(mk("docs-only")).stdout);
  assert.equal(runP(mk("owner", { waiver_reason: "tiny" })).status, 0);
  assert.match(runP(mk(true)).stdout, /^DEC-20 .*cite/m);
  assert.match(runP(mk("other-class")).stdout, /^DEC-20 /m);
  assert.match(runP(mk("owner")).stdout, /^DEC-20 .*reason/m);
});

test("a resumed coder cannot change model; ci-failed-twice needs opus", () => {
  const f = clean();
  f.splice(4, 0, ev("agent_start", { role: "coder", model: "opus", topic: "t", phase: "fix", resumed: true }));
  f[3].model = "opus";
  assert.equal(run(f).status, 0, run(f).stdout);
  const g = [ev("triage", { topic: "t", sec: "no", door: "no", prod: "no", track: "just do it", files: [] }),
    ev("agent_start", { role: "coder", model: "sonnet", topic: "t", phase: "build" }),
    ev("agent_start", { role: "coder", model: "opus", topic: "t", phase: "fix", resumed: true })];
  assert.match(run(g).stdout, /^DEC-04 .*resumed/m);
  const h = [g[0], ev("agent_start", { role: "coder", model: "sonnet", topic: "t", phase: "fix", reason: "ci-failed-twice" })];
  assert.match(run(h).stdout, /^DEC-04 .*CI failed twice/m);
});

test("merge_built needs branch, with a clear message", () => {
  const e = clean();
  delete e[6].branch;
  const r = run(e);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^LEDGER line 7: merge_built needs branch/m);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test("a worker id derives 'resumed': same worker, later coder event, other model is a DEC-04 violation", () => {
  const g = (second, extra = {}) => [ev("triage", { topic: "t", sec: "no", door: "no", prod: "no", track: "just do it", files: [] }),
    ev("agent_start", { role: "coder", model: "sonnet", topic: "t", phase: "build", worker: "w1" }),
    ev("agent_start", { role: "coder", model: second, topic: "t", phase: "fix", ...extra })];
  assert.match(run(g("opus", { worker: "w1" })).stdout, /^DEC-04 .*worker w1/m);
  assert.equal(run(g("opus", { worker: "w2" })).status, 0, "a different worker is a fresh coder");
  assert.equal(run(g("opus")).status, 0, "no worker id on the later event: not derivable");
  assert.equal(run(g("sonnet", { worker: "w1" })).status, 0, "same model is fine");
});

test("worker must be a non-empty string; merge_built branch may not be null", () => {
  for (const w of [null, "", {}, 5, ["w"]]) {
    const e = clean();
    e[3].worker = w;
    assert.match(run(e).stdout, /^LEDGER line 4: .*worker/m, JSON.stringify(w));
  }
  const e = clean();
  e[6].branch = null;
  assert.match(run(e).stdout, /^LEDGER line 7: merge_built needs branch/m);
});

// OPR-09: releases
const MERGE2 = "e".repeat(40);
const tag = (o = {}) => ev("tag_push", { tag: "v1.2.0", sha: MERGE, by: "owner", annotated: true, chained: false, ...o, ref: o.ref ?? `refs/tags/${o.tag ?? "v1.2.0"}` });
const rel = (o = {}) => ev("release", { tag: "v1.2.0", via: "session", verify_tag: true, latest: true, ...o });
const merge2 = (o = {}) => [ev("merge_built", { branch: "t2", merge_sha: MERGE2, tree_equal: true, ci_state: "green", waived: "owner", waiver_reason: "test", ...o }),
  ev("push", { ref: "main", sha: MERGE2, chained: false, by: "owner" })];
const runP = (lines, events) => {
  const f = join(mkdtempSync(join(tmpdir(), "led-")), "ledger.jsonl");
  writeFileSync(f, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return spawnSync("node", [audit, f, "--profile", mkProfile(lines)], { encoding: "utf8" });
};
const CS = "release_when: change-set";

test("OPR-09: a merge released before the next merge is pushed passes", () => {
  const r = runP(CS, [...clean(), tag(), rel(), ...merge2(), tag({ tag: "v1.2.1", sha: MERGE2 }), rel({ tag: "v1.2.1" })]);
  assert.equal(r.status, 0, r.stdout);
  assert.doesNotMatch(r.stdout, /warn:/);
});

test("OPR-09: the next merge pushed before the previous one's release is a violation; the last unreleased merge warns", () => {
  const r = runP(CS, [...clean(), ...merge2()]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^OPR-09 line 12: base main pushed at eeeeeeee while merge bbbbbbbb \(pushed line 9\) has no release/m);
  assert.match(r.stdout, /^warn: line 12: merge eeeeeeee pushed to main has no release yet/m);
  assert.equal(runP(CS, [...clean(), ...merge2({ release_skip: "docs only, no version change" })]).status, 1, "a skip on the later merge does not excuse the earlier one");
  const e = clean(); e[6].release_skip = "docs only";
  assert.equal(runP(CS, [...e, ...merge2()]).status, 0, "a merge with a release_skip reason is not due");
  e[6].release_skip = true;
  assert.match(runP(CS, [...e, ...merge2()]).stdout, /^OPR-09 .*release_skip must give the reason/m);
  assert.equal(runP(`${CS}\nrelease_tool: release-please`, [...clean(), ...merge2()]).status, 0, "a release tool owns the cadence");
  assert.equal(runP("release_when: milestone", [...clean(), ...merge2()]).status, 0);
});

test("OPR-09: per-event tag and release checks", () => {
  const bad = [
    ["tag on a sha never pushed to the base", [tag({ sha: SHA2 })], /no earlier push of main/],
    ["lightweight tag", [tag({ annotated: false })], /not annotated/],
    ["chained tag push", [tag({ chained: true })], /pushed chained/],
    ["tag pushed by its short name", [tag({ ref: "v1.2.0" })], /not by its full ref/],
    ["tag pushed by the agent when the owner pushes the base", [tag({ by: "agent" })], /pushed by agent/],
    ["not SemVer", [tag({ tag: "1.2.0" })], /not SemVer/],
    ["moved tag", [tag(), tag({ sha: SHA })], /moved from/],
    ["release without its tag", [rel()], /no tag_push/],
    ["release without --verify-tag", [tag(), rel({ verify_tag: false })], /without --verify-tag/],
    ["pre-release not marked", [tag({ tag: "v1.3.0-rc.1" }), rel({ tag: "v1.3.0-rc.1", latest: false })], /not marked prerelease/],
    ["pre-release marked latest", [tag({ tag: "v1.3.0-rc.1" }), rel({ tag: "v1.3.0-rc.1", prerelease: true })], /pre-release marked latest/],
    ["latest on a lower version", [tag({ tag: "v1.3.0" }), tag({ tag: "v1.2.9" }), rel({ tag: "v1.2.9" })], /marked latest, but v1\.3\.0 is higher/],
    ["release re-created", [tag(), rel(), rel({ latest: false })], /created twice/],
  ];
  for (const [name, extra, re] of bad) {
    const r = run([...clean(), ...extra]);
    assert.equal(r.status, 1, name);
    assert.ok(r.stdout.split("\n").some((l) => /^OPR-09 line \d+: /.test(l) && re.test(l.replace(/^OPR-09 line \d+: /, ""))), `${name}: ${r.stdout}`);
  }
  assert.match(runP("release_when: never", [...clean(), tag()]).stdout, /^OPR-09 .*release_when is never/m);
  assert.match(runP("release_via: ci", [...clean(), tag(), rel()]).stdout, /^OPR-09 .*release_via is ci/m);
  assert.equal(runP("release_via: ci", [...clean(), tag(), ev("release", { tag: "v1.2.0", via: "ci", latest: true })]).status, 0, "a CI release needs no verify_tag field");
  assert.equal(run([...clean(), tag({ tag: "v1.3.0-rc.1" }), rel({ tag: "v1.3.0-rc.1", latest: false, prerelease: true })]).status, 0);
  assert.equal(runP("release_tool: release-please", [...clean(), tag({ by: "ci" })]).status, 0, "a release tool tags from CI");
  assert.equal(runP("release_tool: release-please", [...clean(), tag({ by: "ci", sha: SHA2, ref: "x" })]).status, 0, "a tool's release-PR merge is not in the ledger");
  assert.match(run([...clean(), tag({ by: "ci" })]).stdout, /pushed by ci/);
  const line = ev("push", { ref: "release/1.1", sha: SHA2, chained: false, by: "owner" });
  assert.equal(run([...clean(), tag({ tag: "v1.3.0" }), line, tag({ tag: "v1.1.4", sha: SHA2 }), rel({ tag: "v1.1.4", latest: false })]).status, 0, "a fix on a maintenance line");
  assert.match(run([...clean(), { ...line, by: "agent" }, tag({ tag: "v1.1.4", sha: SHA2 })]).stdout, /no earlier push/);
});

test("OPR-09: release_when unset or TODO warns once there is a base push", () => {
  assert.match(run(clean()).stdout, /^warn: release_when unset in the profile/m);
  assert.match(runP("release_when: TODO", clean()).stdout, /^warn: release_when is "TODO"/m);
  assert.doesNotMatch(runP(CS, clean().slice(0, 7)).stdout, /warn: release_when/);
});

// DEC-21, DEC-22: TDD evidence, audited on work stamped with rules 1.7.0 or later
const RV7 = { decide: "1.4.0", operator: "1.5.0", rules: "1.7.0" };
const RV6 = { decide: "1.3.3", operator: "1.4.1", rules: "1.6.1" };
const at = (rv) => (x) => ({ ...x, rule_version: rv });
// clean(): 0 triage, 1-2 design, 3 coder, 4 ci_run, 5 coder_report, 6 review_start, 7 proof_check, 8 merge_built, ...
const report = (o = {}) => at(RV7)(ev("coder_report", { branch: "t", sha: SHA, evidence: "ok", tests: ["TestA"], ...o }));
const proof = (o = {}) => at(RV7)(ev("proof_check", { branch: "t", sha: SHA, test: "TestA", result: "fails", ...o }));
const tdd = (fn = () => {}) => {
  const e = clean().map(at(RV7));
  e[0].tdd = true;
  e.splice(5, 0, report());
  e.splice(7, 0, proof());
  fn(e);
  return e;
};

test("DEC-21/22: evidence ok before the review and a failing proof check pass; older rule versions are not checked", () => {
  const r = run(tdd());
  assert.equal(r.status, 0, r.stdout);
  assert.doesNotMatch(r.stdout, /warn: (mixed|line)/);
  const old = run(clean().map(at(RV6)));
  assert.equal(old.status, 0, old.stdout);
});

test("DEC-21: a review with no coder_report, or evidence gap, or evidence from before the last coder run", () => {
  assert.match(run(tdd((e) => e.splice(5, 1))).stdout, /^DEC-21 line \d+: review of t@/m);
  assert.match(run(tdd((e) => { e[5].evidence = "gap"; })).stdout, /^DEC-21 /m);
  assert.match(run(tdd((e) => e.splice(5, 0, e.splice(3, 1)[0]))).stdout, /^DEC-21 /m, "coder started again after the report");
  assert.match(run(tdd((e) => { e[5].evidence = "yes"; })).stdout, /^LEDGER line 6: coder_report evidence must be ok or gap/m);
  assert.match(run(tdd((e) => { delete e[5].tests; })).stdout, /^LEDGER line 6: coder_report needs tests/m);
  assert.match(run(tdd((e) => { e[5].tests = "TestA"; })).stdout, /^LEDGER line 6: coder_report tests and exempt must be lists/m);
});

test("DEC-21: a mid-session upgrade does not flag a coder run stamped before 1.7.0; mixed versions warn; going back is a LEDGER violation", () => {
  const upgraded = clean().map((x, i) => at(i < 4 ? RV6 : RV7)(x));   // coder ran under 1.6.1, the review under 1.7.0, no coder_report
  upgraded[0].tdd = true;
  const r = run(upgraded);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /^warn: mixed rules versions on topic t \(1\.6\.1, 1\.7\.0\)/m);
  const back = clean().map((x, i) => at(i === 6 ? RV6 : RV7)(x));
  back[0].tdd = true;
  assert.match(run(back).stdout, /^LEDGER line 7: rules version goes backwards: 1\.6\.1 after 1\.7\.0 on topic t/m);
});

test("DEC-22: every proved test of the coder_report needs a proof_check on the reviewed head; exempt tests need none", () => {
  assert.match(run(tdd((e) => e.splice(7, 1))).stdout, /^DEC-22 line \d+: merge of t: no proof_check of TestA on the reviewed head/m);
  const two = run(tdd((e) => { e[5].tests = ["TestA", "TestB"]; }));
  assert.match(two.stdout, /^DEC-22 .*no proof_check of TestB/m);
  assert.doesNotMatch(two.stdout, /no proof_check of TestA/);
  assert.match(run(tdd((e) => { e[7].sha = SHA2; })).stdout, /^DEC-22 .*no proof_check of TestA/m, "a check of another sha does not count");
  assert.match(run(tdd((e) => { e[7].result = "exempt"; })).stdout, /^DEC-22 .*no proof_check of TestA/m, "exempt does not cover a proved test");
  const docs = run(tdd((e) => { e[5].tests = []; e[5].exempt = ["docs"]; e.splice(7, 1); }));
  assert.equal(docs.status, 0, docs.stdout);
  const nc = run(tdd((e) => { e[7].result = "not-checked"; }));
  assert.equal(nc.status, 0, nc.stdout);
  assert.match(nc.stdout, /^warn: line 8: proof check of TestA on t not checked/m);
  assert.match(run(tdd((e) => { e[7].result = "green"; })).stdout, /^LEDGER line 8: proof_check result must be/m);
});

test("DEC-22: a pass blocks the merge; only a later fails of that test clears it, not not-checked or exempt", () => {
  assert.match(run(tdd((e) => { e[7].result = "passes"; })).stdout, /^DEC-22 line \d+: merge of t: proof does not prove, TestA passed/m);
  const later = run(tdd((e) => { e[7].result = "passes"; e.splice(8, 0, proof()); }));
  assert.equal(later.status, 0, later.stdout);
  for (const r of ["not-checked", "exempt"]) assert.match(run(tdd((e) => { e[7].result = "passes"; e.splice(8, 0, proof({ result: r })); })).stdout, /proof does not prove, TestA/m, r);
  assert.match(run(tdd((e) => { e[7].result = "passes"; e.splice(8, 0, proof({ test: "TestB" })); })).stdout, /proof does not prove, TestA/m, "a fails of another test");
});

test("tdd off (triage without tdd, or tdd false): neither DEC-21 nor DEC-22 applies, as in 0.14.0", () => {
  for (const off of [undefined, false]) {
    const e = clean().map(at(RV7));
    if (off !== undefined) e[0].tdd = off;
    const r = run(e);
    assert.equal(r.status, 0, r.stdout);
    const p = run(tdd((x) => { x[0].tdd = off; x[7].result = "passes"; x.splice(5, 1); }));
    assert.equal(p.status, 0, p.stdout);
  }
  assert.match(run(tdd((x) => { x[0].tdd = "yes"; })).stdout, /^LEDGER line 1: triage tdd must be true or false/m);
  const sticky = run(tdd((x) => { x.splice(1, 0, at(RV7)(ev("triage", { topic: "t", sec: "yes", door: "no", prod: "no", track: "full review", files: ["Makefile"] }))); x.splice(6, 1); }));
  assert.match(sticky.stdout, /^DEC-21 /m, "a later triage without tdd does not turn it off");
});

test("tdd: yes in the profile: a triage stamped 1.7.0 without tdd true is a LEDGER violation; older triage events are not", () => {
  const p = mkProfile("tdd: yes\ntargeted_test: make t");
  const runY = (events) => { const f = join(mkdtempSync(join(tmpdir(), "led-")), "l.jsonl"); writeFileSync(f, events.map((x) => JSON.stringify(x)).join("\n") + "\n"); return spawnSync("node", [audit, f, "--profile", p], { encoding: "utf8" }); };
  assert.equal(runY(tdd()).status, 0);
  assert.match(runY(tdd((x) => { delete x[0].tdd; })).stdout, /^LEDGER line 1: triage of t has no tdd: true, but the profile says tdd: yes/m);
  assert.match(runY(tdd((x) => { x[0].tdd = false; })).stdout, /^LEDGER line 1: triage of t has no tdd: true/m);
  assert.equal(runY(clean().map(at(RV6))).status, 0, "a triage stamped before 1.7.0 predates the field");
});

test("version checks only for tdd-on topics: tdd off audits as 0.14.0", () => {
  const back = (on) => { const e = clean().map(at(RV7)); if (on) e[0].tdd = true; e[4] = at(RV6)(e[4]); return e; };
  const off = run(back(false));
  assert.equal(off.status, 0, off.stdout);
  assert.doesNotMatch(off.stdout, /mixed rules versions/);
  assert.match(run(back(true)).stdout, /^LEDGER line 5: rules version goes backwards: 1\.6\.1 after 1\.7\.0 on topic t/m);
  const mixedOff = run(clean().map((x, i) => at(i < 4 ? RV6 : RV7)(x)));
  assert.doesNotMatch(mixedOff.stdout, /mixed rules versions/);
});

test("DEC-22: every test exempt on a topic whose triage files include production code warns", () => {
  const r = run(tdd((x) => { x[0].files = ["src/a.go", "docs/a.md"]; x[5].tests = []; x[5].exempt = ["TestA"]; x.splice(7, 1); }));
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /^warn: line 6: every test of t's coder_report is exempt but the step touches production code \(src\/a\.go\)/m);
  assert.doesNotMatch(run(tdd((x) => { x[0].files = ["docs/a.md"]; x[5].tests = []; x[5].exempt = ["docs"]; x.splice(7, 1); })).stdout, /every test/);
});

test("tdd: auto in the profile: a triage stamped 1.7.0 or later must record tdd true or false", () => {
  const p = mkProfile("tdd: auto\ntargeted_test: make t");
  const runA = (events) => { const f = join(mkdtempSync(join(tmpdir(), "led-")), "l.jsonl"); writeFileSync(f, events.map((x) => JSON.stringify(x)).join("\n") + "\n"); return spawnSync("node", [audit, f, "--profile", p], { encoding: "utf8" }); };
  assert.equal(runA(tdd()).status, 0);
  const off = clean().map(at(RV7)); off[0].tdd = false;
  assert.equal(runA(off).status, 0);
  assert.match(runA(clean().map(at(RV7))).stdout, /^LEDGER line 1: triage of t has no tdd true or false, but the profile says tdd: auto/m);
});

test("tdd yes or auto: a backwards rules version is a LEDGER violation anywhere in the ledger", () => {
  for (const mode of ["yes", "auto"]) {
    const p = mkProfile(`tdd: ${mode}\ntargeted_test: make t`);
    const e = tdd();
    e.push(at(RV6)(ev("triage", { topic: "t2", sec: "no", door: "no", prod: "no", track: "just do it", files: ["docs/a.md"] })));
    const f = join(mkdtempSync(join(tmpdir(), "led-")), "l.jsonl");
    writeFileSync(f, e.map((x) => JSON.stringify(x)).join("\n") + "\n");
    const r = spawnSync("node", [audit, f, "--profile", p], { encoding: "utf8" });
    assert.equal(r.status, 1, mode);
    assert.match(r.stdout, /^LEDGER line 13: rules version goes backwards: 1\.6\.1 after 1\.7\.0$/m, mode);
  }
});

test("tdd auto: a recorded tdd false that tdd-suggest would call yes (security path or door) is a LEDGER violation; code with tdd false warns", () => {
  const p = mkProfile("tdd: auto\ntargeted_test: make t");
  const runA = (events) => { const f = join(mkdtempSync(join(tmpdir(), "led-")), "l.jsonl"); writeFileSync(f, events.map((x) => JSON.stringify(x)).join("\n") + "\n"); return spawnSync("node", [audit, f, "--profile", p], { encoding: "utf8" }); };
  const tri = (o) => { const e = clean().map(at(RV7)); Object.assign(e[0], { tdd: false, ...o }); return e; };
  assert.match(runA(tri({ files: ["Makefile", "src/a.go", "src/a_test.go"] })).stdout, /^LEDGER line 1: triage of t records tdd false, but tdd-suggest says yes \(security path or one-way door\)/m);
  const door = runA(tri({ sec: "no", door: "yes", files: ["src/a.go", "src/a_test.go"] }));
  assert.match(door.stdout, /^LEDGER line 1: triage of t records tdd false/m);
  const warn = runA(tri({ sec: "no", files: ["src/a.go"] }));
  assert.equal(warn.status, 0, warn.stdout);
  assert.match(warn.stdout, /^warn: line 1: triage of t touches production code \(src\/a\.go\) with tdd false under tdd: auto/m);
  assert.doesNotMatch(runA(tri({ sec: "no", files: ["docs/a.md"] })).stdout, /tdd false/);
});

test("condition events: needs topic, id, step, test and status; status is open or proved", () => {
  const c = (o = {}) => ev("condition", { topic: "t", id: "C1", step: "s1", test: "TestDenyPath", status: "open", ...o });
  assert.equal(run([...clean(), c(), c({ status: "proved" })]).status, 0);
  const bad = run([...clean(), c({ status: "done" })]);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /LEDGER line 11: condition status must be open or proved/);
  assert.match(run([...clean(), c({ test: undefined })]).stdout, /condition needs test/);
});

test("profile base_pusher: operator is agent: a base push by agent is no violation, by owner is", () => {
  const f = join(mkdtempSync(join(tmpdir(), "prof-")), "p.md");
  writeFileSync(f, readFileSync(profile, "utf8").replace("base_pusher: owner", "base_pusher: operator"));
  const go = (events) => { const l = join(mkdtempSync(join(tmpdir(), "led-")), "l.jsonl"); writeFileSync(l, events.map((e) => JSON.stringify(e)).join("\n") + "\n"); return spawnSync("node", [audit, l, "--profile", f], { encoding: "utf8" }); };
  const e = clean(); e[8].by = "agent";
  const r = go(e);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /profile gap/);
  assert.ok(go(clean()).stdout.split("\n").some((l) => l.startsWith("DEC-06 ")));
});
