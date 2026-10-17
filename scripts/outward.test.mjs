// Outward actions (Orbit 0.21.0): every git, gh and GitHub MCP call is classified for every session and mode.
// The one test (security condition set, round 2): a write to a protected ref is never allowed, in any spelling, session,
// permission mode or worktree profile; destructive actions are denied everywhere; branch pushes and local actions stay silent.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FAIL, guard, hookMain, outwardReason, realCtx } from "../hooks/guard.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = { HOME: "/home/u", TMPDIR: "/tmp/scratch" };
const REFS = { tags: ["v1.0", "x"], heads: ["main", "my-topic", "old-topic"], remote: ["main", "my-topic", "old-topic"] };
const ctx = (over = {}) => ({
  roots: ["/r/main", "/r/main-topic"],
  operatorFiles: ["/r/main/.agents/operator.md"],
  profile: () => ({ base: "main", pusher: "agent", trailer: "Reviewed-By", protected: [] }),
  mergeHead: () => null,
  baseShas: () => [],
  readFile: () => null,
  alias: (dir, n) => ({ ship: "push", st: "status", sh: "!git push origin HEAD:main" })[n] ?? null,
  refKind: (dir, n) => ({ tag: REFS.tags.includes(n), branch: REFS.heads.includes(n), remote: REFS.remote.includes(n) }),
  head: () => "my-topic",
  originHead: () => "main",
  commit: () => ({ sha: "1a2b3c4", subject: "first line of subject" }),
  followTags: () => false,
  ...over,
});
const hostile = () => ctx({ profile: () => ({ base: "foo", pusher: "agent", trailer: null, protected: [] }) });
const SESSIONS = {
  operator: { agent_type: "orbit:operator", cwd: "/r/main" },
  peer: { cwd: "/r/main-topic" },
  subagent: { agent_id: "a1", agent_type: "orbit:coder", cwd: "/r/main-topic" },
};
const ASK_MODES = ["default", "acceptEdits", "plan", "auto", "bypassPermissions"];
const MODES = [...ASK_MODES, "dontAsk", undefined];
const call = (command, who, mode, c = ctx()) => guard({ ...who, ...(mode ? { permission_mode: mode } : {}), tool_name: "Bash", tool_input: { command } }, env, c);
const kind = (r) => (r === null ? "allow" : typeof r === "string" ? "deny" : "ask");

const BASE_PUSH = [
  "git push origin HEAD:main",
  "git -c alias.ship=push ship origin HEAD:main",
  "git ship origin HEAD:main",
  "git sh",
  "env git push origin HEAD:main",
  "FOO=1 git push origin HEAD:main",
  "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.go GIT_CONFIG_VALUE_0=push git go origin HEAD:main",
  "sh -c 'git push origin HEAD:main'",
  "bash -c \"git push origin HEAD:main\"",
  "eval git push origin HEAD:main",
  "echo HEAD:main | xargs git push origin",
  "xargs git push origin < refs.txt",
  "git push origin \\\nHEAD:main",
  "git push origin\nHEAD:main",
  "git push origin +main",
  "git push origin HEAD:refs/heads/main",
  "git push origin main",
  "git push origin 'HEAD:main'",
  "git push -u origin HEAD:main",
  "git -C /r/main push origin HEAD:main",
  "git push origin HEAD:master",
  "git push origin HEAD:release/1.2",
  "G=git; $G push origin HEAD:main",
  "$G push origin HEAD:main",
  "/usr/bin/git push origin HEAD:main",
  "command git push origin HEAD:main",
  "g\\it push origin HEAD:main",
  "\"g\"it push origin HEAD:main",
  "git push origin HEAD:main && echo done",
  "git fetch && git push origin HEAD:main",
  "git push https://github.com/o/r.git HEAD:main",
  "git push upstream HEAD:main",
  "git push",
  "git push origin",
  "git push --repo=origin HEAD:main",
  "git push -C . origin HEAD:main",
  "git -C \"$X\" push origin HEAD:main",
  "git push origin $DST",
  "git push origin 'HEAD:main",
  "bash <<'EOF'\ngit push origin HEAD:main\nEOF",
  "python3 -c 'import os; os.system(\"git push origin HEAD:main\")'",
];

