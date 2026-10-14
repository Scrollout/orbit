import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { guard, isOperator, parseShell } from "../hooks/guard.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = { HOME: "/home/u", TMPDIR: "/tmp/scratch" };
const files = {
  "/r/main/msg-ok.txt": "Merge branch 'topic'\n\nBody.\n\nReviewed-By: reviewer (opus) - comment 1 on issue #2\nCo-Authored-By: A <a@example.com>\n",
  "/r/main/msg-bad.txt": "Merge branch 'topic'\n\nReviewed-By: reviewer (opus) - comment 1 on issue #2\n\nCo-Authored-By: A <a@example.com>\n",
};
const ctx = (over = {}) => ({
  roots: ["/r/main", "/r/main-topic"],
  operatorFiles: ["/r/main/.agents/operator.md"],
  profile: () => ({ base: "main", pusher: "owner", trailer: "Reviewed-By" }),
  mergeHead: () => null,
  baseShas: () => [],
  readFile: (f) => files[f] ?? null,
  ...over,
});
const op = { agent_type: "orbit:operator", cwd: "/r/main" };
const bash = (command, who = op) => ({ ...who, tool_name: "Bash", tool_input: { command } });
const run = (input, c = ctx()) => guard(input, env, c);

const ALLOWED = [
  "git status",
  "git log --oneline -5 origin/main",
  "git diff main...topic --stat",
  "git show HEAD --format=%H -s",
  "git fetch origin",
  "git fetch --prune origin",
  "git rev-parse HEAD^{tree} topic^{tree}",
  "git ls-remote origin",
  "git worktree list",
  "git -C /r/main-topic log -1",
  "git branch",
  "git branch -a --contains abc123",
  "git branch --show-current",
  "git --no-pager log -1",
  "git remote -v",
  "git config --get user.name",
  "git tag --list",
  "gh issue list --label bug",
  "gh issue comment 3 --body-file /tmp/scratch/body.md",
  "gh pr view 4 --json state",
  "gh run list --branch topic",
  "gh run watch 123 --exit-status > /tmp/scratch/watch.log 2>&1",
  "ls -la && cat README.md | head -5",
  "node scripts/ledger.mjs --session s ci_run branch=t sha=abc state=green",
  "git status 2>/dev/null || true",
  "echo hi > $TMPDIR/x.log",
  "cat <<'EOF' > /tmp/scratch/body.md\nReview summary\nEOF",
  "cat >> .agents/operator.md <<'EOF'\n- note\nEOF",
  "sed -n '1,20p' README.md",
  "cp README.md /tmp/scratch/",
  "git push origin HEAD:main",
  "git -C /r/main-merge push origin HEAD:main",
  "grep -rn 'git commit' docs/ | head",
  "for f in a b; do echo $f; done",
  "echo $(git rev-parse HEAD)",
];

const DENIED = [
  ["git commit -m 'x'", "OPR-01"],
  ["git merge --no-ff topic", "OPR-01"],
  ["git rebase origin/main", "OPR-01"],
  ["git reset --hard origin/main", "OPR-01"],
  ["git checkout topic", "OPR-01"],
  ["git switch -c topic", "OPR-01"],
  ["git branch -D topic", "OPR-01"],
  ["git branch new-topic", "OPR-01"],
  ["git worktree add -b t ../r-t origin/main", "OPR-01"],
  ["git worktree remove ../r-t", "OPR-01"],
  ["git cherry-pick abc", "OPR-01"],
  ["git stash", "OPR-01"],
  ["git stash pop", "OPR-01"],
  ["git tag v1", "OPR-01"],
  ["git add .", "OPR-01"],
  ["git push origin topic", "OPR-01"],
  ["git push origin HEAD:main --force", "OPR-01"],
  ["git push --delete origin topic", "OPR-01"],
  ["git merge --no-ff topic && git push origin HEAD:main", "OPR-01"],
  ["git fetch && git push origin HEAD:main", "OPR-03"],
  ["git -c core.hooksPath=/dev/null status", "OPR-01"],
  ["git $SUB", "OPR-01"],
  ["echo $(git commit -m x)", "OPR-01"],
  ["bash -c 'git commit -m x'", "OPR-01"],
  ["eval git merge topic", "OPR-01"],
  ["env FOO=1 git commit -m x", "OPR-01"],
  ["if true; then git commit -m x; fi", "OPR-01"],
  ["echo x > README.md", "OPR-01"],
  ["echo x >> /r/main-topic/notes.md", "OPR-01"],
  ["printf x | tee docs/a.md", "OPR-01"],
  ["sed -i 's/a/b/' README.md", "OPR-01"],
  ["mv /tmp/scratch/a README.md", "OPR-01"],
  ["cp /tmp/scratch/a .", "OPR-01"],
  ["rm -f README.md", "OPR-01"],
  ["cd /tmp && cd /r/main && touch x", "OPR-01"],
  ["echo x > $UNSET_VAR/x", "OPR-01"],
  ["ls | xargs rm", "OPR-01"],
  ["gh pr merge 4", "OPR-01"],
  ["$CMD --flag", "OPR-01"],
  ["echo 'unclosed", "OPR-01"],
  ["(cd /tmp) && rm x", "OPR-01"],
];

