import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "profile.mjs");
const fixture = join(here, "fixtures", "real-profile.md");
const run = (root, ...a) => spawnSync("node", [script, "--root", root, ...a], { encoding: "utf8" });
const rootWith = (text) => {
  const root = mkdtempSync(join(tmpdir(), "prof-"));
  mkdirSync(join(root, ".agents"));
  writeFileSync(join(root, ".agents", "project.md"), text);
  return root;
};
const block = (body) => "# P\n\n```yaml orbit-profile\n" + body + "\n```\n";
const full = `base_branch: main
security_paths: ["a/**", Makefile]
review_trailer: Reviewed-by
labels: [bug, chore]
issue_tracker: github
base_pusher: agent
ci_policy: ci-only`;

test("fixture copy of a real profile has no gap and covers the supply-chain paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "prof-"));
  mkdirSync(join(root, ".agents"));
  cpSync(fixture, join(root, ".agents", "project.md"));
  const r = run(root);
  assert.equal(r.stdout.trim(), "");
  assert.equal(r.status, 0);
  const { loadProfile, matchesAny } = await import("./profile.mjs");
  const g = loadProfile(root).data.security_paths;
  for (const f of [".github/dependabot.yml", "SECURITY.md", ".github/CODEOWNERS", "scripts/vuln-switch.sh", "ci/images.mk", "ci/x/y.mk"]) assert.ok(matchesAny(f, g), f);
});

test("complete profile: no gap, exit 0, --json parses lists", () => {
  const root = rootWith(block(full));
  const r = run(root, "--json");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const p = JSON.parse(r.stdout);
  assert.deepEqual(p.security_paths, ["a/**", "Makefile"]);
  assert.equal(p.base_branch, "main");
});

test("missing and TODO fields are gaps, never guessed", () => {
  const root = rootWith(block(full.replace("base_branch: main\n", "").replace("github", "TODO").replace("[bug, chore]", "[]")));
  const r = run(root);
  assert.deepEqual(r.stdout.trim().split("\n").sort(), ["profile gap: base_branch", "profile gap: issue_tracker", "profile gap: labels"]);
  assert.equal(r.status, 1);
});

test("no block: every required field is a gap", () => {
  const r = run(rootWith("# P\nno block\n"));
  assert.match(r.stdout, /profile gap: base_branch/);
  assert.match(r.stdout, /profile gap: ci_policy/);
  assert.doesNotMatch(r.stdout, /production_env/);
  assert.equal(r.status, 1);
});

test("bad enum value is a gap", () => {
  const r = run(rootWith(block(full.replace("ci-only", "whatever"))));
  assert.equal(r.stdout.trim(), "profile gap: ci_policy");
});

test("a scalar where a list is expected is a gap, not a crash", () => {
  const r = run(rootWith(block(full.replace('security_paths: ["a/**", Makefile]', "security_paths: internal/auth/"))));
  assert.equal(r.stdout.trim(), "profile gap: security_paths");
  assert.doesNotMatch(r.stderr, /TypeError/);
});

test("duplicate keys warn on stderr (last one wins)", () => {
  const r = run(rootWith(block(full + "\nbase_branch: develop")), "--json");
  assert.match(r.stderr, /profile warning: duplicate key base_branch/);
  assert.equal(JSON.parse(r.stdout).base_branch, "develop");
});

test("globs: root-anchored, ** crosses directories, **/ matches nested and root, braces are literal", async () => {
  const { matchesAny } = await import("./profile.mjs");
  assert.ok(matchesAny("Makefile", ["Makefile"]));
  assert.ok(!matchesAny("sub/Makefile", ["Makefile"]));
  assert.ok(matchesAny("sub/Makefile", ["**/Makefile"]));
  assert.ok(matchesAny("Makefile", ["**/Makefile"]));
  assert.ok(!matchesAny("fooMakefile", ["**/Makefile"]));
  assert.ok(matchesAny("ci/images.mk", ["ci/**"]));
  assert.ok(!matchesAny("a.go", ["{a,b}.go"]));
});