const DESTRUCTIVE = [
  "git push --delete origin v1.0",
  "git push -d origin v1.0",
  "git push origin :v1.0",
  "git push origin :refs/tags/v1.0",
  "git push origin --delete refs/tags/v1.0",
  "git push --delete origin $T",
  "git push --delete origin unknown-name",
  "git push --delete origin main",
  "echo v1.0 | xargs git push --delete origin",
  "sh -c 'git push --delete origin v1.0'",
  "git push -f origin HEAD:my-topic",
  "git push --force origin my-topic",
  "git push --force-with-lease origin HEAD:my-topic",
  "git push --force-with-lease=my-topic origin HEAD:my-topic",
  "git push -uf origin my-topic",
  "git push origin +HEAD:my-topic",
  "git push --mirror origin",
  "gh api -X DELETE repos/o/r/git/refs/tags/v1.0",
  "gh api --method delete repos/o/r/releases/1",
  "gh api --method=DELETE repos/o/r",
  "gh api -XDELETE repos/o/r/git/refs/heads/x",
  "gh api -X $M repos/o/r/git/refs/heads/x",
  "gh release delete v1.0",
  "gh release delete v1.0 --yes",
  "gh -R o/r release delete v1.0",
  "echo v1.0 | xargs gh release delete",
  "gh release delete-asset v1.0 a.zip",
  "gh release upload v1.0 a.zip --clobber",
  "gh repo delete o/r --yes",
  "gh repo archive o/r",
];

const LOCAL = ["git push origin HEAD:my-topic", "ls", "git tag -d x", "git fetch --prune", "git push origin my-topic", "git push -u origin HEAD:my-topic",
  "git push origin HEAD", "git status", "git st", "gh pr view 4", "gh release list", "gh auth status", "git config --get alias.ship", "git tag v2",
  "git branch -D old-topic", "git remote prune origin", "gh api repos/o/r/git/refs/heads/main", "gh api repos/o/r/issues/3/comments -f body=hi",
  "git commit -m 'fix the push of a tag'", "echo git push origin HEAD:main"];
const OPERATOR_LOCAL = ["ls", "git fetch --prune"];

const SHARED = ["git push origin v1.0", "git push origin refs/tags/v1.0", "git push origin HEAD:refs/tags/v2", "git push --tags", "git push --follow-tags origin my-topic",
  "git push --delete origin old-topic", "gh release create v1.0", "gh release edit v1.0", "gh release upload v1.0 a.zip", "gh pr merge 4", "gh run cancel 1",
  "gh run rerun 1", "gh workflow run ci.yml", "gh auth token", "gh auth login", "gh auth refresh", "gh auth setup-git", "git config alias.ship push",
  "git config core.hooksPath x", "git config remote.origin.pushurl x", "git config url.x.insteadOf y", "git -c core.hooksPath=/x commit -m x",
  "gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=x", "gh api graphql -f query='mutation { x }'", "gh alias set ship 'pr merge'",
  "git frobnicate", "gh frobnicate", "git -c core.pager='git push origin HEAD:main' log", "git send-pack origin main"];

