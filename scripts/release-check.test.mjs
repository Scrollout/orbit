import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "release-check.mjs");
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
const check = (root, args, env = {}) => spawnSync("node", [script, "--root", root, ...args], { encoding: "utf8", env: { ...ENV, ...env } });
const git = (root, ...a) => { const r = spawnSync("git", ["-C", root, ...a], { encoding: "utf8", env: ENV }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
const VF = ["--version-files", "package.json,README.md", "--changelog", "CHANGELOG.md"];

// A repo at v1.0.0 (annotated tag), then one commit per subject; the version files declare `version`.
function repo(subjects, version, { changelogVersion = version, readme = version, releaseMsg = "chore: release" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rel-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "remote", "add", "origin", "git@github.com:o/r.git");
  const write = (v, cv, rv) => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "r", version: v }) + "\n");
    writeFileSync(join(root, "README.md"), `# R\n\nVersion: ${rv} (see the changelog).\n`);
    writeFileSync(join(root, "CHANGELOG.md"), `# Changelog\n\n## [Unreleased]\n\n## [${cv}] - 2026-10-14\n- Change for ${cv}.\n\n## [1.0.0] - 2026-10-01\n- First.\n`);
  };
  write("1.0.0", "1.0.0", "1.0.0");
  git(root, "add", "-A"); git(root, "commit", "-q", "-m", "feat: first");
  git(root, "tag", "-a", "v1.0.0", "-m", "R 1.0.0");
  subjects.forEach((s, i) => { writeFileSync(join(root, `f${i}`), s); git(root, "add", "-A"); git(root, "commit", "-q", "-m", s); });
  write(version, changelogVersion, readme);
  git(root, "add", "-A"); git(root, "commit", "-q", "--allow-empty", "-m", releaseMsg);
  return root;
}

test("--next: a fix released as a patch passes and writes the notes with the compare link", () => {
  const root = repo(["fix(api): y"], "1.0.1");
  const notes = join(root, "notes.md");
  const r = check(root, ["--next", ...VF, "--notes", notes]);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /^last: v1\.0\.0$/m);
  assert.match(r.stdout, /^next: v1\.0\.1$/m);
  assert.match(r.stdout, /computed bump: patch/);
  assert.equal(readFileSync(notes, "utf8"), "- Change for 1.0.1.\n\n**Full changelog**: https://github.com/o/r/compare/v1.0.0...v1.0.1\n");
});

test("--next: the declared version must cover the bump the commits need", () => {
  assert.match(check(repo(["feat: x"], "1.0.1"), ["--next", ...VF]).stdout, /^gap: v1\.0\.1 is a patch bump but the changes since v1\.0\.0 need minor$/m);
  assert.match(check(repo(["fix: x", "refactor!: y"], "1.1.0"), ["--next", ...VF]).stdout, /need major/);
  const body = repo(["fix: x\n\nBREAKING CHANGE: the flag is gone"], "2.0.0");
  assert.equal(check(body, ["--next", ...VF]).status, 0, "BREAKING CHANGE in the body is a major");
  assert.equal(check(repo(["feat: x"], "1.1.0"), ["--next", ...VF]).status, 0);
  assert.match(check(repo(["feat: x"], "1.0.0"), ["--next", ...VF]).stdout, /^gap: version files declare v1\.0\.0, not above v1\.0\.0/m);
});

test("--next: 0.y.z takes a breaking change as a minor", () => {
  const root = repo(["feat!: x"], "1.0.0");
  git(root, "tag", "-a", "v0.4.0", "-m", "old", "HEAD~2");
  git(root, "tag", "-d", "v1.0.0");
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "0.5.0" }));
  writeFileSync(join(root, "README.md"), "Version: 0.5.0\n");
  writeFileSync(join(root, "CHANGELOG.md"), "## 0.5.0\n- x\n");
  git(root, "add", "-A"); git(root, "commit", "-q", "-m", "chore: release 0.5.0");
  const r = check(root, ["--next", ...VF]);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /computed bump: major \(minor while 0\.y\.z\)/);
});

test("--next: disagreeing version files, a changelog behind, an existing tag are gaps", () => {
  assert.match(check(repo(["fix: x"], "1.0.1", { readme: "1.0.2" }), ["--next", ...VF]).stdout, /^gap: version files disagree: package\.json v1\.0\.1, README\.md v1\.0\.2$/m);
  assert.match(check(repo(["fix: x"], "1.0.1", { changelogVersion: "1.0.0" }), ["--next", ...VF]).stdout, /^gap: changelog top section is v1\.0\.0, the release is v1\.0\.1$/m);
  const root = repo(["fix: x"], "1.0.1");
  git(root, "tag", "-a", "v1.0.1", "-m", "x", "HEAD~1");
  assert.match(check(root, ["--next", ...VF]).stdout, /^gap: tag v1\.0\.1 already exists/m);
  assert.match(check(root, ["--next", "--version-files", "nope.json"]).stdout, /^gap: version file nope\.json does not exist$/m);
});