test("operator: the allowed table passes", () => {
  for (const c of ALLOWED) assert.equal(run(bash(c)), null, c);
});

test("operator: every denied case is denied and names its rule id", () => {
  for (const [c, id] of DENIED) {
    const r = run(bash(c));
    assert.ok(r, `not denied: ${c}`);
    assert.ok(r.includes(id), `${c}: ${r}`);
    assert.match(r, /OPR-01/, `${c}: every operator deny names OPR-01`);
  }
  assert.ok(ALLOWED.length + DENIED.length >= 30);
});

test("operator: the base push needs a base_pusher and the profile's base", () => {
  const none = ctx({ profile: () => ({ base: "main", pusher: null, trailer: "Reviewed-By" }) });
  assert.match(run(bash("git push origin HEAD:main"), none), /OPR-01.*base_pusher/);
  assert.match(run(bash("git push origin HEAD:main"), ctx({ profile: () => null })), /OPR-01/);
  assert.match(run(bash("git push origin HEAD:develop")), /OPR-01/);
  assert.equal(run(bash("git push origin HEAD:main"), ctx({ profile: () => ({ base: "main", pusher: "agent", trailer: null }) })), null);
});

test("operator: Edit/Write/MultiEdit/NotebookEdit only on .agents/operator.md", () => {
  const edit = (tool_name, tool_input) => run({ ...op, tool_name, tool_input });
  assert.equal(edit("Write", { file_path: ".agents/operator.md" }), null);
  assert.equal(edit("Edit", { file_path: "/r/main/.agents/operator.md" }), null);
  for (const [t, i] of [["Write", { file_path: "README.md" }], ["Edit", { file_path: "/r/main-topic/.agents/operator.md" }], ["MultiEdit", { file_path: "/r/main/a.md" }], ["NotebookEdit", { notebook_path: "/r/main/n.ipynb" }], ["Write", {}]]) {
    assert.match(edit(t, i) ?? "", /^OPR-01: .*worker/, `${t} ${JSON.stringify(i)}`);
  }
  assert.equal(edit("Read", { file_path: "README.md" }), null);
  assert.equal(edit("Write", { file_path: "/tmp/scratch/body.md" }), null, "outside the repo is allowed (finding 7)");
});

test("operator detection: agent_type on the main thread, or ORBIT_ROLE=operator; a subagent never is", () => {
  assert.equal(isOperator({ agent_type: "orbit:operator" }, {}), true);
  assert.equal(isOperator({ agent_type: "operator" }, {}), true);
  assert.equal(isOperator({ agent_type: "orbit:operator", agent_id: "a1" }, {}), false);
  assert.equal(isOperator({}, { ORBIT_ROLE: "operator" }), true);
  assert.equal(isOperator({ agent_id: "a1", agent_type: "orbit:coder" }, { ORBIT_ROLE: "operator" }), false);
  assert.equal(isOperator({ agent_type: "orbit:coder" }, {}), false);
  assert.equal(isOperator({}, {}), false);
});

