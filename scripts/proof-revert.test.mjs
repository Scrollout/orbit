import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sh = (cwd, cmd) => { const r = spawnSync("sh", ["-c", cmd], { cwd, encoding: "utf8" }); assert.equal(r.status, 0, `${cmd}\n${r.stderr}`); return r.stdout; };
const helper = (args) => spawnSync("node", [join(here, "proof-revert.mjs"), ...args], { encoding: "utf8" });

// A throwaway repo: main has the base files; the topic branch modifies, adds, deletes, renames production files and tests.
function repo() {
  const root = mkdtempSync(join(tmpdir(), "prv-"));
  const w = (p, s) => { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), s); };
  sh(root, "git init -q -b main . && git config user.email t@example.invalid && git config user.name t && git config commit.gpgsign false");
  w("src/a.go", "a1\n"); w("src/del.go", "del\n"); w("src/old name.go", "old\nold\nold\n"); w("src/a_test.go", "t1\nx\nx\nx\n"); w("keep.md", "k\n");
  sh(root, "git add -A && git commit -qm base");
  sh(root, "git checkout -qb topic");
  w("src/a.go", "a2\n"); w("src/new.go", "new\n"); w("src/a_test.go", "t2\nx\nx\nx\n"); w("src/n_test.go", "n\n");
  sh(root, "git rm -q src/del.go && git mv 'src/old name.go' src/renamed.go");
  sh(root, "git add -A && git commit -qm topic");
  sh(root, "git checkout -q main");
  w("later.md", "on main after the fork\n");
  sh(root, "git add -A && git commit -qm later");
  return root;
}

test("the printed commands revert only the production part, on the merge-base, in the scratch worktree", () => {
  const root = repo();
  const head = sh(root, "git rev-parse topic").trim(), mb = sh(root, "git merge-base main topic").trim();
  const wt = mkdtempSync(join(tmpdir(), "prv-wt-"));
  sh(root, `git worktree add -q --detach '${wt}' ${head}`);
  const r = helper(["--repo", root, "--base", "main", "--head", head, "--worktree", wt, "--keep", "src/a_test.go", "--keep", "src/n_test.go"]);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines[0], `# merge-base ${mb}`, "three-dot: main's later commit is not part of the diff");
  assert.doesNotMatch(r.stdout, /later\.md|a_test|n_test/);
  sh(wt, r.stdout);
  const read = (p) => (existsSync(join(wt, p)) ? readFileSync(join(wt, p), "utf8") : null);
  assert.equal(read("src/a.go"), "a1\n", "modified: restored");
  assert.equal(read("src/new.go"), null, "added: removed");
  assert.equal(read("src/del.go"), "del\n", "deleted: restored");
  assert.equal(read("src/renamed.go"), null, "renamed: new path removed");
  assert.equal(read("src/old name.go"), "old\nold\nold\n", "renamed: old path restored (a path with a space)");
  assert.equal(read("src/a_test.go"), "t2\nx\nx\nx\n", "kept test as at head");
  assert.equal(read("src/n_test.go"), "n\n", "kept new test as at head");
  // cleanup as the reviewers do it: undo the revert, then a plain remove (no --force)
  sh(wt, "git reset -q --hard");
  sh(root, `git worktree remove '${wt}'`);
  assert.ok(!existsSync(wt));
  rmSync(root, { recursive: true, force: true });
});

test("a kept renamed test stays as at head; bad usage is 64, a git failure 70", () => {
  const root = repo();
  sh(root, "git checkout -q topic && git mv src/a_test.go src/b_test.go && git commit -qm mv && git checkout -q main");
  const r = helper(["--repo", root, "--base", "main", "--head", "topic", "--worktree", "/wt", "--keep", "src/b_test.go", "--keep", "src/n_test.go"]);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /a_test|b_test/);
  assert.match(r.stdout, /^git -C '\/wt' rm -q -- 'src\/new\.go'$/m);
  assert.equal(helper(["--base", "main", "--head", "topic"]).status, 64);
  assert.equal(helper(["--repo", root, "--base", "main", "--head", "nosuchref", "--worktree", "/wt"]).status, 70);
  rmSync(root, { recursive: true, force: true });
});

test("a changed path with a newline is refused with a clear message", () => {
  const root = repo();
  sh(root, "git checkout -q topic && printf x > \"$(printf 'src/odd\\nname.go')\" && git add -A && git commit -qm odd && git checkout -q main");
  const r = helper(["--repo", root, "--base", "main", "--head", "topic", "--worktree", "/wt"]);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /path with a newline: "src\/odd\\nname\.go"; revert it by hand/);
  rmSync(root, { recursive: true, force: true });
});
