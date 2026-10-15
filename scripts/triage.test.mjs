import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "decide-triage.mjs");
const git = (cwd, ...a) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" });
const profile = `\`\`\`yaml orbit-profile
base_branch: main
security_paths: [Makefile, ".github/workflows/", "scripts/check-*", "auth/**"]
review_trailer: Reviewed-by
labels: [bug]
issue_tracker: github
base_pusher: agent
ci_policy: ci-only
production_env: none
\`\`\`
`;
function repo(changed) {
  const root = mkdtempSync(join(tmpdir(), "tri-"));
  git(root, "init", "-q", "-b", "main");
  mkdirSync(join(root, ".agents"));
  writeFileSync(join(root, ".agents/project.md"), profile);
  writeFileSync(join(root, "README.md"), "x");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  git(root, "checkout", "-q", "-b", "topic");
  for (const f of changed) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), "y");
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "work");
  return root;
}
const run = (root, ...a) => spawnSync("node", [script, "--root", root, "--base", "main", "--branch", "topic", ...a], { encoding: "utf8" });
const get = (out, k) => out.split("\n").find((l) => l.startsWith(k + ":"))?.slice(k.length + 1).trim();

test("a branch touching a security glob forces security=yes, full review, opus coder", () => {
  const r = run(repo(["docs/a.md", ".github/workflows/ci.yml"]), "--lines", "sec=no,door=no,prod=no");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(get(r.stdout, "security"), "yes (forced: .github/workflows/ci.yml)");
  assert.equal(get(r.stdout, "track"), "full review");
  assert.equal(get(r.stdout, "coder model"), "opus");
  assert.equal(get(r.stdout, "max calls"), "5");
  assert.match(get(r.stdout, "caps"), /engineer 1-2/);
});

test("glob forms: *, **, plain file, and no match", () => {
  for (const f of ["scripts/check-x.sh", "auth/deep/er/f.go", "Makefile"]) {
    assert.match(get(run(repo([f]), "--lines", "sec=no,door=no,prod=no").stdout, "security"), /^yes/, f);
  }
  const r = run(repo(["scripts/other.sh", "sub/Makefile"]), "--lines", "sec=no,door=no,prod=no", "--kind", "small");
  assert.equal(get(r.stdout, "security"), "no");
  assert.equal(get(r.stdout, "track"), "just do it");
  assert.equal(get(r.stdout, "coder model"), "sonnet");
});

test("all no: --kind picks light review for a design question", () => {
  const r = run(repo(["docs/a.md"]), "--lines", "sec=no,door=no,prod=no", "--kind", "design");
  assert.equal(get(r.stdout, "track"), "light review");
  assert.equal(get(r.stdout, "max calls"), "3");
});

test("door=yes is a full review even when security is no", () => {
  const r = run(repo(["docs/a.md"]), "--lines", "sec=no,door=yes,prod=no");
  assert.equal(get(r.stdout, "track"), "full review");
});

test("incident kind wins; an unset line with all else no is a triage gap, exit 2", () => {
  assert.equal(get(run(repo(["a.md"]), "--lines", "sec=no,door=no,prod=no", "--kind", "incident").stdout, "track"), "incident");
  const g = run(repo(["a.md"]), "--lines", "sec=no", "--kind", "small");
  assert.equal(g.status, 2);
  assert.match(g.stdout, /triage gap: door/);
  const k = run(repo(["a.md"]), "--lines", "sec=no,door=no,prod=no");
  assert.equal(k.status, 2);
  assert.match(k.stdout, /triage gap: kind/);
});

test("prod line is skipped when the profile has no production environment", () => {
  const r = run(repo(["a.md"]), "--lines", "sec=no,door=no", "--kind", "small");
  assert.equal(r.status, 0, r.stdout);
});

test("a rename out of a security path counts (both paths), and odd file names do not break parsing", () => {
  const root = mkdtempSync(join(tmpdir(), "tri-"));
  git(root, "init", "-q", "-b", "main");
  mkdirSync(join(root, ".agents"));
  writeFileSync(join(root, ".agents/project.md"), profile);
  mkdirSync(join(root, "auth"));
  writeFileSync(join(root, "auth/secret.go"), "package auth // some content that is long enough to be detected as a rename\n".repeat(5));
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  git(root, "checkout", "-q", "-b", "topic");
  git(root, "mv", "auth/secret.go", "moved.go");
  writeFileSync(join(root, "café \"q\".md"), "z");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "mv");
  const r = run(root, "--lines", "sec=no,door=no,prod=no");
  assert.match(get(r.stdout, "security"), /^yes \(forced: auth\/secret\.go\)/);
});

