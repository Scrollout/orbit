// Self-test of the report renderer (make report-test, part of make vet): fixtures for pass, fail, skipped and oversize.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { load, render } from "./report.mjs";

const fx = (n) => load(fileURLToPath(new URL(`../fixtures/${n}`, import.meta.url)));

test("mixed: icons, totals, table per target, details only for the failure", () => {
  const md = render(fx("mixed"));
  assert.match(md, /# CI report: ❌ failed/);
  assert.match(md, /1 passed, 1 failed, 1 skipped, 3 s/);
  assert.match(md, /## vet[\s\S]*## security/);
  assert.match(md, /\| ✅ \| shellcheck \| shellcheck \| 0\.11\.0 \| 0 \| 1 \|/);
  assert.match(md, /\| ⏭️ \| npm-audit \(no dependencies\)/);
  assert.equal(md.match(/<details>/g).length, 1);
  assert.match(md, /a\.yml:3:5: bad/);
  assert.match(md, /1 more not shown/);
});

test("all pass renders passed and no details", () => {
  const md = render(fx("mixed").filter((r) => r.status !== "fail"));
  assert.match(md, /✅ passed/);
  assert.doesNotMatch(md, /<details>/);
});

test("oversize: stays under the limit, balanced details, says it was truncated", () => {
  const md = render(fx("oversize"), 20000); // the fixture is 56 KB: a small limit stands in for 1 MiB
  assert.ok(Buffer.byteLength(md) <= 20000, "over limit");
  assert.match(md, /truncated at the 1 MiB/);
  assert.equal((md.match(/<details>/g) || []).length, (md.match(/<\/details>/g) || []).length);
  assert.ok((md.match(/<details>/g) || []).length < 10);
});
