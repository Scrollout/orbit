import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { actual, differs, dir, expected, names } from "./scenarios.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(root, f), "utf8");
const version = (f) => read(f).match(/^---\r?\n([\s\S]*?)\r?\n---/)[1].match(/^version:[ \t]*(\S+)/m)[1];

for (const n of names()) {
  test(`scenario ${n}`, () => {
    const d = differs(n);
    assert.equal(d, null, `outcome changed: if on purpose, review the scenario, update expect.json, and bump the rule or skill version\n${JSON.stringify(d, null, 1)}`);
  });
}

test("scenarios are pinned to the current /decide, operator and rules versions", () => {
  const pin = JSON.parse(read("scenarios/pin.json"));
  const now = { decide: version("commands/decide.md"), operator: version("skills/operator/SKILL.md"), rules: JSON.parse(read("rules/rules.json")).version };
  for (const k of Object.keys(now)) assert.equal(pin[k], now[k], `${k} is ${now[k]} but scenarios/pin.json says ${pin[k]}: re-review the scenarios, then update the pin`);
});

test("every script-tagged rule id has a failing scenario", () => {
  const seen = new Set();
  for (const n of names()) for (const id of Object.keys(expected(n).violations ?? {})) seen.add(id);
  const missing = JSON.parse(read("rules/rules.json")).rules.filter((r) => r.tag === "script" && !seen.has(r.id)).map((r) => r.id);
  assert.deepEqual(missing, [], "add a scenario that expects each of these rule ids");
});

test("the required happy and policy scenarios exist and are clean where they should be", () => {
  const must = ["lifecycle-clean", "docs-only-just-do-it", "incident-track", "triage-security-path-forces-full-review", "security-contest-rebuttal-ok", "security-contest-rebuttal-needs-reason"];
  for (const n of must) assert.ok(names().includes(n), n);
  assert.deepEqual(actual("lifecycle-clean"), { exit: 0, violations: {} });
  assert.equal(actual("docs-only-just-do-it").track, "just do it");
  assert.equal(actual("triage-security-path-forces-full-review").track, "full review");
  assert.equal(actual("triage-security-path-forces-full-review").coder_model, "opus");
  assert.equal(actual("incident-track").track, "incident");
});

test("scenario folders hold only scenario.json, expect.json and an optional ledger.jsonl; none is empty", () => {
  for (const n of names()) {
    const files = readdirSync(join(dir, n)).sort();
    assert.ok(files.includes("scenario.json") && files.includes("expect.json"), n);
    for (const f of files) assert.ok(["scenario.json", "expect.json", "ledger.jsonl"].includes(f), `${n}/${f}`);
  }
});

test("scenarios are anonymised: no project, host, user or lab names", () => {
  for (const n of names()) for (const f of readdirSync(join(dir, n))) {
    const text = readFileSync(join(dir, n, f), "utf8");
    for (const bad of [/portfolio/i, /scrollout/i, /\/home\//, /marius/i, /platform-lab/, /k3s/i, /\blab\b/i, /gologan/i]) assert.doesNotMatch(text, bad, `${n}/${f}`);
  }
});

test("a security-contest scenario is on a one-way door (DEC-13)", () => {
  for (const n of ["security-contest-rebuttal-ok", "security-contest-rebuttal-needs-reason"]) assert.equal(JSON.parse(readFileSync(join(dir, n, "ledger.jsonl"), "utf8").split("\n")[0]).door, "yes", n);
});

test("triage-gap scenarios pin the reported gap list", () => {
  assert.deepEqual(expected("triage-gap-door-unset").gaps, ["door"]);
  assert.deepEqual(expected("triage-gap-kind-unset").gaps, ["kind"]);
});

test("a scenario run leaves no temp directory behind", () => {
  const before = readdirSync(tmpdir()).filter((f) => f.startsWith("scn-")).length;
  actual("lifecycle-clean"); actual("triage-docs-only-small");
  assert.equal(readdirSync(tmpdir()).filter((f) => f.startsWith("scn-")).length, before);
});
