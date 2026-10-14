import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const { rules } = JSON.parse(readFileSync(join(repo, "rules/rules.json"), "utf8"));
const cores = ["commands/decide.md", "skills/operator/SKILL.md"];

test("every rule id appears exactly once in its core file, with the registry's tag, and every core rule is registered", () => {
  for (const r of rules) {
    const text = readFileSync(join(repo, r.file), "utf8");
    assert.equal(text.split(r.id).length - 1, 1, `${r.id} in ${r.file}`);
    assert.ok(text.includes(`- ${r.id} \`${r.tag}\`: `), `${r.id} tag ${r.tag}`);
  }
  for (const f of cores) {
    const ids = [...readFileSync(join(repo, f), "utf8").matchAll(/^- ((?:DEC|OPR)-\d\d) /gm)].map((m) => m[1]);
    assert.deepEqual(ids, rules.filter((r) => r.file === f).map((r) => r.id), f);
  }
});

test("rule ids are not repeated in refs", () => {
  for (const dir of ["refs/decide", "skills/operator/refs"]) {
    for (const f of readdirSync(join(repo, dir))) {
      assert.doesNotMatch(readFileSync(join(repo, dir, f), "utf8"), /\b(DEC|OPR)-\d\d\b/, `${dir}/${f}`);
    }
  }
});

test("every ref file is linked from its core and every link resolves", () => {
  const dirs = { "commands/decide.md": "refs/decide", "skills/operator/SKILL.md": "skills/operator/refs" };
  for (const [core, dir] of Object.entries(dirs)) {
    const text = readFileSync(join(repo, core), "utf8");
    const linked = [...text.matchAll(new RegExp(`${dir.replace(/\//g, "\\/")}\\/[\\w-]+\\.md`, "g"))].map((m) => m[0]);
    for (const l of linked) assert.ok(existsSync(join(repo, l)), `${core} links missing ${l}`);
    for (const f of readdirSync(join(repo, dir))) assert.ok(linked.includes(`${dir}/${f}`), `${dir}/${f} not linked from ${core}`);
  }
});

const size = (root, ...a) => spawnSync("node", [join(repo, "scripts/check-size.mjs"), "--root", root, ...a], { encoding: "utf8" });

test("check-size passes on this repo", () => {
  const r = size(repo);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /largest/);
});

test("check-size fails over the threshold and lists the largest first", () => {
  const root = mkdtempSync(join(tmpdir(), "sz-"));
  mkdirSync(join(root, "commands"));
  writeFileSync(join(root, "commands/big.md"), "x".repeat(200));
  writeFileSync(join(root, "commands/small.md"), "x".repeat(50));
  const r = size(root, "--max-chars", "100");
  assert.equal(r.status, 1);
  const lines = r.stdout.split("\n");
  assert.ok(lines.findIndex((l) => l.includes("big.md")) < lines.findIndex((l) => l.includes("small.md")));
  assert.match(r.stdout, /over: commands\/big\.md/);
  assert.doesNotMatch(r.stdout, /over: commands\/small/);
  assert.equal(size(root, "--max-chars", "100", "--max-lines", "1000").status, 1);
  assert.equal(size(root, "--max-chars", "1000").status, 0);
});
