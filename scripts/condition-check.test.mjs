import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { conditionGaps } from "./condition-check.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ev = (kind, o) => ({ ts: "2026-10-14T10:00:00Z", session: "s1", rule_version: {}, kind, ...o });
const cond = (o = {}) => ev("condition", { topic: "t", id: "C1", step: "s1", test: "TestDeny", status: "open", ...o });
const report = (tests) => ev("coder_report", { branch: "t", evidence: "ok", tests });
const check = (o) => ev("proof_check", { branch: "t", sha: "a".repeat(40), test: "TestDeny", ...o });

test("an open condition is a gap; proved with a proved test is not; no conditions is fine", () => {
  assert.deepEqual(conditionGaps([], undefined), []);
  assert.deepEqual(conditionGaps([cond()]), ["t C1: open, proof test TestDeny not proved yet"]);
  assert.deepEqual(conditionGaps([cond(), report(["TestDeny"]), cond({ status: "proved" })]), []);
});

test("the latest event of an id counts, per topic", () => {
  assert.deepEqual(conditionGaps([cond({ status: "proved" }), report(["TestDeny"]), cond()]), ["t C1: open, proof test TestDeny not proved yet"]);
  assert.deepEqual(conditionGaps([cond(), cond({ topic: "u" })], "u"), ["u C1: open, proof test TestDeny not proved yet"]);
});

test("proved needs the test in a coder_report of the topic or a proof_check that fails; a passing check does not prove", () => {
  assert.match(conditionGaps([cond({ status: "proved" })])[0], /in no coder_report of the topic/);
  assert.match(conditionGaps([report(["TestOther"]), cond({ status: "proved" })])[0], /in no coder_report/);
  assert.deepEqual(conditionGaps([check({ result: "fails" }), cond({ status: "proved" })]), []);
  assert.match(conditionGaps([report(["TestDeny"]), check({ result: "passes" }), cond({ status: "proved" })])[0], /does not prove the condition/);
  assert.deepEqual(conditionGaps([report(["TestDeny"]), check({ result: "passes" }), check({ result: "fails" }), cond({ status: "proved" })]), []);
});

test("a bad status, an empty step or test name is a gap", () => {
  assert.match(conditionGaps([cond({ status: "done" })])[0], /status must be open or proved/);
  assert.deepEqual(conditionGaps([cond({ test: "", status: "proved" })]), ["t C1: no proof test name"]);
  assert.deepEqual(conditionGaps([report(["TestDeny"]), cond({ step: "", status: "proved" })]), ["t C1: no step"]);
});

test("cli: exit 2 with gap lines, 0 when clean, 64 without a ledger", () => {
  const f = join(mkdtempSync(join(tmpdir(), "cc-")), "l.jsonl");
  const run = (events, ...a) => { writeFileSync(f, events.map((e) => JSON.stringify(e)).join("\n") + "\nnot json\n"); return spawnSync("node", [join(here, "condition-check.mjs"), f, ...a], { encoding: "utf8" }); };
  const bad = run([cond()], "--topic", "t");
  assert.equal(bad.status, 2);
  assert.match(bad.stdout, /^condition gap: t C1: open/);
  assert.equal(run([cond()], "--topic", "other").status, 0);
  const ok = run([report(["TestDeny"]), cond({ status: "proved" })]);
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout.trim(), "condition ok");
  assert.deepEqual(JSON.parse(run([cond()], "--json").stdout), { gaps: ["t C1: open, proof test TestDeny not proved yet"] });
  assert.equal(spawnSync("node", [join(here, "condition-check.mjs"), "/nonexistent/l.jsonl"], { encoding: "utf8" }).status, 64);
});
