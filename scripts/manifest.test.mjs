import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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
  assert.match(r.stdout, /^[0-9a-f]{64} {2}1\.0\.0 {2}commands\/cmd\.md$/m);
});

function treeWithShared() {
  const root = tree();
  mkdirSync(join(root, "rules"));
  writeFileSync(join(root, "rules/rules.json"), JSON.stringify({ version: "1.0.0", rules: [] }));
  writeFileSync(join(root, "rules/tracks.json"), JSON.stringify({ tracks: { x: { max: 1 } } }));
  writeFileSync(join(root, "scripts-dummy.txt"), "");
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "scripts/a.mjs"), "// a");
  writeFileSync(join(root, "scripts/a.test.mjs"), "// test, not hashed");
  assert.equal(run(root, "--update").status, 0);
  return root;
}

test("rules, tracks and scripts are hashed as one shared entry, versioned by rules.json", () => {
  const root = treeWithShared();
  assert.equal(run(root, "--check").status, 0);
  const m = JSON.parse(readFileSync(join(root, "skills/MANIFEST.json"), "utf8")).entries["rules/rules.json"];
  assert.deepEqual(m.files, ["rules/rules.json", "rules/tracks.json", "scripts/a.mjs"]);
  writeFileSync(join(root, "rules/tracks.json"), JSON.stringify({ tracks: { x: { max: 2 } } }));
  assert.match(run(root, "--check").stdout, /rules\/rules\.json: edited without a version bump/);
  writeFileSync(join(root, "rules/tracks.json"), JSON.stringify({ tracks: { x: { max: 1 } } }));
  writeFileSync(join(root, "scripts/a.mjs"), "// changed");
  assert.match(run(root, "--check").stdout, /edited without a version bump/);
  writeFileSync(join(root, "scripts/a.mjs"), "// a");
  writeFileSync(join(root, "scripts/a.test.mjs"), "// test changed");
  assert.equal(run(root, "--check").status, 0, "tests are not part of the hash");
});

test("a CRLF frontmatter still yields its version", () => {
  const root = tree();
  writeFileSync(join(root, "commands/cmd.md"), "---\r\nname: x\r\nversion: 1.0.0\r\n---\r\ncore\r\n");
  const r = run(root, "--print");
  assert.match(r.stdout, / {2}1\.0\.0 {2}commands\/cmd\.md$/m);
});

test("--check on a nonexistent or empty root fails; --root without a value is a usage error", () => {
  const empty = mkdtempSync(join(tmpdir(), "man-"));
  const r = run(empty, "--check");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /no commands or skills found/);
  assert.equal(run(join(empty, "nope"), "--check").status, 1);
  const bad = spawnSync("node", [script, "--root", "--check"], { encoding: "utf8" });
  assert.equal(bad.status, 64);
});

test("only the first frontmatter block gives the version", () => {
  const root = tree();
  writeFileSync(join(root, "commands/cmd.md"), "---\nname: x\n---\nbody\n---\nversion: 9.9.9\n---\n");
  assert.match(run(root, "--check").stdout, /commands\/cmd\.md: no version/);
});

test("hooks, agents and templates/project.md join the shared hash", () => {
  const root = treeWithShared();
  mkdirSync(join(root, "hooks")); mkdirSync(join(root, "agents")); mkdirSync(join(root, "templates"));
  writeFileSync(join(root, "hooks/h.sh"), "h"); writeFileSync(join(root, "hooks/h.test.sh"), "t");
  writeFileSync(join(root, "agents/a.md"), "a"); writeFileSync(join(root, "templates/project.md"), "p"); writeFileSync(join(root, "templates/other.md"), "o");
  assert.match(run(root, "--check").stdout, /rules\/rules\.json: edited without a version bump/);
  writeFileSync(join(root, "rules/rules.json"), JSON.stringify({ version: "1.0.1", rules: [] }));
  assert.equal(run(root, "--update").status, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(root, "skills/MANIFEST.json"), "utf8")).entries["rules/rules.json"].files,
    ["rules/rules.json", "rules/tracks.json", "scripts/a.mjs", "hooks/h.sh", "agents/a.md", "templates/project.md"]);
  writeFileSync(join(root, "agents/a.md"), "changed");
  assert.match(run(root, "--check").stdout, /edited without a version bump/);
  writeFileSync(join(root, "templates/other.md"), "not hashed");
});

test("the rules entry also hashes scenarios, the scenario test and the profile fixture", () => {
  const m = JSON.parse(readFileSync(join(repo, "skills/MANIFEST.json"), "utf8")).entries["rules/rules.json"].files;
  for (const f of ["scenarios/pin.json", "scenarios/lifecycle-clean.json", "scripts/scenarios.test.mjs", "scripts/fixtures/real-profile.md"]) assert.ok(m.includes(f), f);
  const root = tree();
  mkdirSync(join(root, "rules"));
  mkdirSync(join(root, "scenarios/s"), { recursive: true });
  mkdirSync(join(root, "scripts/fixtures"), { recursive: true });
  writeFileSync(join(root, "rules/rules.json"), JSON.stringify({ version: "1.0.0", rules: [] }));
  writeFileSync(join(root, "scenarios/s/expect.json"), "{}");
  writeFileSync(join(root, "scripts/fixtures/real-profile.md"), "p");
  writeFileSync(join(root, "scripts/scenarios.test.mjs"), "t");
  assert.equal(run(root, "--update").status, 0);
  assert.equal(run(root, "--check").status, 0);
  for (const [f, body] of [["scenarios/s/expect.json", '{"x":1}'], ["scripts/fixtures/real-profile.md", "q"], ["scripts/scenarios.test.mjs", "u"]]) {
    const old = readFileSync(join(root, f), "utf8");
    writeFileSync(join(root, f), body);
    const r = run(root, "--check");
    assert.equal(r.status, 1, f);
    assert.match(r.stdout, /rules\/rules\.json: edited without a version bump/);
    writeFileSync(join(root, f), old);
  }
  rmSync(join(root, "scenarios/s/expect.json"));
  assert.equal(run(root, "--check").status, 1, "a deleted scenario file trips it");
});