// Fix round 1 (review of 79ba2cb): each failing input of the findings table, with its class.
const R1_DESTRUCTIVE = [
  "git push --force-with origin my-topic",            // 1: long options by unique prefix
  "git push --del origin main",
  "git push --del origin v1.0",
  "git push --mirr origin",
  "git push origin :heads/main",                      // 2: heads/ shorthand
  "/usr/lib/git-core/git-push --force origin HEAD:main", // 3: git-<sub> programs, plumbing pushers
  "git-push -f origin HEAD:my-topic",
  "git-send-pack --force origin main",
  "git send-pack --force origin main",
  "git http-push -D x",
  "find . -maxdepth 0 -exec git push -f origin HEAD:my-topic \\;", // 6: generalised wrappers
  "unbuffer git push -f origin HEAD:my-topic",
  "watch git push -f origin HEAD:my-topic",
  "gh api -X PATCH repos/o/r -f archived=true",       // 8: repo settings, GraphQL, forced ref update
  "gh api -X PUT /repos/o/r -F archived=true",
  "gh api -X PATCH repos/o/r/git/refs/heads/main -F force=true",
  "gh api graphql -f query='mutation { deleteRef(input:{refId:\"x\"}) { clientMutationId } }'",
  "gh api graphql -f query='mutation { deleteRepository(input:{repositoryId:\"x\"}) { clientMutationId } }'",
  "gh api graphql -f query='mutation { archiveRepository(input:{repositoryId:\"x\"}) { clientMutationId } }'",
  "gh api graphql -f query='mutation { updateRef(input:{refId:\"x\", oid:\"y\", force:true}) { clientMutationId } }'",
  "gh repo edit --visibility public",
];
const R1_SHARED = [
  "git push --tag origin my-topic",                   // 1
  "git push --follow origin my-topic",
  "git push --rep=https://example.com/o/r.git my-topic",
  "git push --f origin my-topic",                     // ambiguous
  "git push --forc origin my-topic",
  "git push --frobnicate origin my-topic",            // unknown
  "git push origin heads/main",                       // 2
  "git push origin HEAD:heads/main",
  "git push origin tags/v1.0",
  "git push origin HEAD:remotes/origin/main",
  "git-send-pack origin main",                        // 3
  "git http-push x",
  "git -c x.r=. for-each-repo --config=x.r push origin HEAD:main", // 4
  "git difftool -x 'sh -c x'",
  "git mergetool",
  "git filter-branch --tree-filter 'x' HEAD",
  "git -c core.sshCommand=ssh fetch",
  "git -c diff.external=x diff",
  "GIT_DIR=/repo/.git git push origin HEAD",          // 5
  "git --git-dir=/repo/.git push origin HEAD",
  "git --work-tree /x push origin HEAD",
  "GIT_WORK_TREE=/x git push origin HEAD",
  "GIT_INDEX_FILE=/x git push origin HEAD",
  "git -C \"$HOME/r\" push origin HEAD",
  "find . -maxdepth 0 -exec git push origin HEAD:main \\;", // 6
  "unbuffer git push origin HEAD:main",
  "parallel git push origin ::: HEAD:main",
  "flock /tmp/l git push origin HEAD:main",
  "git -c push.followTags=true push origin my-topic", // 7
  "git config push.followTags true",
  "git config push.default current",
  "gh api -X PATCH repos/o/r -f default_branch=x",    // 8
  "gh api -X PATCH repos/o/r -f visibility=public",
  "gh api -X POST repos/o/r -f name=y",
  "gh repo edit --default-branch x",
  "gh repo rename y",
  "gh api graphql -f query='mutation { mergePullRequest(input:{pullRequestId:\"x\"}) { clientMutationId } }'",
  "gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=x",
];
// Routine flows from the review: silent.
const R1_LOCAL = [
  "bash scripts/check.sh && git push -u origin my-topic", // 10
  "make test && git push origin HEAD:my-topic",
  "npm run lint; git push origin my-topic",
  "git push --verbose origin my-topic",
  "git push --set-up origin my-topic",
  "git push --no-verify origin my-topic",
  "git push origin feature/x",
  "git -c core.pager=cat log",
  "GIT_PAGER=cat git log",
  "find . -name '*.md' -exec grep -l git {} +",
  "sudo apt-get install -y git gh",
  "brew install gh git",
  "man git",
  "grep -rn git .",
  "npm install git-url-parse",
  "gh api -X PATCH repos/o/r/issues/3 -f state=closed",
];

test("fix round 1: each failing input of the review gets its class", () => {
  const wrong = [];
  const want = (cmd, who, mode, k, c) => { const got = kind(call(cmd, SESSIONS[who], mode, c)); if (got !== k && !(k === "not allow" && got !== "allow")) wrong.push(`${who} ${mode} ${cmd}: ${got}, want ${k}`); };
  for (const name of ["peer", "subagent"]) {
    for (const cmd of R1_DESTRUCTIVE) for (const mode of ["default", "bypassPermissions", "dontAsk"]) want(cmd, name, mode, "deny");
    for (const cmd of R1_SHARED) { want(cmd, name, "default", "ask"); want(cmd, name, "dontAsk", "deny"); }
    for (const cmd of R1_LOCAL) for (const mode of MODES) want(cmd, name, mode, "allow");
  }
  for (const c of [ctx(), hostile()]) for (const cmd of [...R1_DESTRUCTIVE, ...R1_SHARED]) want(cmd, "operator", "default", "not allow", c);
  assert.deepEqual(wrong, []);
});

