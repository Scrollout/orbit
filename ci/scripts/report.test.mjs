// Self-test of the report renderer (make report-test, part of make vet): fixtures for pass, fail, skipped, oversize,
// hostile excerpts, missing targets and corrupt lines.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { load, render } from "./report.mjs";

const fx = (n) => load(fileURLToPath(new URL(`../fixtures/${n}`, import.meta.url)));
const count = (md, re) => (md.match(re) || []).length;
const wellFormed = (md) => {
  assert.equal(count(md, /<details>/g), count(md, /<\/details>/g), "unbalanced details");
  assert.equal(count(md, /^```$/gm) % 2, 0, "odd number of fences");
};

test("mixed: icons, totals, a table per target, details only for the failure, missing targets failed", () => {
  const md = render(fx("mixed"));
  assert.match(md, /# CI report: ❌ failed/);
  assert.match(md, /1 passed, 3 failed, 1 skipped, 3 s/);
  assert.match(md, /## vet[\s\S]*## quality[\s\S]*## security[\s\S]*## sast/);
  assert.match(md, /\| ❌ \| \(target\) \| - \| - \| 1 \| 0 \|/); // quality and sast have no file
  assert.match(md, /sast\/\(target\): 1 finding/);
  assert.match(md, /no result recorded/);
  assert.match(md, /\| ✅ \| shellcheck \| shellcheck \| 0\.11\.0 \| 0 \| 1 \|/);
  assert.match(md, /\| ⏭️ \| npm-audit \(no dependencies\)/);
  assert.match(md, /a\.yml:3:5: bad/);
  assert.match(md, /1 more not shown/);
  wellFormed(md);
});

test("all targets passing renders passed and no details", () => {
  const ok = (target) => ({ check: "c", target, status: "pass", duration_s: 1, tool: "t", version: "1", findings: 0, excerpts: [] });
  const md = render(["vet", "quality", "security", "sast"].map(ok));
  assert.match(md, /✅ passed/);
  assert.doesNotMatch(md, /<details>/);
});

test("an empty or absent target is a failed target", () => {
  const md = render([], 1000000, ["vet"]);
  assert.match(md, /❌ failed/);
  assert.match(md, /vet\/\(target\): 1 finding/);
});

test("a corrupt line is a failed record, not a crash", () => {
  const md = render(fx("corrupt"), 1000000, ["quality"]);
  assert.match(md, /❌ failed/);
  assert.match(md, /corrupt record/);
  assert.match(md, /quality\.jsonl:2 is not a valid check record/);
});

test("hostile excerpts cannot break out of the fence or the details", () => {
  const md = render(fx("hostile"), 1000000, ["vet"]);
  assert.equal(count(md, /<details>/g), 1);
  assert.equal(count(md, /<\/details>/g), 1);
  assert.doesNotMatch(md, /<summary>x|<details open>|<b>/);
  assert.equal(count(md, /^```$/gm), 2);
  wellFormed(md);
});

test("oversize: a cut never lands inside a details block", () => {
  const all = fx("oversize");
  const one = render(all.slice(0, 1), 1000000, []).length;
  for (const limit of [20000, 20000 + one / 2, 30001, 41234]) {
    const md = render(all, limit, []);
    assert.ok(Buffer.byteLength(md) <= limit, `over limit ${limit}`);
    assert.match(md, /truncated at the 1 MiB/);
    wellFormed(md);
    assert.ok(count(md, /<details>/g) < 10);
  }
});

test("a backslash before a pipe in a check name stays in one table cell", () => {
  const rec = { check: "a\\|b", target: "vet", status: "pass", duration_s: 1, tool: "t", version: "1", findings: 0, excerpts: [] };
  const row = render([rec], 1000000, ["vet"]).split("\n").find((l) => l.includes("a\\"));
  assert.ok(row, "row rendered");
  // split on pipes not preceded by an odd run of backslashes: 6 cells between 7 delimiters
  const cells = row.split(/(?<!(?<!\\)(?:\\\\)*\\)\|/);
  assert.equal(cells.length, 8, row);
});
