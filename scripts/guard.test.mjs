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
  for (const [t, i] of [["Write", { file_path: "README.md" }], ["Edit", { file_path: "/r/main-topic/.agents/operator.md" }], ["MultiEdit", { file_path: "/r/main/a.md" }], ["NotebookEdit", { notebook_path: "/r/main/n.ipynb" }], ["Write", { file_path: "/tmp/scratch/x" }], ["Write", {}]]) {
    assert.match(edit(t, i) ?? "", /^OPR-01: .*worker/, `${t} ${JSON.stringify(i)}`);
  }
  assert.equal(edit("Read", { file_path: "README.md" }), null);
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
  for (const [c] of DENIED) assert.equal(run(bash(c, worker)), null, c);
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
    "git merge --no-ff topic",
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
