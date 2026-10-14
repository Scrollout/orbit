import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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