test("three-dot diff: a security change that landed on the base after the branch point is not the branch's", () => {
  const root = repo(["docs/a.md"]);
  git(root, "checkout", "-q", "main");
  writeFileSync(join(root, "Makefile"), "all:\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base moved");
  const r = run(root, "--lines", "sec=no,door=no,prod=no", "--kind", "small");
  assert.equal(get(r.stdout, "security"), "no");
});

test("an unfilled template (TODO list) is a profile gap, exit 1", () => {
  const root = repo(["a.md"]);
  writeFileSync(join(root, ".agents/project.md"), profile.replace('[Makefile, ".github/workflows/", "scripts/check-*", "auth/**"]', "[TODO]"));
  const r = run(root, "--lines", "sec=no,door=no,prod=no", "--kind", "small");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /profile gap: security_paths/);
});

test("unknown --kind is rejected with exit 64; incident picks the opus coder", () => {
  assert.equal(run(repo(["a.md"]), "--lines", "sec=no,door=no,prod=no", "--kind", "smal").status, 64);
  const r = run(repo(["a.md"]), "--lines", "sec=no,door=no,prod=no", "--kind", "incident");
  assert.equal(get(r.stdout, "coder model"), "opus");
});

test("production_env: TODO needs prod= (a triage gap), none or absent skips it", () => {
  const root = repo(["a.md"]);
  writeFileSync(join(root, ".agents/project.md"), profile.replace("production_env: none", "production_env: TODO"));
  const g = run(root, "--lines", "sec=no,door=no", "--kind", "small");
  assert.equal(g.status, 2);
  assert.match(g.stdout, /triage gap: prod/);
  assert.equal(run(root, "--lines", "sec=no,door=no,prod=no", "--kind", "small").status, 0);
});

test("a ref that looks like an option is rejected before git runs: no file is written", () => {
  const root = repo(["a.md"]);
  const out = join(root, "pwned.txt");
  const r = spawnSync("node", [script, "--root", root, "--base", `--output=${out}`, "--branch", "topic", "--lines", "sec=no,door=no,prod=no", "--kind", "small"], { encoding: "utf8" });
  assert.equal(r.status, 64);
  assert.equal(existsSync(out), false);
  const r2 = spawnSync("node", [script, "--root", root, "--base", "main", "--branch", `--output=${out}`, "--lines", "sec=no,door=no,prod=no", "--kind", "small"], { encoding: "utf8" });
  assert.equal(r2.status, 64);
  assert.equal(existsSync(out), false);
});

test("a forced security yes does not hide unset door or prod lines: they stay triage gaps", () => {
  const r = run(repo([".github/workflows/ci.yml"]), "--lines", "sec=no");
  assert.equal(r.status, 2);
  assert.match(r.stdout, /triage gap: door/);
  assert.doesNotMatch(r.stdout, /triage gap: sec/);
});

test("--files triages planned paths with no git branch", () => {
  const root = repo(["a.md"]);
  const r = spawnSync("node", [script, "--root", root, "--files", "docs/x.md,Makefile", "--lines", "sec=no,door=no,prod=no"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(get(r.stdout, "security"), /^yes \(forced: Makefile\)/);
  assert.equal(get(r.stdout, "track"), "full review");
});

test("a git failure has its own exit code (70) and a one-line message", () => {
  const r = run(repo(["a.md"]), "--lines", "sec=no,door=no,prod=no", "--kind", "small");
  assert.equal(r.status, 0);
  const bad = spawnSync("node", [script, "--root", repo(["a.md"]), "--base", "nope", "--branch", "topic", "--lines", "sec=no,door=no,prod=no", "--kind", "small"], { encoding: "utf8" });
  assert.equal(bad.status, 70);
  assert.match(bad.stderr, /^decide-triage: git diff failed/);
});

test("a profile with base_pusher: operator (legacy alias of agent) triages like agent", () => {
  const root = repo(["docs/a.md"]);
  writeFileSync(join(root, ".agents/project.md"), profile.replace("base_pusher: agent", "base_pusher: operator"));
  const r = run(root, "--lines", "sec=no,door=no,prod=no", "--kind", "small");
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /profile gap/);
  assert.equal(get(r.stdout, "track"), "just do it");
});