test("non-operator sessions: OPR-01 does nothing", () => {
  const worker = { agent_id: "w1", agent_type: "orbit:coder", cwd: "/r/main-topic" };
  for (const [c] of DENIED) assert.doesNotMatch(run(bash(c, worker)) ?? "", /OPR-01/, c);
  assert.match(run(bash("git merge --no-ff topic", worker)) ?? "", /^DEC-08/, "workers still get DEC-08");
  assert.equal(run({ ...worker, tool_name: "Write", tool_input: { file_path: "README.md" } }), null);
  assert.equal(run({ cwd: "/r/main", tool_name: "Bash", tool_input: {} }), null);
});

test("DEC-08: a --no-ff merge of a topic needs the trailer in the last paragraph with Co-Authored-By", () => {
  const w = { agent_id: "w1", agent_type: "orbit:coder", cwd: "/r/main" };
  const heredoc = (body) => `git merge --no-ff topic -m "$(cat <<'EOF'\n${body}\nEOF\n)"`;
  const ok = [
    "git merge --no-ff -F msg-ok.txt topic",
    "git merge --no-ff --file=/r/main/msg-ok.txt topic",
    heredoc("Merge topic\n\nReviewed-By: reviewer (opus) - PR #4\nCo-Authored-By: A <a@example.com>"),
    "git merge --no-ff -m 'Merge topic' -m 'Reviewed-By: owner waived - docs-only\nCo-Authored-By: A <a@example.com>' topic",
    "git merge --no-ff -m 'catch-up' origin/main",
    "git merge -m 'no trailer, fast-forward allowed' topic",
    "git merge --abort",
    "git commit -m 'plain commit, no merge in progress'",
  ];
  for (const c of ok) assert.equal(run(bash(c, w)), null, c);
  const bad = [
    "git merge --no-ff -F msg-bad.txt topic",
    "git merge --no-ff -m 'Merge topic' topic",
    heredoc("Merge topic\n\nCo-Authored-By: A <a@example.com>"),
    "git merge --no-ff -m \"$MSG\" topic",
    "git merge --no-ff -F missing.txt topic",
    "cd /r/main && git merge --no-ff -m 'x' topic",
    "git merge --no-ff topic",
    "git merge --no-ff --no-edit topic",
    "git merge --no-ff -qm 'Merge topic' topic",
  ];
  for (const c of bad) assert.match(run(bash(c, w)) ?? "", /^DEC-08: /, c);
  const merging = ctx({ mergeHead: () => "abc", baseShas: () => ["def"] });
  assert.match(run(bash("git commit -m 'Merge topic'", w), merging) ?? "", /^DEC-08/);
  assert.equal(run(bash("git commit -F msg-ok.txt", w), merging), null);
  assert.equal(run(bash("git commit -m 'catch-up'", w), ctx({ mergeHead: () => "abc", baseShas: () => ["abc"] })), null);
  assert.equal(run(bash("git merge --no-ff -m 'x' topic", w), ctx({ profile: () => ({ base: "main", pusher: "owner", trailer: null }) })), null);
  assert.equal(run(bash("git merge --no-ff -m 'x' topic", w), ctx({ profile: () => null })), null);
});

test("the parser keeps heredoc bodies out of the command list and finds nested commands", () => {
  const cmds = parseShell("cat <<'EOF' | wc -l\ngit commit -m x\nEOF\necho `git log` $(git status)", env);
  const names = cmds.map((c) => c.words[0]?.lit);
  assert.deepEqual(names.sort(), ["cat", "echo", "git", "git", "wc"]);
  assert.equal(cmds.find((c) => c.heredoc !== null).heredoc, "git commit -m x\n");
});

