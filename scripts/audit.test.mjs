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
    assert.match(r.stdout, new RegExp(`^${id} `, "m"));
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
  assert.doesNotMatch(run(clean()).stdout, /warn:/);
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
