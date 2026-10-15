import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, readFileSync } from "node:fs";
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

test("a column-0 list under a key is accepted", () => {
  const body = full.replace('security_paths: ["a/**", Makefile]', "security_paths:\n- a/**\n- Makefile");
  const r = run(rootWith(block(body)), "--json");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).security_paths, ["a/**", "Makefile"]);
});

test("a scalar followed by list items is a gap with a warning, never a silent replace", () => {
  const body = full.replace('security_paths: ["a/**", Makefile]', "security_paths: x\n  - y");
  const r = run(rootWith(block(body)));
  assert.equal(r.stdout.trim(), "profile gap: security_paths");
  assert.match(r.stderr, /profile warning: security_paths: list items after a scalar/);
});

test("__proto__ keys are ignored with a warning", () => {
  const r = run(rootWith(block(full + "\n__proto__: x")), "--json");
  assert.match(r.stderr, /profile warning: ignored key __proto__/);
  assert.equal(Object.keys(JSON.parse(r.stdout)).includes("__proto__"), false);
});

test("optional fields: standing_waivers list (empty is fine, scalar is a gap), ledger_path scalar", () => {
  assert.equal(run(rootWith(block(full + "\nstanding_waivers: [docs-only]\nledger_path: .agents/ledger.jsonl"))).status, 0);
  assert.equal(run(rootWith(block(full + "\nstanding_waivers: []"))).status, 0);
  assert.equal(run(rootWith(block(full + "\nstanding_waivers: docs-only"))).stdout.trim(), "profile gap: standing_waivers");
});

test("glob semantics as documented: * and ? stay in a segment, a match covers everything below, case-sensitive", async () => {
  const { matchesAny } = await import("./profile.mjs");
  assert.ok(matchesAny("src/a", ["src/*"]));
  assert.ok(matchesAny("src/a/b.go", ["src/*"]), "covers below a matched segment");
  assert.ok(!matchesAny("src", ["src/*"]));
  assert.ok(matchesAny("ab", ["a?"]));
  assert.ok(!matchesAny("a", ["a?"]));
  assert.ok(!matchesAny("a/b", ["a?"]));
  assert.ok(matchesAny("README.md", ["*.md"]));
  assert.ok(!matchesAny("docs/README.md", ["*.md"]));
  assert.ok(!matchesAny("readme.MD", ["*.md"]));
  assert.ok(matchesAny("a/b/c", ["a/**"]));
  assert.ok(matchesAny("a/x/y/z.go", ["a/**/z.go"]));
});

test("a pattern of many stars is not a ReDoS", async () => {
  const { matchesAny } = await import("./profile.mjs");
  const t = Date.now();
  assert.equal(matchesAny("a".repeat(40), ["*".repeat(30) + "Z"]), false);
  assert.equal(matchesAny("a/".repeat(20), ["**/".repeat(15) + "Z"]), false);
  assert.equal(matchesAny("ab".repeat(20), ["*a*a*a*a*a*a*a*a*a*a*Z"]), false);
  assert.ok(Date.now() - t < 500, `took ${Date.now() - t} ms`);
});

test("the fixture is anonymised: no project, host, user or lab names", () => {
  const text = readFileSync(fixture, "utf8");
  for (const bad of [/portfolio/i, /scrollout/i, /\/home\//, /marius/i, /platform-lab/, /k3s/i, /\blab\b/i, /gologan/i]) assert.doesNotMatch(text, bad);
});

test("an empty, / or ./ security_paths entry is a profile gap, never a match-all", async () => {
  const { gaps } = await import("./profile.mjs");
  const mk = (sp) => ({ base_branch: "main", security_paths: sp, review_trailer: "R", labels: ["a"], issue_tracker: "github", base_pusher: "agent", ci_policy: "ci-only" });
  assert.deepEqual(gaps(mk(["a/", "Makefile"])), []);
  for (const bad of ["", "/", "./", " ", "."]) assert.deepEqual(gaps(mk(["a/", bad])), ["security_paths"], JSON.stringify(bad));
  const r = run(rootWith(block(full.replace('["a/**", Makefile]', '["a/**", "/"]'))));
  assert.match(r.stdout, /^profile gap: security_paths$/m);
});

test("a security_paths entry with no non-empty segment is a gap, block or inline form", async () => {
  const { gaps } = await import("./profile.mjs");
  const mk = (sp) => ({ base_branch: "main", security_paths: sp, review_trailer: "R", labels: ["a"], issue_tracker: "github", base_pusher: "agent", ci_policy: "ci-only" });
  for (const bad of ["//", ".//", "///", "./."]) assert.deepEqual(gaps(mk(["a/", bad])), ["security_paths"], bad);
  for (const inline of ['[a/, ""]', "[a/, , b]", "[a/, ]", "[, a/]"]) {
    const r = run(rootWith(block(full.replace('["a/**", Makefile]', inline))));
    assert.match(r.stdout, /^profile gap: security_paths$/m, inline);
  }
  assert.equal(run(rootWith(block(full.replace('["a/**", Makefile]', "[]")))).stdout.trim(), "profile gap: security_paths");
});

test("release fields are optional; a bad or TODO value is a gap for profile.mjs but not for triage", () => {
  assert.equal(run(rootWith(block(`${full}\nrelease_when: change-set\nrelease_via: ci\nrelease_tool: none\nchangelog: CHANGELOG.md\nversion_files: [package.json]`))).status, 0);
  for (const [line, field] of [["release_when: weekly", "release_when"], ["release_when: TODO", "release_when"], ["release_via: laptop", "release_via"], ["release_tool: make", "release_tool"], ["version_files: package.json", "version_files"]]) {
    const root = rootWith(block(`${full}\n${line}`));
    const r = run(root);
    assert.equal(r.status, 1, line);
    assert.match(r.stdout, new RegExp(`^profile gap: ${field}$`, "m"), line);
    const t = spawnSync("node", [join(here, "decide-triage.mjs"), "--root", root, "--files", "x.md", "--lines", "sec=no,door=no,prod=no", "--kind", "small"], { encoding: "utf8" });
    assert.equal(t.status, 0, `${line}: ${t.stdout}`);
  }
});

test("test_first_commit is optional: unset, no or yes pass; another value is a gap for profile.mjs but not for triage", () => {
  assert.equal(run(rootWith(block(full))).status, 0);
  for (const v of ["no", "yes"]) assert.equal(run(rootWith(block(`${full}\ntest_first_commit: ${v}`))).status, 0, v);
  const root = rootWith(block(`${full}\ntest_first_commit: maybe`));
  assert.equal(run(root).stdout.trim(), "profile gap: test_first_commit");
  const t = spawnSync("node", [join(here, "decide-triage.mjs"), "--root", root, "--files", "x.md", "--lines", "sec=no,door=no,prod=no", "--kind", "small"], { encoding: "utf8" });
  assert.equal(t.status, 0, t.stdout);
});
