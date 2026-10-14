import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repo, "scripts/manifest.mjs");
const run = (root, ...a) => spawnSync("node", [script, "--root", root, ...a], { encoding: "utf8" });
const doc = (v, body) => `---\nname: x\nversion: ${v}\n---\n${body}\n`;
function tree() {
  const root = mkdtempSync(join(tmpdir(), "man-"));
  mkdirSync(join(root, "commands"));
  mkdirSync(join(root, "refs/cmd"), { recursive: true });
  mkdirSync(join(root, "skills/sk"), { recursive: true });
  writeFileSync(join(root, "commands/cmd.md"), doc("1.0.0", "core"));
  writeFileSync(join(root, "refs/cmd/a.md"), "ref a");
  writeFileSync(join(root, "skills/sk/SKILL.md"), doc("1.0.0", "skill"));
  assert.equal(run(root, "--update").status, 0);
  return root;
}
const bump = (f, from, to) => writeFileSync(f, readFileSync(f, "utf8").replace(`version: ${from}`, `version: ${to}`));

test("the repo's own manifest is current", () => {
  const r = run(repo, "--check");
  assert.equal(r.status, 0, r.stdout);
  const m = JSON.parse(readFileSync(join(repo, "skills/MANIFEST.json"), "utf8"));
  assert.ok(m.entries["commands/decide.md"].files.includes("refs/decide/record.md"));
  assert.ok(m.entries["skills/operator/SKILL.md"].files.includes("skills/operator/refs/workers.md"));
});

test("clean tree passes check", () => assert.equal(run(tree(), "--check").status, 0));

test("editing a core without a version bump fails and names the entry", () => {
  const root = tree();
  writeFileSync(join(root, "commands/cmd.md"), doc("1.0.0", "core changed"));
  const r = run(root, "--check");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /commands\/cmd\.md: edited without a version bump/);
  assert.equal(run(root, "--update").status, 1, "update refuses an unbumped edit");
});

test("editing a ref counts as editing the skill", () => {
  const root = tree();
  writeFileSync(join(root, "refs/cmd/a.md"), "ref a changed");
  assert.match(run(root, "--check").stdout, /commands\/cmd\.md: edited without a version bump/);
});

test("bump then update passes; bump without update reports a stale manifest", () => {
  const root = tree();
  writeFileSync(join(root, "skills/sk/SKILL.md"), doc("1.0.0", "skill v2"));
  bump(join(root, "skills/sk/SKILL.md"), "1.0.0", "1.1.0");
  assert.match(run(root, "--check").stdout, /skills\/sk\/SKILL\.md: manifest stale/);
  assert.equal(run(root, "--update").status, 0);
  assert.equal(run(root, "--check").status, 0);
});

test("a skill missing from the manifest, or without a version, fails", () => {
  const root = tree();
  writeFileSync(join(root, "commands/new.md"), doc("1.0.0", "n"));
  assert.match(run(root, "--check").stdout, /commands\/new\.md: not in manifest/);
  writeFileSync(join(root, "commands/new.md"), "no frontmatter");
  assert.match(run(root, "--check").stdout, /commands\/new\.md: no version/);
});

test("print lists a hash per entry", () => {
  const r = run(tree(), "--print");
  assert.match(r.stdout, /^[0-9a-f]{64}  1\.0\.0  commands\/cmd\.md$/m);
});
