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

// Drift between the registry and the core files, one string each; `read(file)` returns a core's text.
function tagDrift(rules, read) {
  const out = [];
  for (const r of rules) {
    const text = read(r.file);
    if (text.split(r.id).length - 1 !== 1) out.push(`${r.id} must appear exactly once in ${r.file}`);
    if (!text.includes(`- ${r.id} \`${r.tag}\`: `)) out.push(`${r.id} tag ${r.tag} not in ${r.file}`);
  }
  for (const f of cores) {
    const ids = [...read(f).matchAll(/^- ((?:DEC|OPR)-\d\d) /gm)].map((m) => m[1]);
    const want = rules.filter((r) => r.file === f).map((r) => r.id);
    if (JSON.stringify(ids) !== JSON.stringify(want)) out.push(`${f} lists ${ids.join(",")} but the registry has ${want.join(",")}`);
  }
  return out;
}
const readRepo = (f) => readFileSync(join(repo, f), "utf8");

test("every rule id appears exactly once in its core file, with the registry's tag, and every core rule is registered", () => {
  assert.deepEqual(tagDrift(rules, readRepo), []);
});

test("tag drift check: a changed tag, a duplicated id, an unregistered core rule and a missing one are caught", () => {
  const swap = (id, tag) => rules.map((r) => (r.id === id ? { ...r, tag } : r));
  const first = rules.find((r) => r.file === cores[0]);
  const flipped = first.tag === "script" ? "judgment" : "script";
  assert.match(tagDrift(swap(first.id, flipped), readRepo)[0], new RegExp(`${first.id} tag ${flipped} not in ${first.file.replace("/", "\\/")}`));
  const dup = (f) => (f === first.file ? `${readRepo(f)}\n- ${first.id} \`${first.tag}\`: again\n` : readRepo(f));
  assert.match(tagDrift(rules, dup).join("\n"), new RegExp(`${first.id} must appear exactly once`));
  const extra = (f) => (f === first.file ? `${readRepo(f)}\n- DEC-99 \`judgment\`: new rule\n` : readRepo(f));
  assert.match(tagDrift(rules, extra).join("\n"), /lists .*DEC-99 but the registry has/);
  assert.match(tagDrift(rules.filter((r) => r.id !== first.id), readRepo).join("\n"), new RegExp(`lists ${first.id}`));
});

test("every hook-tagged rule names the hook that enforces it, and that hook names the rule", () => {
  for (const r of rules) {
    if (r.tag !== "hook") { assert.equal(r.enforced_by, undefined, `${r.id} is not a hook rule`); continue; }
    assert.ok(r.enforced_by && existsSync(join(repo, r.enforced_by)), `${r.id} enforced_by ${r.enforced_by}`);
    assert.ok(readFileSync(join(repo, r.enforced_by), "utf8").includes(r.id), `${r.enforced_by} does not name ${r.id}`);
  }
});

test("rule ids are defined only in the cores (refs may point to an id, never define one)", () => {
  for (const dir of ["refs/decide", "skills/operator/refs"]) {
    for (const f of readdirSync(join(repo, dir))) {
      assert.doesNotMatch(readFileSync(join(repo, dir, f), "utf8"), /^\s*- (DEC|OPR)-\d\d `/m, `${dir}/${f}`);
    }
  }
});

test("every ref file is linked from its core and every link resolves", () => {
  const dirs = { "commands/decide.md": ["refs/decide", /\$\{CLAUDE_PLUGIN_ROOT\}\/refs\/decide\/([\w-]+\.md)/g], "skills/operator/SKILL.md": ["skills/operator/refs", /\$\{CLAUDE_SKILL_DIR\}\/refs\/([\w-]+\.md)/g] };
  for (const [core, [dir, re]] of Object.entries(dirs)) {
    const text = readFileSync(join(repo, core), "utf8");
    const linked = [...text.matchAll(re)].map((m) => m[1]);
    for (const l of linked) assert.ok(existsSync(join(repo, dir, l)), `${core} links missing ${l}`);
    for (const f of readdirSync(join(repo, dir))) assert.ok(linked.includes(f), `${dir}/${f} not linked from ${core}`);
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

test("check-size skips node_modules and .git and does not follow symlinks", async () => {
  const { symlinkSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "sz-"));
  const big = "x".repeat(500);
  for (const d of ["node_modules/p/refs", ".git/refs", "elsewhere/dir"]) { mkdirSync(join(root, d), { recursive: true }); writeFileSync(join(root, d, "huge.md"), big); }
  mkdirSync(join(root, "refs"));
  symlinkSync(join(root, "elsewhere/dir"), join(root, "refs/linked"));
  symlinkSync(join(root, "elsewhere/dir/huge.md"), join(root, "refs/link.md"));
  writeFileSync(join(root, "refs/ok.md"), "ok");
  const r = size(root, "--max-chars", "100");
  assert.equal(r.status, 0, r.stdout);
  assert.doesNotMatch(r.stdout, /huge|link|node_modules/);
});