test("--next: no Conventional Commits warns and takes the declared version; --bump computes without version files", () => {
  const r = check(repo(["Add the thing"], "1.3.0", { releaseMsg: "Release 1.3.0" }), ["--next", ...VF]);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /^next: v1\.3\.0$/m);
  assert.match(r.stdout, /^warn: no Conventional Commit types since v1\.0\.0: bump not derived from the commits, v1\.3\.0 taken from the version files$/m);
  const plain = repo(["Add the thing"], "1.0.0");
  const b = check(plain, ["--next", "--bump", "minor"]);
  assert.match(b.stdout, /^next: v1\.1\.0$/m);
  assert.match(b.stdout, /^warn: no version files/m);
  assert.equal(check(plain, ["--next", "--bump", "huge"]).status, 64);
});

test("--next reads version_files and changelog from the profile", () => {
  const root = repo(["fix: x"], "1.0.1");
  mkdirSync(join(root, ".agents"));
  writeFileSync(join(root, ".agents", "project.md"), "```yaml orbit-profile\nversion_files: [package.json, README.md]\nchangelog: CHANGELOG.md\n```\n");
  const r = check(root, ["--next"]);
  assert.equal(r.status, 0, r.stdout);
  assert.doesNotMatch(r.stdout, /warn: no version files/);
});

// --repo with a stubbed gh: STUB maps "api <path>" and "repo view" to {status, json}.
const stub = join(mkdtempSync(join(tmpdir(), "gh-")), "gh.mjs");
writeFileSync(stub, `const a = process.argv.slice(2), m = JSON.parse(process.env.STUB);
const k = a[0] === "api" ? "api " + a[a.length - 1] : a.slice(0, 2).join(" ");
const r = m[k] ?? { status: 404 };
if (r.status === 200) { process.stdout.write(JSON.stringify(r.json)); process.exit(0); }
process.stderr.write("gh: error (HTTP " + r.status + ")"); process.exit(1);
`);
const S = "repos/o/r";
const good = {
  "repo view": { status: 200, json: { nameWithOwner: "o/r" } },
  [`api ${S}`]: { status: 200, json: { default_branch: "main" } },
  [`api ${S}/rules/branches/main`]: { status: 200, json: [{ type: "required_status_checks" }, { type: "non_fast_forward" }, { type: "deletion" }] },
  [`api ${S}/rulesets?includes_parents=true`]: { status: 200, json: [{ id: 7, target: "tag", enforcement: "active" }, { id: 8, target: "branch", enforcement: "active" }] },
  [`api ${S}/rulesets/7`]: { status: 200, json: { conditions: { ref_name: { include: ["refs/tags/v*"] } }, rules: [{ type: "update" }, { type: "deletion" }] } },
  [`api ${S}/immutable-releases`]: { status: 200, json: { enabled: true } },
};
function repoRoot(signed = true, workflow = "on:\n  push:\n    branches: [main]\n") {
  const root = mkdtempSync(join(tmpdir(), "relr-"));
  git(root, "init", "-q");
  if (signed) { git(root, "config", "tag.gpgSign", "true"); git(root, "config", "user.signingkey", "key.pub"); }
  if (workflow) { mkdirSync(join(root, ".github", "workflows"), { recursive: true }); writeFileSync(join(root, ".github", "workflows", "ci.yml"), workflow); }
  return root;
}
const repoCheck = (root, map) => check(root, ["--repo"], { ORBIT_GH_STUB: stub, STUB: JSON.stringify(map) });

test("--repo: a guarded repository has no gap", () => {
  const r = repoCheck(repoRoot(), good);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /^repo: o\/r base: main$/m);
});

test("--repo: every missing guard rail is a gap with a fix", () => {
  const r = repoCheck(repoRoot(false, null), { "repo view": good["repo view"], [`api ${S}`]: good[`api ${S}`], [`api ${S}/immutable-releases`]: { status: 200, json: { enabled: false } }, [`api ${S}/rulesets?includes_parents=true`]: { status: 200, json: [] } });
  assert.equal(r.status, 1);
  for (const g of ["base main has no required status checks", "base main allows force pushes", "base main can be deleted", "no active tag ruleset", "immutable releases are off", "no CI workflow", "tags are not signed"]) assert.match(r.stdout, new RegExp(`^gap: ${g}.*\\n  fix: `, "m"), g);
  assert.match(r.stdout, /fix: gh api -X PUT repos\/o\/r\/immutable-releases/);
});