test("fix round 1: @ and a literal -C read the branch of that repo; push.followTags turns a branch push into a tag push", () => {
  const onMain = ctx({ head: (dir) => (dir === "/r/main" ? "main" : "my-topic") });
  assert.equal(kind(call("git push origin @", SESSIONS.peer, "default", ctx({ head: () => "main" }))), "ask");
  assert.equal(call("git push origin @", SESSIONS.peer, "default"), null);
  assert.equal(kind(call("git -C /r/main push origin HEAD", SESSIONS.peer, "default", onMain)), "ask");
  assert.equal(call("git push origin HEAD", SESSIONS.peer, "default", onMain), null);
  assert.equal(kind(call("git push origin my-topic", SESSIONS.peer, "default", ctx({ followTags: () => true }))), "ask");
  assert.equal(kind(call("git push origin my-topic", SESSIONS.peer, "default", ctx({ followTags: () => FAIL }))), "ask");
  assert.equal(call("git push origin my-topic", SESSIONS.peer, "default"), null);
});

test("fix round 1: a script in the same call adds nothing; a shared action not alone is still denied; unreadable git text still asks", () => {
  assert.equal(kind(call("bash scripts/check.sh && git push origin HEAD:main", SESSIONS.peer, "default")), "deny");
  assert.equal(kind(call("X='git push origin HEAD:main'; sh -c \"$X\"", SESSIONS.peer, "default")), "deny");
  assert.equal(kind(call("sh -c \"$X\"", SESSIONS.peer, "default")), "allow");
  assert.equal(kind(call("python3 -c 'import os; os.system(\"git push origin HEAD:main\")'", SESSIONS.peer, "default")), "ask");
  assert.equal(call("git log --grep run (", SESSIONS.peer, "default"), null, "bare run is no outward word");
  assert.equal(kind(call("gh run cancel 1 (", SESSIONS.peer, "default")), "ask", "gh run is");
});

test("the one test: every spelling of a base push asks or denies, never allows, for every session, mode and profile", () => {
  for (const [name, who] of Object.entries(SESSIONS)) for (const mode of MODES) for (const c of [ctx(), hostile()]) for (const cmd of BASE_PUSH) {
    const r = call(cmd, who, mode, c), k = kind(r);
    assert.notEqual(k, "allow", `${name} ${mode} ${cmd}`);
    if (!ASK_MODES.includes(mode)) assert.equal(k, "deny", `${name} ${mode} ${cmd}: no prompt in this mode`);
  }
});

test("the one test: every destructive spelling is denied for every session, mode and profile", () => {
  for (const [name, who] of Object.entries(SESSIONS)) for (const mode of MODES) for (const c of [ctx(), hostile()]) for (const cmd of DESTRUCTIVE) {
    assert.equal(kind(call(cmd, who, mode, c)), "deny", `${name} ${mode} ${cmd}`);
  }
});

test("the one test: branch pushes and local actions stay silent; the profile changes none of it", () => {
  for (const name of ["peer", "subagent"]) for (const mode of MODES) for (const c of [ctx(), hostile()]) for (const cmd of LOCAL) {
    assert.equal(call(cmd, SESSIONS[name], mode, c), null, `${name} ${mode} ${cmd}`);
  }
  for (const mode of MODES) for (const cmd of OPERATOR_LOCAL) assert.equal(call(cmd, SESSIONS.operator, mode), null, `operator ${mode} ${cmd}`);
});

test("shared actions ask where the mode prompts and deny elsewhere; a shared action not alone in its call is denied", () => {
  for (const name of ["peer", "subagent"]) for (const cmd of SHARED) {
    for (const mode of ASK_MODES) assert.equal(kind(call(cmd, SESSIONS[name], mode)), "ask", `${name} ${mode} ${cmd}`);
    for (const mode of ["dontAsk", undefined, "weird"]) assert.equal(kind(call(cmd, SESSIONS[name], mode)), "deny", `${name} ${mode} ${cmd}`);
    assert.equal(kind(call(`${cmd}; ls`, SESSIONS[name], "default")), "deny", `${cmd}; ls`);
  }
  assert.equal(kind(call("git status | cat && git push origin HEAD:main", SESSIONS.peer, "bypassPermissions")), "deny");
});

