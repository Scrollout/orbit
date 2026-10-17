import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { denied } from "./denylist.mjs";
import { actual, differs, dir, expected, names, scenario } from "./scenarios.mjs";

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

test("scenarios/ holds one <name>.json per scenario and pin.json, each with a description and an expect, and only known keys", () => {
  for (const e of readdirSync(dir, { withFileTypes: true })) assert.ok(e.isFile() && e.name.endsWith(".json"), `scenarios/${e.name}`);
  const known = new Set(["description", "profile", "profile_extra", "triage", "report", "expect", "ledger", "go_log", "report_md", "coder_md"]);
  assert.ok(names().length > 100, String(names().length));
  for (const n of names()) {
    const sc = scenario(n);
    assert.ok(typeof sc.description === "string" && sc.description && sc.expect && typeof sc.expect === "object", n);
    for (const k of Object.keys(sc)) assert.ok(known.has(k), `${n}: ${k}`);
    assert.equal(Boolean(sc.report), typeof sc.report_md === "string", `${n}: report and report_md go together`);
    for (const k of ["ledger", "go_log"]) if (k in sc) assert.ok(Array.isArray(sc[k]) && sc[k].every((l) => typeof l === "string"), `${n}: ${k} is a list of lines`);
  }
});

test("scenarios are anonymised: no project, host, user or lab names", () => {
  for (const n of names()) assert.equal(denied(JSON.stringify(scenario(n))), null, n);
});

test("a security-contest scenario is on a one-way door (DEC-13)", () => {
  for (const n of ["security-contest-rebuttal-ok", "security-contest-rebuttal-needs-reason"]) assert.equal(JSON.parse(scenario(n).ledger[0]).door, "yes", n);
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

test("the denylist catches a denied word and a /home/ path, and passes clean text", () => {
  assert.notEqual(denied(`a ${"k3"}${"s"} node`), null);
  assert.notEqual(denied("cd /home/x"), null);
  // Substring detection, case-insensitive; the word "lab" is matched whole only, so "label" stays clean.
  for (const w of ["mari" + "usg", "k3" + "sapps", "port" + "folios", "MARI" + "US", "Scroll" + "out/x"]) assert.notEqual(denied(`x ${w} y`), null, w);
  assert.notEqual(denied("the la" + "b host"), null);
  assert.equal(denied("labels and a label table"), null);
  assert.equal(denied("a clean sentence about a triage"), null);
});
