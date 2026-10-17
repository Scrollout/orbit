// Self-test of the SAST baseline (make vet): fixtures in ci/fixtures/sast hold an Opengrep result with a finding and two
// scanner errors, and a Checkov result with a failed check and an inline skip; each must be in the baseline to pass.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const fx = (n) => fileURLToPath(new URL(`../fixtures/sast/${n}`, import.meta.url));
const script = fileURLToPath(new URL("sast-baseline.mjs", import.meta.url));
const full = JSON.parse(readFileSync(fx("baseline.json"), "utf8")).entries;
const run = (entries, ck = fx("checkov.json")) => {
  const b = join(mkdtempSync(join(tmpdir(), "sast-bl-")), "baseline.json");
  writeFileSync(b, JSON.stringify({ entries }));
  const r = spawnSync(process.execPath, [script, fx("opengrep.json"), ck, b], { encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
};
const without = (rule) => full.filter((e) => e.rule !== rule);

test("every finding, scanner error and inline skip baselined with a reason passes", () => {
  const r = run(full);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /5 finding\(s\), 5 baseline entries, 0 problem\(s\)/);
});

test("an Opengrep error not in the baseline fails, keyed on its type and file", () => {
  const r = run(without("opengrep-error/Timeout"));
  assert.equal(r.code, 1);
  assert.match(r.out, /^hooks\/a\.mjs:1 opengrep-error\/Timeout: error: rule timed out$/m);
  const p = run(without("opengrep-error/PartialParsing"));
  assert.equal(p.code, 1);
  assert.match(p.out, /^scripts\/b\.mjs:4 opengrep-error\/PartialParsing: warn: Syntax error$/m);
});

test("a Checkov inline skip not in the baseline fails", () => {
  const r = run(without("checkov-skip/CKV_GHA_7"));
  assert.equal(r.code, 1);
  assert.match(r.out, /^\.github\/workflows\/ci\.yml:3 checkov-skip\/CKV_GHA_7: inline skip$/m);
});

test("an empty baseline fails and proposes every pair, a reasonless entry fails", () => {
  const r = run([]);
  assert.equal(r.code, 1);
  assert.match(r.out, /5 problem\(s\)/);
  assert.match(r.out, /"rule": "opengrep-error\/Timeout"/);
  const n = run(full.map((e) => ({ ...e, reason: " " })));
  assert.equal(n.code, 1);
  assert.match(n.out, /needs rule, file, a count of 1 or more and a reason/);
});

test("a Checkov framework without a report fails", () => {
  const ck = join(mkdtempSync(join(tmpdir(), "sast-ck-")), "checkov.json");
  writeFileSync(ck, JSON.stringify(JSON.parse(readFileSync(fx("checkov.json"), "utf8")).slice(0, 1)));
  const r = run(without("checkov-skip/CKV_GHA_7"), ck);
  assert.equal(r.code, 1);
  assert.match(r.out, /checkov: no github_actions report/);
});