test("a hostile worktree profile only adds: base_branch foo protects foo, main stays protected; an added list protects more", () => {
  assert.equal(kind(call("git push origin HEAD:foo", SESSIONS.subagent, "default", hostile())), "ask");
  assert.equal(kind(call("git push origin HEAD:main", SESSIONS.subagent, "default", hostile())), "ask");
  const extra = ctx({ profile: () => ({ base: "main", pusher: "owner", trailer: null, protected: ["staging", "hotfix/*"] }) });
  for (const d of ["staging", "hotfix/1"]) assert.equal(kind(call(`git push origin HEAD:${d}`, SESSIONS.subagent, "default", extra)), "ask", d);
  assert.equal(call("git push origin HEAD:my-topic", SESSIONS.subagent, "default", extra), null);
  assert.equal(kind(call("git push origin HEAD:develop", SESSIONS.subagent, "default", ctx({ originHead: () => "develop" }))), "ask", "origin/HEAD target");
});

test("a helper git call that fails or times out gives the stricter class", () => {
  const failing = ctx({ alias: () => FAIL, refKind: () => FAIL, head: () => FAIL, originHead: () => FAIL });
  assert.equal(kind(call("git ship origin HEAD:x", SESSIONS.peer, "default", failing)), "ask");
  assert.equal(kind(call("git push --delete origin old-topic", SESSIONS.peer, "default", failing)), "deny");
  assert.equal(kind(call("git push origin HEAD", SESSIONS.peer, "default", failing)), "ask");
  assert.equal(kind(call("git push origin HEAD:my-topic", SESSIONS.peer, "default", failing)), "ask");
});

test("the operator: only the lone base push moved, allow to ask; every other deny stays", () => {
  const o = SESSIONS.operator;
  assert.equal(kind(call("git push origin HEAD:main", o, "default")), "ask");
  assert.equal(kind(call("git push origin HEAD:main", o, "dontAsk")), "deny");
  assert.match(call("git push origin HEAD:main", o, "default", ctx({ profile: () => ({ base: "main", pusher: null, trailer: null, protected: [] }) })), /^OPR-01/);
  for (const c of ["git push origin my-topic", "git commit -m x", "git fetch && git push origin HEAD:main", "gh pr merge 4"]) assert.equal(kind(call(c, o, "bypassPermissions")), "deny", c);
});

test("the hook prints ask or deny JSON; a parse error on outward text asks; a guard error on outward text asks", () => {
  const out = (o) => JSON.parse(o.stdout).hookSpecificOutput;
  const ev = (command, extra = {}) => JSON.stringify({ cwd: "/r/main-topic", agent_id: "a1", agent_type: "orbit:coder", permission_mode: "default", tool_name: "Bash", tool_input: { command }, ...extra });
  const fn = (input, e) => guard(input, e, ctx());
  assert.equal(out(hookMain(ev("git push origin HEAD:main"), {}, fn)).permissionDecision, "ask");
  assert.equal(out(hookMain(ev("git push --delete origin v1.0"), {}, fn)).permissionDecision, "deny");
  assert.equal(out(hookMain(ev("git push origin HEAD:main", { permission_mode: "dontAsk" }), {}, fn)).permissionDecision, "deny");
  const boom = () => { throw new Error("boom"); };
  assert.equal(out(hookMain(ev("git push origin HEAD:main"), {}, boom)).permissionDecision, "ask");
  assert.equal(hookMain(ev("ls"), {}, boom).stdout, "");
});

const SNAP_BASE_ASK = [
  "orbit · ASK · push to protected branch",
  "action   git push → origin/main",
  "commit   1a2b3c4 \"first line of subject\"",
  "by       subagent orbit:coder",
  "do       approve only if you gave the go",
].join("\n");
const SNAP_TAG_DELETE = [
  "orbit · DENY · tag delete",
  "action   git push --delete → origin/v1.0",
  "do       run it yourself with ! git push --delete origin v1.0",
].join("\n");
const SNAP_CHAINED = [
  "orbit · DENY · push to protected branch",
  "action   git push → origin/main",
  "commit   1a2b3c4 \"first line of subject\"",
  "note     not alone in its call",
  "do       run it alone in its own call",
].join("\n");
const SNAP_MCP = [
  "orbit · ASK · GitHub merge",
  "action   mcp__github__merge_pull_request o/r#4",
  "by       subagent orbit:coder",
  "do       approve only if you gave the go",
].join("\n");

