import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "check-docs.mjs");
const run = (root) => spawnSync("node", [script, "--root", root], { encoding: "utf8" });
function tree(over = {}) {
  const root = mkdtempSync(join(tmpdir(), "docs-"));
  mkdirSync(join(root, ".claude-plugin"));
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "scripts/x.mjs"), "");
  writeFileSync(join(root, "LICENSE"), "");
  const files = {
    ".claude-plugin/plugin.json": JSON.stringify({ version: "1.2.3" }),
    "CHANGELOG.md": "# Changelog\n\n## 1.2.3\n- x\n\n## 1.2.2\n",
    "README.md": "Version: 1.2.3\n\nSee [license](LICENSE) and `scripts/x.mjs`.\n",
    ...over,
  };
  for (const [f, t] of Object.entries(files)) writeFileSync(join(root, f), t);
  return root;
}

test("consistent versions and resolving links pass", () => assert.equal(run(tree()).status, 0, run(tree()).stdout));
test("plugin.json and CHANGELOG disagree", () => {
  const r = run(tree({ "CHANGELOG.md": "# Changelog\n\n## 1.2.4\n" }));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /version: plugin\.json 1\.2\.3, CHANGELOG 1\.2\.4/);
});
test("README version line disagrees or is missing", () => {
  assert.match(run(tree({ "README.md": "Version: 1.0.0\n" })).stdout, /README says 1\.0\.0/);
  assert.match(run(tree({ "README.md": "none\n" })).stdout, /README has no `Version:` line/);
});
test("a broken link and a missing script path are reported", () => {
  const r = run(tree({ "README.md": "Version: 1.2.3\n[x](nope.md) `scripts/gone.mjs` <img src=\"assets/none.svg\">\n" }));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /broken link: nope\.md/);
  assert.match(r.stdout, /missing path: scripts\/gone\.mjs/);
  assert.match(r.stdout, /broken link: assets\/none\.svg/);
});
test("this repo's docs are consistent", () => {
  const r = run(join(here, ".."));
  assert.equal(r.status, 0, r.stdout);
});

test("the README ledger table equals refs/decide/ledger.md", async () => {
  const { readFileSync } = await import("node:fs");
  const tbl = (f) => readFileSync(join(here, "..", f), "utf8").split("\n").filter((l) => /^\| (kind|---|`)/.test(l)).join("\n");
  assert.equal(tbl("README.md"), tbl("refs/decide/ledger.md"));
  assert.match(tbl("README.md"), /`merge_built`/);
});