test("the hook script: deny JSON for the operator, silence otherwise, fail closed only for the operator", () => {
  const root = mkdtempSync(join(tmpdir(), "guard-"));
  try {
    mkdirSync(join(root, ".agents"));
    writeFileSync(join(root, ".agents/project.md"), "```yaml orbit-profile\nbase_branch: main\nreview_trailer: Reviewed-By\nbase_pusher: owner\n```\n");
    spawnSync("git", ["init", "-q", "-b", "main", root]);
    const hook = (input, extra = {}) => spawnSync("node", [join(repo, "hooks/guard.mjs")], { input, encoding: "utf8", env: { ...process.env, ORBIT_ROLE: "", CLAUDE_PROJECT_DIR: root, ...extra } });
    const ev = (o) => JSON.stringify({ hook_event_name: "PreToolUse", cwd: root, ...o });
    let r = hook(ev({ agent_type: "orbit:operator", tool_name: "Bash", tool_input: { command: "git commit -m x" } }));
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, "deny");
    assert.match(out.permissionDecisionReason, /^OPR-01/);
    r = hook(ev({ tool_name: "Bash", tool_input: { command: "git commit -m x" } }));
    assert.equal(r.status, 0); assert.equal(r.stdout, "");
    r = hook(ev({ tool_name: "Bash", tool_input: { command: "git merge --no-ff -m 'x' topic" } }));
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, /^DEC-08/);
    r = hook(ev({ agent_type: "orbit:operator", tool_name: "Write", tool_input: { file_path: join(root, ".agents/operator.md") } }));
    assert.equal(r.stdout, "");
    r = hook("not json");
    assert.equal(r.status, 0); assert.equal(r.stdout, "");
    r = hook("not json", { ORBIT_ROLE: "operator" });
    assert.equal(r.status, 2); assert.match(r.stderr, /OPR-01/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("hooks.json registers the guard as a PreToolUse hook for Bash and the edit tools", async () => {
  const { readFileSync } = await import("node:fs");
  const h = JSON.parse(readFileSync(join(repo, "hooks/hooks.json"), "utf8")).hooks.PreToolUse;
  const g = h.find((e) => e.hooks.some((x) => x.command.includes("hooks/guard")));
  assert.ok(g, "guard registered");
  for (const t of ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit"]) assert.ok(g.matcher.split("|").includes(t), t);
});

// ---------- fix round 1 ----------
const deniedOp = (c, c2 = ctx()) => { const r = run(bash(c), c2); assert.match(r ?? "", /^OPR-01: /, `not denied: ${c}`); return r; };
const allowedOp = (c, c2 = ctx()) => assert.equal(run(bash(c), c2), null, c);

test("finding 1: read-only git subcommands with options that write or run code are denied", () => {
  for (const c of [
    "git fetch --upload-pack='touch x' origin", "git ls-remote --upload-pack=evil origin", "git ls-remote -u evil origin",
    "git log --exec=x", "git grep -O foo", "git grep --open-files-in-pager=vi foo", "git diff --output=README.md",
    "git log --output-file x", "git -c alias.x=y status", "git fetch origin main:main", "git fetch origin +refs/heads/*:refs/remotes/x/*",
    "git ls-remote origin a:b", "git config user.name x", "git config --global user.name x", "git config --add a.b c",
    "git config --get a.b --unset", "git config --unset a.b", "git config -e", "git config set a.b c",
    "git remote add x y", "git remote set-url origin y", "git remote remove origin", "git remote prune origin",
    "git reflog expire --all", "git reflog delete HEAD@{1}", "git reflog drop",
  ]) deniedOp(c);
  for (const c of [
    "git fetch origin main", "git fetch https://example.com/x.git main", "git ls-remote https://example.com/x.git",
    "git diff --output-indicator-new=+ HEAD", "git config --get user.name", "git config --get-regexp alias", "git config --list",
    "git config -l", "git config --global --get user.name", "git remote", "git remote -v", "git remote show origin", "git remote get-url origin",
    "git reflog", "git reflog show topic", "git reflog -n 5",
  ]) allowedOp(c);
});

test("finding 2: a write target with a variable assigned in the command is denied; mktemp dirs are safe", () => {
  for (const c of [
    "D=/r/main; echo x > $D/a", "export D=/r/main && echo x > \"$D/a\"", "declare D=/r/main; touch $D/a", "read D; rm $D",
    "for D in /r/main; do echo x > $D/a; done", "TMPDIR=/r/main; echo x > $TMPDIR/x", "D=$(mktemp -d); echo x > /r/main/$D",
    "D=$(pwd); echo x > $D/a",
  ]) deniedOp(c);
  for (const c of [
    "D=$(mktemp -d); echo x > \"$D/body.md\"", "F=$(mktemp); gh issue comment 3 --body-file \"$F\" && echo x > $F",
    "D=\"$(mktemp -d)\"; cp README.md \"$D/\"", "N=3; echo $N",
  ]) allowedOp(c);
});

test("finding 3: cd - leaves the directory unknown", () => {
  deniedOp("cd /tmp && cd - && touch x");
  allowedOp("cd /tmp && touch x");
});

test("finding 4: shells, sourcing and opaque wrappers fail closed or are parsed", () => {
  for (const c of [
    "bash -c -- 'git commit -m x'", "sh script.sh", "bash <<'EOF'\ngit commit -m x\nEOF", "echo 'git commit' | sh", "bash -s",
    "source ./x.sh", ". ./x.sh", "builtin eval git commit", "env -S 'git commit -m x'", "watch git status", "script -c 'git commit' /dev/null",
    "flock /tmp/l git commit -m x", "setsid git commit -m x", "chronic git commit -m x", "stdbuf -oL git commit -m x", "ionice -c 3 git commit -m x",
  ]) deniedOp(c);
  for (const c of ["bash -c -- 'git status'", "setsid git status", "ionice -c 3 git log -1", "bash --version"]) allowedOp(c);
  assert.match(run(bash("sh script.sh")), /via a worker/);
});

test("finding 5: gh merges and ref writes are denied wherever the flags sit; reads stay allowed", () => {
  for (const c of [
    "gh pr -R o/r merge 4", "gh -R o/r pr merge 4", "gh pr --repo o/r checkout 4", "gh --repo=o/r pr merge 4 --squash",
    "gh api -X PUT repos/o/r/pulls/4/merge", "gh api --method POST repos/o/r/merges -f base=main -f head=t",
    "gh api repos/o/r/git/refs -f ref=refs/heads/x -f sha=abc", "gh api -XPATCH repos/o/r/git/refs/heads/main -f sha=abc",
    "gh api --method=DELETE repos/o/r/git/refs/heads/t", "gh api -X PUT repos/o/r/contents/README.md --input body.json",
    "gh api graphql -f query='mutation { mergePullRequest(input: {}) { clientMutationId } }'",
    "gh api graphql -f query=\"$Q\"",
  ]) deniedOp(c);
  for (const c of [
    "gh api repos/o/r/pulls/4", "gh api repos/o/r/git/refs/heads/main", "gh api -X GET repos/o/r/contents/README.md",
    "gh api repos/o/r/issues/3/comments -f body=hi", "gh api graphql -f query='query { viewer { login } }'",
    "gh pr view 4 -R o/r", "gh -R o/r pr list",
  ]) allowedOp(c);
});

test("finding 6: DEC-08 covers merges without a readable message, --continue, reuse and clustered -m", () => {
  const w = { agent_id: "w1", agent_type: "orbit:coder", cwd: "/r/main" };
  const merging = ctx({ mergeHead: () => "abc1234", baseShas: () => ["def5678"] });
  for (const c of ["git merge --continue", "git commit --no-edit", "git commit", "git commit -C HEAD", "git commit --reuse-message=HEAD", "git commit -c HEAD", "git commit -am 'Merge topic'"]) {
    assert.match(run(bash(c, w), merging) ?? "", /^DEC-08: .*-F/, c);
  }
  assert.match(run(bash("git merge --no-ff --no-commit topic && git commit --no-edit", w)) ?? "", /^DEC-08/);
  assert.equal(run(bash("git merge --no-ff --no-commit topic", w)), null);
  assert.equal(run(bash("git commit -F msg-ok.txt", w), merging), null);
  assert.equal(run(bash("git commit -qF msg-ok.txt", w), merging), null);
  assert.equal(run(bash("git merge --continue", w)), null, "no merge in progress");
  assert.equal(run(bash("git merge --no-ff -m 'x' FETCH_HEAD", w)), null);
  assert.equal(run(bash("git merge --no-ff -m 'x' def5678", w), merging), null, "a sha equal to the base tip is a catch-up");
  assert.match(run(bash("git merge --no-ff -m 'x' 0123abc", w), merging) ?? "", /^DEC-08/);
  assert.match(run(bash("git merge --no-ff -m 'catch up with main' 0123abc", w)) ?? "", /^DEC-08/, "no message-prefix exemption (round 3 D)");
  assert.match(run(bash("git merge --no-ff -m \"Merge remote-tracking branch 'origin/main' into t\" 0123abc", w)) ?? "", /^DEC-08/);
  assert.equal(run(bash("git merge abc1234", w)), null, "no --no-ff: a catch-up");
});

test("finding 7: case, functions, stash list|show and notes show are not false denies", () => {
  for (const c of [
    "case $x in a|b) git status ;; *) git log -1 ;; esac", "f() { git status; }; f", "function g { git log -1; }",
    "git stash list", "git stash show -p stash@{0}", "git notes show HEAD", "case x in (y) echo y;; esac",
  ]) allowedOp(c);
  for (const c of ["case $x in a) git commit -m x ;; esac", "f() { git commit -m x; }", "git stash drop", "git notes add -m x"]) deniedOp(c);
});

test("finding 8: common writers, script writers and symlinked targets", async () => {
  for (const c of [
    "patch -p1 < /tmp/scratch/x.diff", "rsync -a /tmp/scratch/ docs/", "dd if=/dev/zero of=README.md", "curl -o README.md https://example.com",
    "curl -sSLo x.sh https://example.com", "curl -O https://example.com/x", "tar xzf /tmp/scratch/a.tgz", "tar -xf /tmp/scratch/a.tar",
    "unlink README.md", "shred -u README.md", "chmod +x hooks/x.sh", "chown u README.md", "find . -name '*.log' -delete",
    "find docs -exec rm {} +", "find . -name x -exec sed -i s/a/b/ {} ;", "python3 -c 'open(\"x\",\"w\")'", "python -c 1",
    "node -e 'require(\"fs\").writeFileSync(\"x\",\"\")'", "perl -pi -e 's/a/b/' README.md", "ruby -e 'File.write(\"x\",\"\")'",
    "awk '{ print > \"out.txt\" }' README.md", "sed -n 'w out.txt' README.md",
  ]) deniedOp(c);
  for (const c of [
    "curl -sS https://example.com", "curl -o /tmp/scratch/x https://example.com", "tar tzf /tmp/scratch/a.tgz", "tar xzf a.tgz -C /tmp/scratch",
    "find . -name '*.md'", "find . -exec grep -l x {} +", "awk '$3 > 100 { print $1 }' data.txt", "sed -n '/word/p' README.md",
    "node scripts/ledger.mjs --session s ci_run", "chmod +x /tmp/scratch/x.sh", "rsync -a docs/ /tmp/scratch/docs/",
  ]) allowedOp(c);
  const { symlinkSync, realpathSync } = await import("node:fs");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "guard-ln-")));
  try {
    mkdirSync(join(root, "repo")); mkdirSync(join(root, "out"));
    symlinkSync(join(root, "repo"), join(root, "out/link"));
    const c = ctx({ roots: [join(root, "repo")], operatorFiles: [join(root, "repo/.agents/operator.md")] });
    const o = { ...op, cwd: join(root, "out") };
    assert.match(guard({ ...o, tool_name: "Bash", tool_input: { command: "echo x > link/a" } }, env, c) ?? "", /^OPR-01/);
    assert.match(guard({ ...o, tool_name: "Write", tool_input: { file_path: join(root, "out/link/a") } }, env, c) ?? "", /^OPR-01/);
    assert.equal(guard({ ...o, tool_name: "Write", tool_input: { file_path: join(root, "out/a") } }, env, c), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("realCtx reads review_trailer and base_pusher from the profile", async () => {
  const { realCtx } = await import("../hooks/guard.mjs");
  const root = mkdtempSync(join(tmpdir(), "guard-ctx-"));
  try {
    spawnSync("git", ["init", "-q", "-b", "main", root]);
    mkdirSync(join(root, ".agents"));
    const prof = (lines) => { writeFileSync(join(root, ".agents/project.md"), "```yaml orbit-profile\n" + lines + "\n```\n"); return realCtx(root, {}).profile(root); };
    assert.deepEqual(prof("base_branch: main\nreview_trailer: none\nbase_pusher: agent"), { base: "main", pusher: "agent", trailer: null });
    assert.deepEqual(prof("base_branch: main\nreview_trailer: Reviewed-By\nbase_pusher: owner"), { base: "main", pusher: "owner", trailer: "Reviewed-By" });
    assert.deepEqual(prof("base_branch: TODO\nreview_trailer: TODO\nbase_pusher: TODO"), { base: null, pusher: null, trailer: null });
    assert.deepEqual(prof("base_branch: main\nreview_trailer: Reviewed-By\nbase_pusher: operator"), { base: "main", pusher: null, trailer: "Reviewed-By" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the hook entry fails closed for the operator when guard() throws, and stays silent for others", async () => {
  const { hookMain } = await import("../hooks/guard.mjs");
  const boom = () => { throw new Error("boom"); };
  const o = hookMain(JSON.stringify({ agent_type: "orbit:operator", tool_name: "Bash", tool_input: { command: "ls" } }), {}, boom);
  assert.equal(o.code, 0);
  assert.match(JSON.parse(o.stdout).hookSpecificOutput.permissionDecisionReason, /^OPR-01: .*boom/);
  const w = hookMain(JSON.stringify({ agent_id: "a", tool_name: "Bash", tool_input: { command: "ls" } }), { ORBIT_ROLE: "operator" }, boom);
  assert.deepEqual(w, { code: 0, stdout: "", stderr: "" });
  assert.equal(hookMain("{", { ORBIT_ROLE: "operator" }).code, 2);
  assert.equal(hookMain("{", {}).code, 0);
});

// ---------- fix round 2 ----------
test("round 2 C: read-only git subcommands take only allowlisted options, named in the deny", () => {
  for (const [c, opt] of [
    ["git fetch --receive-pack=x origin", "--receive-pack=x"], ["git fetch --upload-p=x origin", "--upload-p=x"], ["git grep --open-files=vi x", "--open-files=vi"],
    ["git ls-remote -qu'touch x' origin", "-qutouch x"], ["git grep -nOecho x", "-nOecho"], ["git diff --outp=x", "--outp=x"], ["git log --outp x", "--outp"],
    ["git status --porcelain --fsmonitor=x", "--fsmonitor=x"], ["git show --ext-diff HEAD", "--ext-diff"], ["git log --textconv", "--textconv"],
    ["git rev-parse --parseopt", "--parseopt"], ["git cat-file --filters HEAD:x", "--filters"], ["git worktree list --lock", "--lock"],
    ["git tag v1", null], ["git tag -d v1", "-d"], ["git tag -a v1 -m x", "-a"], ["git remote -v add x y", null], ["git remote -v set-url origin y", null],
    ["git remote show -v origin --oops", null], ["git branch --sort x", "--sort"], ["git stash list --output=x", "--output=x"],
    ["git config --get a.b --add", null], ["git config --list --file x --edit", null], ["git reflog show --output=x", "--output=x"],
    ["git symbolic-ref HEAD refs/heads/x", null], ["git notes show --ref=x", "--ref=x"],
  ]) {
    const r = deniedOp(c);
    if (opt) assert.ok(r.includes(opt), `${c}: ${r}`);
  }
  for (const c of [
    "git log --oneline --graph --decorate -n 20 --format='%h %s' --since=2.weeks --author me -- docs/", "git log -5 -p --stat", "git log -L 1,5:README.md",
    "git show --name-only --format= HEAD", "git show -s --format=%H HEAD", "git diff --name-status --cached", "git diff -U5 -M50% a b", "git diff --stat=100 a..b",
    "git status -sb", "git status --porcelain=v1 -uno", "git fetch -p --tags origin", "git fetch --depth 1 origin main", "git ls-remote --heads origin",
    "git rev-parse --abbrev-ref --symbolic-full-name @{u}", "git rev-parse --git-path MERGE_HEAD", "git grep -n -i -e foo -- '*.md'", "git grep -C 2 foo",
    "git blame -L 1,10 README.md", "git cat-file -p HEAD", "git ls-files -z --others --exclude-standard", "git ls-tree -r --name-only HEAD",
    "git shortlog -sn", "git merge-base --is-ancestor a b", "git describe --tags --always", "git for-each-ref --format='%(refname)' refs/heads",
    "git tag -l 'v*' --sort=-v:refname", "git tag", "git tag -n", "git remote show origin", "git remote get-url --push origin", "git worktree list --porcelain",
    "git config --show-origin --get-all remote.origin.url", "git reflog exists refs/heads/x", "git stash show -p stash@{0}", "git notes list",
    "git symbolic-ref --short HEAD", "git show-ref --heads", "git rev-list --count HEAD", "git range-diff a...b", "git diff --output-indicator-new=+ HEAD",
  ]) allowedOp(c);
});

test("round 2 A: only a plain mktemp in the temp dir is a safe write prefix", () => {
  for (const c of ["D=$(mktemp -p /r/main); echo x > $D/a", "D=$(mktemp --tmpdir=/r/main); echo x > $D", "D=$(mktemp body.XXXX); echo x > $D",
    "D=$(mktemp /r/main/x.XXXX); echo x > $D", "D=$(mktemp -d -p .); echo x > $D/a"]) deniedOp(c);
  for (const c of ["D=$(mktemp); echo x > $D", "D=$(mktemp -d); echo x > $D/a", "D=$(mktemp -t body.XXXX); echo x > $D", "D=$(mktemp -d -t orbit.XXXX); echo x > $D/a"]) allowedOp(c);
});

test("round 2 B: eval shares the caller's cwd and variables", () => {
  deniedOp("cd /tmp && eval cd /r/main && touch x");
  deniedOp("eval 'TMPDIR=/r/main'; echo x > $TMPDIR/x");
  allowedOp("eval cd /tmp && touch x");
});

test("round 2 E: cd under ||, a pipe, background or a condition leaves the cwd unknown; printf -v and declare -n assign", () => {
  for (const c of ["cd /r/main || cd /tmp; touch x", "false || cd /tmp && touch x", "if true; then cd /tmp; fi; touch x", "cd /tmp | cat; touch x",
    "printf -v D %s /r/main; echo x > $D/a", "declare -n R=HOME; echo x > $R/a", "while false; do cd /tmp; done; touch x"]) deniedOp(c);
  allowedOp("cd /tmp && touch x; cd /tmp; touch y");
});

test("round 2 graphql: a query from a file or --input is denied", () => {
  for (const c of ["gh api graphql -F query=@q.graphql", "gh api graphql -f query=@q", "gh api graphql --input q.json", "gh api graphql --field=query=@q"]) deniedOp(c);
  allowedOp("gh api graphql -f query='{ viewer { login } }' -F n=3");
});

test("round 2 DEC-08: global -c and -C do not hide a worker's merge", () => {
  const w = { agent_id: "w1", agent_type: "orbit:coder", cwd: "/r/main" };
  for (const c of ["git -c user.name=x merge --no-ff -m x topic", "git -C \"$DIR\" merge --no-ff -m x topic", "git -C /r/main-topic -c a.b=c merge --no-ff topic"]) {
    assert.match(run(bash(c, w)) ?? "", /^DEC-08/, c);
  }
  assert.equal(run(bash("git -c user.name=x merge --no-ff -F msg-ok.txt topic", w)), null);
  deniedOp("git -C \"$DIR\" status");
  deniedOp("git -c user.name=x log");
  assert.equal(run(bash("git commit -C HEAD -F msg-ok.txt", w), ctx({ mergeHead: () => "abc1234", baseShas: () => [] })), null, "-C consumes its value; the file is checked");
});