test("reason snapshots: base push ask, tag delete deny, chained push deny, MCP ask; at most 6 lines", () => {
  assert.equal(call("git push origin HEAD:main", SESSIONS.subagent, "default").ask, SNAP_BASE_ASK);
  assert.equal(call("git push --delete origin v1.0", SESSIONS.peer, "default"), SNAP_TAG_DELETE);
  assert.equal(call("git fetch && git push origin HEAD:main", SESSIONS.peer, "default"), SNAP_CHAINED);
  const mcp = guard({ ...SESSIONS.subagent, permission_mode: "auto", tool_name: "mcp__github__merge_pull_request", tool_input: { owner: "o", repo: "r", pullNumber: 4 } }, env, ctx());
  assert.equal(mcp.ask, SNAP_MCP);
  for (const s of [SNAP_BASE_ASK, SNAP_TAG_DELETE, SNAP_CHAINED, SNAP_MCP]) assert.ok(s.split("\n").length <= 6);
  assert.equal(outwardReason("ASK", { what: "x", action: "y" }, {}), "orbit · ASK · x\naction   y\ndo       approve only if you gave the go");
});

test("a token-looking value in the command never appears in the reason", () => {
  const tok = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
  for (const c of [
    `git push https://x:${tok}@github.com/o/r.git HEAD:main`,
    `GH_TOKEN=${tok} gh release delete v1.0`,
    `gh api -H "Authorization: token ${tok}" -X DELETE 'repos/o/r?access_token=${tok}'`,
    `git push origin HEAD:main -o ${tok}`,
    `gh api -X DELETE repos/o/r/${tok}`,
  ]) for (const mode of ["default", "dontAsk"]) {
    const r = call(c, SESSIONS.subagent, mode);
    const text = typeof r === "string" ? r : r?.ask;
    assert.ok(text, c);
    assert.ok(!text.includes(tok) && !text.includes("ghp_") && !text.includes("example"), `${c}\n${text}`);
  }
});

test("GitHub MCP tools: delete or force denied, writes ask (deny without a prompt), other MCP untouched", () => {
  const mcp = (tool_name, mode = "default", tool_input = {}) => guard({ ...SESSIONS.subagent, permission_mode: mode, tool_name, tool_input }, env, ctx());
  for (const t of ["mcp__github__delete_file", "mcp__github__delete_ref", "mcp__plugin_github_github__force_push"]) assert.equal(kind(mcp(t)), "deny", t);
  assert.equal(kind(mcp("mcp__github__update_ref", "default", { force: true })), "deny");
  for (const t of ["mcp__github__merge_pull_request", "mcp__github__push_files", "mcp__github__create_ref", "mcp__github__update_ref", "mcp__github__create_release",
    "mcp__github__cancel_workflow_run", "mcp__github__rerun_workflow_run", "mcp__github__run_workflow_dispatch"]) {
    assert.equal(kind(mcp(t)), "ask", t);
    assert.equal(kind(mcp(t, "dontAsk")), "deny", t);
  }
  for (const t of ["mcp__github__get_pull_request", "mcp__github__list_issues", "mcp__github__search_code", "mcp__github__read_file", "mcp__linear__delete_issue",
    "mcp__slack__merge", "mcp__linear__github_sync"]) assert.equal(mcp(t), null, t);
  for (const t of ["mcp__github__create_or_update_file", "mcp__github__run_workflow", "mcp__github__create_issue", "mcp__github__update_repository"]) {
    assert.equal(kind(mcp(t, "default", { branch: "main" })), "ask", t);
    assert.equal(kind(mcp(t, "dontAsk")), "deny", t);
  }
  const pre = JSON.parse(readFileSync(join(repo, "hooks/hooks.json"), "utf8")).hooks.PreToolUse;
  const g = pre.find((e) => e.hooks.some((x) => x.command.includes("hooks/guard")));
  assert.ok(g.matcher.split("|").includes("mcp__.*"), "the guard matcher covers MCP tools");
});

