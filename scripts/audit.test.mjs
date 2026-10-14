import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const audit = join(here, "audit-ledger.mjs");
const append = join(here, "ledger.mjs");
const profile = join(here, "fixtures", "real-profile.md");
const T0 = "2026-10-14T10:00:00Z";
const ev = (kind, o = {}) => ({ ts: T0, session: "s1", rule_version: { decide: "1.0.0", operator: "1.0.0" }, kind, ...o });
const SHA = "a".repeat(40), MERGE = "b".repeat(40);
const clean = () => [
  ev("triage", { topic: "t", sec: "yes", door: "no", prod: "no", track: "full review", files: ["docs/a.md", "Makefile"] }),
  ev("agent_start", { role: "engineer", model: "sonnet", topic: "t" }),
  ev("agent_start", { role: "security", model: "fable", topic: "t" }),
  ev("agent_start", { role: "coder", model: "opus", topic: "t", phase: "build" }),
  ev("ci_run", { sha: SHA, state: "green" }),
  ev("review_start", { branch: "t", sha: SHA, ci_state: "green" }),
  ev("merge_built", { merge_sha: MERGE, tree_equal: true, ci_state: "green" }),
  ev("push", { ref: "t", chained: false }),
  ev("push", { ref: "main", chained: false }),
  ev("issue_close", { n: 7, origin_base_sha: MERGE, merge_sha: MERGE }),
];
const run = (events, ...extra) => {
  const f = join(mkdtempSync(join(tmpdir(), "led-")), "ledger.jsonl");
  writeFileSync(f, events.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("\n") + "\n");
  return spawnSync("node", [audit, f, "--profile", profile, ...extra], { encoding: "utf8" });
};
const mutate = (fn) => { const e = clean(); fn(e); return e; };

test("a clean ledger passes", () => {
  const r = run(clean());
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /audit ok: 10 events/);
  assert.match(r.stdout, /decide=1\.0\.0/);
});

const bad = [
  ["DEC-01", "reviewer started before green CI", (e) => { e[5].ci_state = "pending"; }],
  ["DEC-01", "review_start with no recorded green run for that sha", (e) => { e.splice(4, 1); }],
  ["DEC-02", "branch touches a security path but triage says sec=no", (e) => { e[0].sec = "no"; }],
  ["DEC-03", "more engineers than the track allows", (e) => { e.splice(2, 0, ev("agent_start", { role: "engineer", model: "sonnet", topic: "t" }), ev("agent_start", { role: "engineer", model: "sonnet", topic: "t" })); }],
  ["DEC-04", "coder on sonnet when security=yes", (e) => { e[3].model = "sonnet"; }],
  ["DEC-05", "tree mismatch", (e) => { e[6].tree_equal = false; }],
  ["OPR-02", "merge built without green CI", (e) => { e[6].ci_state = "red"; }],
  ["DEC-06", "chained base push", (e) => { e[8].chained = true; }],
  ["OPR-03", "chained base push", (e) => { e[8].chained = true; }],
  ["DEC-07", "issue closed before origin/base equals the merge sha", (e) => { e[9].origin_base_sha = "c".repeat(40); }],
  ["OPR-04", "issue closed before origin/base equals the merge sha", (e) => { e[9].origin_base_sha = "c".repeat(40); }],
];
for (const [id, name, fn] of bad) {
  test(`${id} fails: ${name}`, () => {
    const r = run(mutate(fn));
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, new RegExp(`^${id} `, "m"));
  });
}

test("a tests-or-docs-only fix round may stay on sonnet; a cap_reason excuses an extra call", () => {
  const e = clean();
  e[3] = ev("agent_start", { role: "coder", model: "sonnet", topic: "t", phase: "fix", fix_scope: "tests-docs" });
  const eng = (o = {}) => ev("agent_start", { role: "engineer", model: "sonnet", topic: "t", ...o });
  e.splice(2, 0, eng(), eng(), eng({ cap_reason: "second real design" }));
  assert.equal(run(e).status, 1, "three counted engineers (the excused one does not count) is two plus the first: over 2");
  e.splice(2, 1);
  const r = run(e);
  assert.equal(r.status, 0, r.stdout);
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
  writeFileSync(l, JSON.stringify(ev("push", { ref: "main", chained: false })) + "\n");
  const r = spawnSync("node", [audit, l, "--profile", f], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /profile gap: base_branch/);
});

test("ledger.mjs appends one stamped JSON line per event", () => {
  const dir = mkdtempSync(join(tmpdir(), "led-"));
  const f = join(dir, "l.jsonl");
  const r = spawnSync("node", [append, "--root", join(here, ".."), "--ledger", f, "--session", "s9", "push", "ref=main", "chained:=false", "sha=1234567"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const e = JSON.parse(readFileSync(f, "utf8").trim());
  assert.equal(e.kind, "push");
  assert.equal(e.session, "s9");
  assert.equal(e.chained, false);
  assert.equal(e.sha, "1234567");
  assert.match(e.ts, /^\d{4}-\d\d-\d\dT.*Z$/);
  assert.match(e.rule_version.decide, /^\d+\.\d+\.\d+$/);
  assert.equal(run([e]).status, 0);
});