test("--repo: a disabled or narrow tag ruleset does not count; classic protection does", () => {
  const off = { ...good, [`api ${S}/rulesets?includes_parents=true`]: { status: 200, json: [{ id: 7, target: "tag", enforcement: "evaluate" }] } };
  assert.match(repoCheck(repoRoot(), off).stdout, /^gap: no active tag ruleset/m);
  const narrow = { ...good, [`api ${S}/rulesets/7`]: { status: 200, json: { conditions: { ref_name: { include: ["refs/tags/v*"] } }, rules: [{ type: "deletion" }] } } };
  assert.match(repoCheck(repoRoot(), narrow).stdout, /^gap: no active tag ruleset/m);
  const classic = { ...good, [`api ${S}/rules/branches/main`]: { status: 200, json: [] }, [`api ${S}/branches/main/protection`]: { status: 200, json: { required_status_checks: { contexts: ["test"] }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } } } };
  assert.equal(repoCheck(repoRoot(), classic).status, 0, repoCheck(repoRoot(), classic).stdout);
});

test("--repo: release_via ci needs a workflow that runs on tags; an unreadable setting warns", () => {
  const root = repoRoot();
  mkdirSync(join(root, ".agents"));
  writeFileSync(join(root, ".agents", "project.md"), "```yaml orbit-profile\nbase_branch: main\nrelease_via: ci\n```\n");
  assert.match(repoCheck(root, good).stdout, /^gap: release_via is ci but no workflow runs on tag pushes/m);
  writeFileSync(join(root, ".github", "workflows", "release.yml"), "on:\n  push:\n    tags: ['v*']\n");
  assert.equal(repoCheck(root, good).status, 0);
  const r = repoCheck(root, { ...good, [`api ${S}/immutable-releases`]: { status: 403 }, [`api ${S}/branches/main/protection`]: { status: 403 } });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /^warn: cannot read the immutable releases setting/m);
  assert.match(r.stdout, /^warn: cannot read classic branch protection/m);
});

test("usage errors exit 64; gh failing exits 70", () => {
  assert.equal(check(".", []).status, 64);
  assert.equal(check(".", ["--repo", "--next"]).status, 64);
  assert.equal(repoCheck(repoRoot(), {}).status, 70);
});

test("review fixes: post-tag notes, only Conventional Commit types count, case-insensitive", () => {
  const root = repo(["fix: x"], "1.0.1");
  git(root, "tag", "-a", "v1.0.1", "-m", "R 1.0.1");
  const notes = join(root, "n.md");
  const r = check(root, ["--next", ...VF, "--notes", notes]);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /^last: v1\.0\.0$/m);
  assert.match(r.stdout, /^tagged: v1\.0\.1 is at HEAD/m);
  assert.match(readFileSync(notes, "utf8"), /compare\/v1\.0\.0\.\.\.v1\.0\.1/);
  const area = check(repo(["parser: add streaming mode", "Feat: new API"], "1.0.0", { releaseMsg: "Release" }), ["--next"]);
  assert.match(area.stdout, /conventional: 1, computed bump: minor/);
  assert.match(area.stdout, /^next: v1\.1\.0$/m);
  const none = check(mkdtempSync(join(tmpdir(), "rel0-")), ["--next"]);
  assert.equal(none.status, 70);
});

test("review fixes: tag ruleset excludes, tags keys outside the push trigger, boolean gpgSign spellings", () => {
  const excl = { ...good, [`api ${S}/rulesets/7`]: { status: 200, json: { conditions: { ref_name: { include: ["~ALL"], exclude: ["refs/tags/v*"] } }, rules: [{ type: "update" }, { type: "deletion" }] } } };
  assert.match(repoCheck(repoRoot(), excl).stdout, /^gap: no active tag ruleset/m);
  const v1 = { ...good, [`api ${S}/rulesets/7`]: { status: 200, json: { conditions: { ref_name: { include: ["refs/tags/v1*"] } }, rules: [{ type: "update" }, { type: "deletion" }] } } };
  assert.match(repoCheck(repoRoot(), v1).stdout, /^gap: no active tag ruleset/m);
  const root = repoRoot(true, "on:\n  push:\n    branches: [main]\njobs:\n  x:\n    steps:\n      - uses: docker/metadata-action@v5\n        with:\n          tags: type=semver\n");
  mkdirSync(join(root, ".agents"));
  writeFileSync(join(root, ".agents", "project.md"), "```yaml orbit-profile\nbase_branch: main\nrelease_via: ci\n```\n");
  assert.match(repoCheck(root, good).stdout, /^gap: release_via is ci but no workflow runs on tag pushes/m);
  writeFileSync(join(root, ".github", "workflows", "r.yml"), "on:\n  push: { tags: ['v*'] }\n");
  assert.equal(repoCheck(root, good).status, 0);
  const yes = repoRoot(false);
  git(yes, "config", "tag.gpgSign", "yes"); git(yes, "config", "user.signingkey", "k");
  assert.equal(repoCheck(yes, good).status, 0, repoCheck(yes, good).stdout);
});