test("realCtx: aliases from .git/config, tags, the current branch, origin/HEAD and the protected_branches list", () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "outward-")));
  try {
    const g = (...a) => spawnSync("git", ["-C", d, "-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { encoding: "utf8" });
    g("init", "-q", "-b", "my-topic"); g("commit", "-q", "--allow-empty", "-m", "first line of subject"); g("tag", "v1.0"); g("config", "alias.ship", "push");
    const c = realCtx(d, {});
    assert.equal(c.alias(d, "ship"), "push");
    assert.equal(c.alias(d, "nope"), null);
    assert.deepEqual(c.refKind(d, "v1.0"), { tag: true, branch: false, remote: false });
    assert.equal(c.head(d), "my-topic");
    assert.equal(c.originHead(d), null);
    assert.match(c.commit(d, "HEAD").subject, /first line/);
    assert.equal(c.followTags(d), false);
    assert.equal(guard({ cwd: d, permission_mode: "default", tool_name: "Bash", tool_input: { command: "git push origin my-topic" } }, {}, realCtx(d, {})), null);
    g("config", "push.followTags", "yes");
    assert.equal(realCtx(d, {}).followTags(d), true);
    assert.equal(kind(guard({ cwd: d, permission_mode: "default", tool_name: "Bash", tool_input: { command: "git push origin my-topic" } }, {}, realCtx(d, {}))), "ask", "push.followTags set: a tag push");
    assert.equal(kind(guard({ cwd: d, permission_mode: "default", tool_name: "Bash", tool_input: { command: "git ship origin HEAD:main" } }, {}, c)), "ask");
    assert.equal(kind(guard({ cwd: d, permission_mode: "default", tool_name: "Bash", tool_input: { command: "git push --delete origin v1.0" } }, {}, realCtx(d, {}))), "deny");
    const spent = realCtx(d, {}, 0);
    assert.equal(spent.alias(d, "ship"), FAIL, "no time left: FAIL, never a guess");
    assert.equal(spent.refKind(d, "v1.0"), FAIL);
    assert.equal(kind(guard({ cwd: d, permission_mode: "default", tool_name: "Bash", tool_input: { command: "git push origin HEAD:my-topic" } }, {}, spent)), "ask", "the stricter class");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// Fix round 2 (re-review of aa0ae93, Orbit #11) and the gh classes of Orbit #9: each failing input gets its class.
const FR2_DESTRUCTIVE = [
  "find . -maxdepth 0 -exec sh -c 'git push -f origin HEAD:main' \\;",   // R6: git text inside an argument, forcing
  "unbuffer sh -c 'git push --force origin HEAD:main'",
  "parallel ::: 'git push --delete origin main'",
  "find . -name test -exec git push -f origin HEAD:main \\;",            // N1: a data program name among the arguments
  "find . -name cat -exec git push -f origin HEAD:main \\;",
  "find . -name file -exec git push -f origin HEAD:main \\;",
  "find . -name head -exec git push -f origin HEAD:main \\;",
  "git send-pack --force-with-lease origin main",                        // N5
  "git send-pack --force-if-includes origin main",
  "gh api -X POST repos/o/r/transfer -f new_owner=x",                    // N4
  "gh repo sync --force",
  "gh repo sync o/r --force",
  "gh repo deploy-key delete 5",
  "gh secret delete TOKEN",                                              // #9
  "gh variable delete X",
  "gh ruleset delete 3",
  "gh run delete 5",
  "gh api -X POST repos/o/r/statuses/abc -f state=success",              // statuses and check runs: denied in every mode
  "gh api repos/o/r/check-runs -f name=ci -f head_sha=abc",
  "gh api -X PATCH repos/o/r/check-runs/7 -f conclusion=success",
  "gh api graphql -f query='mutation { createCheckRun(input:{name:\"ci\"}) { clientMutationId } }'",
];
const FR2_SHARED = [
  "parallel ::: 'git push origin HEAD:main'",                            // R6
  "find . -maxdepth 0 -exec sh -c 'git push origin HEAD:main' \\;",
  "unbuffer sh -c 'git push origin HEAD:main'",
  "git fetch --upload-pack='git push -f origin HEAD:main; :' .",         // N2
  "git ls-remote --upload-pack=x origin",
  "git ls-remote -u x origin",
  "git clone -u x https://example.com/r.git",
  "git grep -O 'x' foo",
  "git grep -nOecho foo",
  "git grep --open-files=vi foo",
  "git archive --exec=x --remote=origin HEAD",
  "git fetch --upload-p=x origin",
  "git pull --upload-pack=x origin main",
  "GIT_SSH_COMMAND='sh -c \"git push -f origin HEAD:main\"; :' git fetch origin", // N3
  "GIT_SSH=x git fetch",
  "GIT_ASKPASS=x git fetch",
  "GIT_EDITOR=vim git commit",
  "GIT_SEQUENCE_EDITOR=x git rebase -i HEAD~2",
  "GIT_EXTERNAL_DIFF=x git diff",
  "GIT_PAGER=x git log",
  "GIT_EXEC_PATH=/tmp/x git status",
  "env GIT_SSH_COMMAND=x git fetch",
  "gh api -X PUT repos/o/r/collaborators/x",                             // N4
  "gh api -X POST repos/o/r/keys -f key=x",
  "gh api -X POST repos/o/r/hooks -f name=web",
  "gh api -X POST repos/o/r/pulls/4/reviews -f event=APPROVE",
  "gh api -X PUT repos/o/r/actions/permissions -f enabled=false",
  "gh repo deploy-key add k.pub",
  "gh repo sync",
  "gh pr review 4 --approve",                                            // #9
  "gh pr review --approve",
  "gh pr review 4 -a",
  "gh secret set TOKEN",
  "gh variable set X --body y",
  "gh ruleset frob 1",
  "gh repo edit --description x",
];
const FR2_LOCAL = [
  "GIT_PAGER=cat git log", "GIT_EDITOR=true git commit -m x", "GIT_SEQUENCE_EDITOR=: git rebase -i HEAD~2",
  "gh api repos/o/r/issues/3/comments -f body=hi", "gh api -X PATCH repos/o/r/pulls/4 -f title=x", "gh api repos/o/r/pulls/4/comments -f body=x",
  "gh api repos/o/r/pulls -f title=x -f head=a -f base=main", "gh api -X POST repos/o/r/issues -f title=x",
  "gh pr review 4 --comment -b x", "gh pr review 4 --request-changes -b x", "gh secret list", "gh variable list", "gh ruleset list", "gh ruleset view 1",
  "gh run view 5", "git fetch origin", "git clone https://example.com/r.git", "git grep -n x", "git ls-remote origin",
  "find . -name '*.md' -exec grep -l 'git push' {} +", "find . -name git", "grep -rn 'git push -f' .", "echo git push --force", "make test",
];

test("fix round 2: each failing input of the re-review and the #9 gh classes gets its class", () => {
  const wrong = [];
  const want = (cmd, who, mode, k, c) => { const got = kind(call(cmd, SESSIONS[who], mode, c)); if (got !== k && !(k === "not allow" && got !== "allow")) wrong.push(`${who} ${mode} ${cmd}: ${got}, want ${k}`); };
  for (const name of ["peer", "subagent"]) {
    for (const cmd of FR2_DESTRUCTIVE) for (const mode of ["default", "bypassPermissions", "dontAsk"]) want(cmd, name, mode, "deny");
    for (const cmd of FR2_SHARED) { want(cmd, name, "default", "ask"); want(cmd, name, "dontAsk", "deny"); }
    for (const cmd of FR2_LOCAL) for (const mode of MODES) want(cmd, name, mode, "allow");
  }
  want("export GIT_SSH_COMMAND=x; git fetch", "peer", "default", "not allow");
  for (const cmd of [...FR2_DESTRUCTIVE, ...FR2_SHARED]) want(cmd, "operator", "default", "not allow");
  assert.deepEqual(wrong, []);
});

test("fix round 2: a secret or variable value never reaches the reason", () => {
  for (const c of ["gh secret set TOKEN --body hunter2", "gh variable set X --body hunter2", "gh secret set TOKEN -b hunter2"]) {
    const r = call(c, SESSIONS.peer, "default");
    const text = typeof r === "string" ? r : r?.ask;
    assert.ok(text && !text.includes("hunter2"), `${c}\n${text}`);
  }
});

test("H6: the commit subject in a reason drops control and format characters and is capped at 72 characters", () => {
  const subject = "\u202eevil\u0007 " + "ab ".repeat(40);
  const r = call("git push origin HEAD:main", SESSIONS.subagent, "default", ctx({ commit: () => ({ sha: "1a2b3c4", subject }) }));
  const row = r.ask.split("\n").find((l) => l.startsWith("commit"));
  const shown = row.slice(row.indexOf("\"") + 1, row.lastIndexOf("\""));
  assert.equal(shown.length, 72, row);
  assert.ok(!/[\p{Cc}\p{Cf}]/u.test(shown), row);
  assert.ok(shown.startsWith("evil ab"), row);
});
