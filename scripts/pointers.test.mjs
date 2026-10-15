import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { hasBareRefs } from "./rx.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const cores = [
  ["commands/decide.md", null],
  ["commands/okf-init.md", null],
  ["skills/operator/SKILL.md", "skills/operator"],
  ["skills/peer/SKILL.md", "skills/peer"],
  ["skills/okf/SKILL.md", "skills/okf"],
  ["skills/intent/SKILL.md", "skills/intent"],
];
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const docs = () => [...cores.map(([f, s]) => [f, s]), ...["refs", "skills/operator/refs"].flatMap((d) => walk(join(repo, d)).map((p) => [p.slice(repo.length + 1), null]))];
const sub = (text, skillDir) => text.replaceAll("${CLAUDE_PLUGIN_ROOT}", repo).replaceAll("${CLAUDE_SKILL_DIR}", skillDir ? join(repo, skillDir) : "/nonexistent-skill-dir");

test("every ${CLAUDE_PLUGIN_ROOT} / ${CLAUDE_SKILL_DIR} pointer resolves, no bare refs/ pointers, no <orbit>", () => {
  let n = 0;
  for (const [f, skillDir] of docs()) {
    const raw = readFileSync(join(repo, f), "utf8");
    assert.doesNotMatch(raw, /<orbit>/, `${f} has <orbit>`);
    assert.equal(hasBareRefs(raw), false, `${f} has a bare refs pointer`);
    for (const m of raw.matchAll(/\$\{(CLAUDE_PLUGIN_ROOT|CLAUDE_SKILL_DIR)\}\/([\w./-]+?)(?=[\s`"')]|$)/gm)) {
      const path = sub(m[0], skillDir);
      assert.ok(existsSync(path), `${f}: ${m[0]} -> ${path}`);
      n++;
    }
  }
  assert.ok(n >= 10, `only ${n} pointers checked`);
});

test("the pointers resolve from a foreign cwd too", () => {
  const r = spawnSync("node", ["--test", join(repo, "scripts/pointers.test.mjs"), "--test-name-pattern=every"], { cwd: "/", encoding: "utf8", env: { ...process.env, POINTERS_INNER: "1" } });
  if (process.env.POINTERS_INNER) return;
  assert.equal(r.status, 0, r.stdout);
});
