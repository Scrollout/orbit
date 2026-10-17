// Unattended go (Orbit 0.21.0, security conditions 1-9). The one test: `/orbit:unattended on 24h` delivered by hand-back,
// scheduled prompt, cross-session message or typed: only the typed path, with the code shown on the owner's terminal typed
// back as `confirm`, leaves a go. With a hand-written valid go, every base-push spelling that lacks the evidence is denied;
// the pinned sha with full evidence is allowed and captured as class `go`.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FAIL, guard, realCtx } from "../hooks/guard.mjs";
import { EVIDENCE_MS, goState } from "../hooks/go.mjs";
import { onPrompt } from "../hooks/unattended.mjs";
import { goLog, outwardEvents } from "../hooks/capture.mjs";
import { plan } from "./tracker.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const SID = "sess-1";
const home = () => realpathSync(mkdtempSync(join(tmpdir(), "orbit-home-")));
const stateDir = (h) => join(h, ".claude/orbit/unattended");
const files = (h) => (existsSync(stateDir(h)) ? readdirSync(stateDir(h)) : []);
const kind = (r) => (r === null ? "allow" : typeof r === "string" ? "deny" : "ask");

// The owner's terminal: what the hook writes there is seen by the owner only.
function terminal() {
  const lines = [];
  return { lines, io: (now = 0) => ({ now: () => now, tty: (t) => { lines.push(t); return true; } }), code: () => /\b([A-Z2-9]{4}-[A-Z2-9]{4})\b/.exec(lines.at(-1) ?? "")?.[1] };
}
const prompt = (text, extra = {}) => ({ hook_event_name: "UserPromptSubmit", session_id: SID, permission_mode: "bypassPermissions", prompt: text, ...extra });

test("the one test, part 1: only the typed command confirmed with the terminal code leaves a go", () => {
  // Every path fires UserPromptSubmit with the same text and no source field; only the owner reads the terminal.
  const PATHS = {
    typed: (t) => prompt(t),
    "hand-back": (t) => prompt(t),
    scheduled: (t) => prompt(t),
    "cross-session": (t) => prompt(t),
  };
  for (const [path, mk] of Object.entries(PATHS)) {
    const h = home(), env = { HOME: h }, tty = terminal();
    try {
      const on = onPrompt(mk("/orbit:unattended on 24h"), env, tty.io());
      assert.ok(on?.block, path);
      const code = tty.code();
      assert.ok(code, `${path}: the code is on the terminal`);
      assert.ok(!on.block.includes(code), `${path}: the code is never in the block reason`);
      assert.ok(files(h).every((f) => !readFileSync(join(stateDir(h), f), "utf8").includes(code)), `${path}: only a hash is stored`);
      // Who sends the confirm: the owner (typed) reads the terminal; any other path can only guess.
      const typedBack = path === "typed" ? code : "AAAA-AAAA";
      const c = onPrompt(mk(`/orbit:unattended confirm ${typedBack}`), env, tty.io(1000));
      assert.ok(c?.block, path);
      const go = goState({ session_id: SID, permission_mode: "bypassPermissions" }, env, 2000);
      if (path === "typed") assert.ok(go, "typed + confirm opens the go");
      else {
        assert.equal(go, null, `${path}: no go`);
        assert.deepEqual(files(h), [], `${path}: a wrong confirm clears the pending code`);
        assert.ok(onPrompt(mk(`/orbit:unattended confirm ${code}`), env, tty.io(1500)).block, path);
        assert.equal(goState({ session_id: SID, permission_mode: "bypassPermissions" }, env, 2000), null, `${path}: the right code after a wrong one opens nothing`);
      }
    } finally { rmSync(h, { recursive: true, force: true }); }
  }
});

test("prompt hook: 2-minute expiry, session binding, no terminal no code, off and status from any source, other prompts untouched", () => {
  const h = home(), env = { HOME: h }, tty = terminal();
  try {
    assert.equal(onPrompt(prompt("please run /orbit:unattended on"), env, tty.io()), null);
    assert.equal(onPrompt(prompt("hello"), env, tty.io()), null);
    onPrompt(prompt("/orbit:unattended on 8h"), env, tty.io(0));
    onPrompt(prompt(`/orbit:unattended confirm ${tty.code()}`), env, tty.io(121_000));
    assert.equal(goState({ session_id: SID, permission_mode: "bypassPermissions" }, env, 122_000), null, "expired after 2 minutes");
    onPrompt(prompt("/orbit:unattended on 8h"), env, tty.io(0));
    onPrompt(prompt(`/orbit:unattended confirm ${tty.code()}`, { session_id: "other" }), env, tty.io(1000));
    assert.equal(goState({ session_id: "other", permission_mode: "bypassPermissions" }, env, 2000), null, "another session cannot confirm");
    const none = onPrompt(prompt("/orbit:unattended on"), env, { now: () => 0, tty: () => false });
    assert.match(none.block, /terminal/);
    assert.deepEqual(files(h), [], "no terminal: nothing pending");
    assert.match(onPrompt(prompt("/orbit:unattended on 25h"), env, tty.io()).block, /24 h/);
    onPrompt(prompt("/orbit:unattended on 8h"), env, tty.io(0));
    onPrompt(prompt(`/orbit:unattended confirm ${tty.code()}`), env, tty.io(1000));
    assert.ok(goState({ session_id: SID, permission_mode: "bypassPermissions" }, env, 2000));
    assert.match(onPrompt(prompt("/orbit:unattended status", { permission_mode: "default" }), env, tty.io(2000)).block, /open until/);
    assert.ok(onPrompt(prompt("/orbit:unattended off"), env, tty.io(3000)).block);
    assert.equal(goState({ session_id: SID, permission_mode: "bypassPermissions" }, env, 4000), null, "off closes it");
    assert.match(onPrompt(prompt("/orbit:unattended frob"), env, tty.io()).block, /on \[duration\]/);
    assert.match(onPrompt(prompt("/orbit:unattended on", { session_id: undefined }), env, tty.io()).block, /session/);
  } finally { rmSync(h, { recursive: true, force: true }); }
});

// A hand-written go state file: valid for SID, opened now, 8 h.
function withGo(fn, over = {}) {
  const h = home(), now = Date.now();
  mkdirSync(stateDir(h), { recursive: true });
  writeFileSync(join(stateDir(h), `go-${SID}.json`), JSON.stringify({ session_id: SID, opened: now - 1000, until: now + 8 * 3600_000, ...over }));
  try { return fn({ HOME: h }, h); } finally { rmSync(h, { recursive: true, force: true }); }
}

test("goState: session match, at most 24 h, unexpired, no agent_id, bypassPermissions; any missing field is no go", () => {
  withGo((env) => {
    const ok = { session_id: SID, permission_mode: "bypassPermissions" };
    assert.ok(goState(ok, env));
    for (const bad of [{ ...ok, session_id: "x" }, { ...ok, agent_id: "a1" }, { ...ok, permission_mode: "default" }, { session_id: SID }, { permission_mode: "bypassPermissions" }, null]) assert.equal(goState(bad, env), null, JSON.stringify(bad));
    assert.equal(goState(ok, {}), null, "no HOME");
  });
  withGo((env) => assert.equal(goState({ session_id: SID, permission_mode: "bypassPermissions" }, env), null, "expired"), { until: Date.now() - 1 });
  withGo((env) => assert.equal(goState({ session_id: SID, permission_mode: "bypassPermissions" }, env), null, "over 24 h"), { opened: Date.now() - 1000, until: Date.now() + 25 * 3600_000 });
  withGo((env) => assert.equal(goState({ session_id: SID, permission_mode: "bypassPermissions" }, env), null, "another session's file"), { session_id: "other" });
});

// ---------- evidence stubs: git and gh never touch the network ----------
const ORIGIN = "git@github.com:o/r.git";
const M = "a".repeat(40), P1 = "b".repeat(40), P2 = "c".repeat(40), T = "d".repeat(40), TIP = "e".repeat(40);
const run = (name, o = {}) => ({ name, status: "completed", conclusion: "success", run_attempt: 1, head_sha: P2, ...o });
const MSG = "Merge branch 'topic'\n\nReviewed-by: reviewer (opus) - comment 1 on issue #2\nCo-Authored-By: X <x@example.com>";
function evidence(over = {}) {
  const git = {
    [`rev-list --parents -n 1 ${M}`]: `${M} ${P1} ${P2}`,
    [`ls-remote ${ORIGIN} refs/heads/main`]: `${P1}\trefs/heads/main`,
    [`ls-remote ${ORIGIN} refs/heads/old-topic`]: `${TIP}\trefs/heads/old-topic`,
    [`merge-base --is-ancestor ${TIP} ${P1}`]: "",
    [`rev-parse ${M}^{tree} ${P2}^{tree}`]: `${T}\n${T}`,
    "remote get-url origin": ORIGIN,
    "remote get-url --push origin": ORIGIN,
    [`log -1 --no-show-signature --format=%B ${M}`]: MSG,
    [`diff --name-status --no-renames --no-ext-diff --no-textconv ${P1} ${M}`]: "M\tsrc/a.go\nA\tsrc/a_test.go",
    [`diff -U0 --no-color --no-ext-diff --no-textconv ${P1} ${M}`]: "+++ b/src/a.go\n+func x() {}",
    ...over.git,
  };
  const gh = {
    [`repos/o/r/actions/runs?head_sha=${P2}&per_page=100`]: { total_count: 2, workflow_runs: [run("ci"), run("codeql")] },
    [`repos/o/r/actions/runs?head_sha=${P1}&per_page=100`]: { total_count: 1, workflow_runs: [run("ci", { head_sha: P1 })] },
    ...over.gh,
  };
  return {
    git: (dir, ...a) => { const k = a.join(" "); if (git[k] === FAIL) return FAIL; return k in git ? { code: git[k] === null ? 1 : 0, out: git[k] ?? "" } : { code: 128, out: "" }; },
    gh: (path) => (gh[path] === FAIL ? FAIL : gh[path] !== undefined ? { code: 0, out: JSON.stringify(gh[path]) } : { code: 1, out: "" }),
  };
}
const ctx = (over = {}) => ({
  roots: ["/r/main", "/r/merge"], operatorFiles: ["/r/main/.agents/operator.md"],
  profile: () => ({ base: "main", pusher: "agent", trailer: "Reviewed-by", protected: [] }),
  mergeHead: () => null, baseShas: () => [], readFile: () => null, alias: () => null,
  refKind: (d, n) => ({ tag: n === "v1.0", branch: n !== "v1.0", remote: true }), head: () => "main", originHead: () => "main",
  commit: () => ({ sha: "aaaaaaa", subject: "merge" }), followTags: () => false,
  evidence: () => evidence(over),
  ...(over.ctx ?? {}),
});
const MAIN = { session_id: SID, cwd: "/r/merge", permission_mode: "bypassPermissions" };
const bash = (command, who = MAIN) => ({ ...who, tool_name: "Bash", tool_input: { command } });
const PINNED = `git push origin ${M}:refs/heads/main`;

test("the one test, part 2: under a hand-written go, the pinned sha with full evidence is allowed; every spelling or fact that lacks it is denied", () => {
  withGo((env) => {
    assert.equal(guard(bash(PINNED), env, ctx()), null, "full evidence: allowed");
    assert.equal(guard(bash(`git -C /r/merge push origin ${M}:refs/heads/main`), env, ctx()), null, "git -C from the merge worktree");
    assert.equal(guard(bash(`git -C /r/merge push origin ${M}:refs/heads/main`, { ...MAIN, agent_type: "orbit:operator" }), env, ctx()), null, "the operator main thread");
    const deny = (label, command, over = {}, who = MAIN) => {
      const r = guard(bash(command, who), env, ctx(over));
      assert.equal(kind(r), "deny", `${label}: ${JSON.stringify(r)}`);
      return r;
    };
    const R = (o) => ({ gh: { [`repos/o/r/actions/runs?head_sha=${P2}&per_page=100`]: o } });
    deny("second attempt", PINNED, R({ total_count: 2, workflow_runs: [run("ci", { run_attempt: 2 }), run("codeql")] }));
    deny("one run failed", PINNED, R({ total_count: 2, workflow_runs: [run("ci"), run("codeql", { conclusion: "failure" })] }));
    deny("a run still in progress", PINNED, R({ total_count: 2, workflow_runs: [run("ci"), run("codeql", { status: "in_progress", conclusion: null })] }));
    deny("zero runs", PINNED, R({ total_count: 0, workflow_runs: [] }));
    deny("more runs than one page", PINNED, R({ total_count: 101, workflow_runs: [run("ci")] }));
    deny("base-tip workflow missing on HEAD^2", PINNED, R({ total_count: 1, workflow_runs: [run("codeql")] }));
    deny("gh times out", PINNED, { gh: { [`repos/o/r/actions/runs?head_sha=${P2}&per_page=100`]: FAIL } });
    deny("gh non-200", PINNED, { gh: { [`repos/o/r/actions/runs?head_sha=${P1}&per_page=100`]: undefined } });
    for (const p of [".github/workflows/ci.yml", "Makefile", "sub/Makefile", ".githooks/pre-commit", "hooks/guard.mjs", "hooks/hooks.json", "x/guard.mjs"]) {
      deny(`banned path ${p}`, PINNED, { git: { [`diff --name-status --no-renames --no-ext-diff --no-textconv ${P1} ${M}`]: `M\tsrc/a.go\nM\t${p}` } });
    }
    for (const p of ["src/a_test.go", "web/a.test.ts", "test/x.mjs", "scripts/x.test.mjs"]) {
      deny(`deleted test ${p}`, PINNED, { git: { [`diff --name-status --no-renames --no-ext-diff --no-textconv ${P1} ${M}`]: `M\tsrc/a.go\nD\t${p}` } });
    }
    for (const m of ["\tt.Skip(\"flaky\")", "it.skip(\"x\", () => {})", "xit(\"x\")", "test(\"x\", { skip: true }, () => {})"]) {
      deny(`added skip ${m}`, PINNED, { git: { [`diff -U0 --no-color --no-ext-diff --no-textconv ${P1} ${M}`]: `+++ b/src/a_test.go\n+${m}` } });
    }
    deny("tree differs from HEAD^2", PINNED, { git: { [`rev-parse ${M}^{tree} ${P2}^{tree}`]: `${T}\n${"f".repeat(40)}` } });
    deny("HEAD^1 is not the remote base tip", PINNED, { git: { [`ls-remote ${ORIGIN} refs/heads/main`]: `${"f".repeat(40)}\trefs/heads/main` } });
    deny("not a two-parent merge", PINNED, { git: { [`rev-list --parents -n 1 ${M}`]: `${M} ${P1}` } });
    deny("no trailer in the last paragraph", PINNED, { git: { [`log -1 --no-show-signature --format=%B ${M}`]: "Merge\n\nReviewed-by: x\n\nCo-Authored-By: X <x@example.com>" } });
    deny("ls-remote times out", PINNED, { git: { [`ls-remote ${ORIGIN} refs/heads/main`]: FAIL } });
    deny("not a GitHub origin", PINNED, { git: { "remote get-url origin": "https://example.com/o/r.git", "remote get-url --push origin": "https://example.com/o/r.git" } });
    deny("from a subagent", PINNED, {}, { ...MAIN, agent_id: "a1", agent_type: "orbit:coder" });
    deny("the target is not origin/HEAD", `git push origin ${M}:refs/heads/main`, { ctx: { originHead: () => "develop" } });
    for (const c of ["git push origin HEAD:main", `git push origin ${M}:main`, `git push origin ${M.slice(0, 12)}:refs/heads/main`, `git push origin ${M}:refs/heads/main && echo ok`,
      `FOO=1 git push origin ${M}:refs/heads/main`, `git push -u origin ${M}:refs/heads/main`, `git push origin +${M}:refs/heads/main`, `sh -c 'git push origin ${M}:refs/heads/main'`,
      `git push upstream ${M}:refs/heads/main`, "git push origin main", `/usr/bin/git push origin ${M}:refs/heads/main`]) {
      deny(c, c);
    }
    assert.match(guard(bash("git push origin HEAD:main"), env, ctx()), /<40-hex sha>:refs\/heads\/main/, "HEAD: names the required form");
  });
});

test("under the go: a literal delete of a merged topic branch is allowed; everything else shared needs the owner; destructive stays denied", () => {
  withGo((env) => {
    assert.equal(guard(bash("git push origin --delete old-topic"), env, ctx()), null);
    assert.equal(kind(guard(bash("git push origin --delete old-topic"), env, ctx({ git: { [`merge-base --is-ancestor ${TIP} ${P1}`]: null } }))), "deny", "not merged");
    assert.equal(kind(guard(bash("git push origin --delete old-topic", { ...MAIN, agent_id: "a1" }), env, ctx())), "deny", "a subagent has no go, and nobody answers its prompt");
    for (const c of ["gh release create v1.0", "gh pr merge 4", "git push origin v1.0", "gh run rerun 1", "git push --tags", "gh pr review 4 --approve"]) {
      const r = guard(bash(c), env, ctx());
      assert.equal(kind(r), "deny", c);
      assert.match(r, /needs the owner/, c);
    }
    const mcp = guard({ ...MAIN, tool_name: "mcp__github__merge_pull_request", tool_input: { owner: "o", repo: "r", pullNumber: 4 } }, env, ctx());
    assert.match(mcp, /needs the owner/);
    for (const c of ["git push -f origin HEAD:topic", "gh release delete v1.0", "git push --delete origin main"]) assert.equal(kind(guard(bash(c), env, ctx())), "deny", c);
    for (const c of ["claude -p 'go on'", "tmux send-keys -t 0 'y' Enter", "screen -X stuff 'y'", "echo y > /dev/pts/3"]) {
      assert.equal(kind(guard(bash(c), env, ctx())), "deny", `under the go: ${c}`);
      assert.equal(kind(guard(bash(c, { ...MAIN, permission_mode: "default" }), env, ctx())), "ask", `attended: ${c}`);
    }
    assert.equal(guard(bash("claude --version"), env, ctx()), null);
    assert.equal(guard(bash("git push origin HEAD:my-topic"), env, ctx({ ctx: { head: () => "my-topic" } })), null, "a topic branch push stays silent");
  });
  // Without a go the pinned push asks like any protected-branch push.
  const h = home();
  try { assert.equal(kind(guard(bash(PINNED), { HOME: h }, ctx())), "ask"); } finally { rmSync(h, { recursive: true, force: true }); }
});

test("every mode: writes to ~/.claude are denied (memory and plan notes excepted), status and check writes are denied, scheduler and message tools cannot carry the command", () => {
  const h = home(), env = { HOME: h };
  try {
    for (const mode of ["default", "bypassPermissions", "dontAsk", undefined]) {
      const who = { session_id: SID, cwd: "/r/merge", ...(mode ? { permission_mode: mode } : {}) };
      const t = (tool_name, tool_input, w = who) => guard({ ...w, tool_name, tool_input }, env, ctx());
      for (const f of [".claude/orbit/unattended/go-sess-1.json", ".claude/settings.json", ".claude/plugins/x/hooks/guard.mjs", ".claude/projects/p/s.jsonl"]) {
        for (const tool of ["Write", "Edit", "MultiEdit"]) assert.equal(kind(t(tool, { file_path: join(h, f) })), "deny", `${mode} ${tool} ${f}`);
        assert.equal(kind(t("Write", { file_path: join(h, f) }, { ...who, agent_id: "a1" })), "deny", `subagent ${f}`);
      }
      assert.equal(kind(t("NotebookEdit", { notebook_path: join(h, ".claude/x.ipynb") })), "deny");
      assert.equal(t("Write", { file_path: join(h, ".claude/projects/p/memory/note.md") }), null, "memory notes stay writable");
      assert.equal(t("Write", { file_path: join(h, ".claude/plans/plan.md") }), null, "plan notes stay writable");
      assert.equal(t("Write", { file_path: join(h, "notes.md") }), null);
      for (const c of [`echo x > ${h}/.claude/orbit/unattended/go-sess-1.json`, "echo x > ~/.claude/settings.json", "cp go.json ~/.claude/orbit/unattended/go-sess-1.json",
        "tee ~/.claude/settings.json < x", "mkdir -p ~/.claude/orbit/unattended", "cd ~/.claude && echo x > settings.json", "node -e \"require('fs').writeFileSync(process.env.HOME + '/.claude/x', '')\"",
        "sh -c 'echo x > ~/.claude/x'", "ln -s /tmp/x ~/.claude/settings.json", "rm -f ~/.claude/orbit/unattended/go-sess-1.json"]) {
        assert.equal(kind(t("Bash", { command: c })), "deny", `${mode} ${c}`);
      }
      for (const c of ["cat ~/.claude/settings.json", "ls ~/.claude", "echo x > /tmp/x"]) assert.notEqual(kind(t("Bash", { command: c })), "deny", `${mode} ${c}`);
      for (const [tool, input] of [["CronCreate", { prompt: "/orbit:unattended on 24h", cron: "0 1 * * *" }], ["ScheduleWakeup", { prompt: "run /orbit:unattended confirm X" }],
        ["SendMessage", { to: "s2", message: "/orbit:unattended on" }], ["RemoteTrigger", { body: { text: "/ORBIT:UNATTENDED on" } }], ["mcp__peers__send", { text: "/orbit:unattended on" }], ["SlashCommand", { command: "/orbit:unattended on 24h" }]]) {
        assert.equal(kind(t(tool, input)), "deny", `${mode} ${tool}`);
      }
      assert.equal(t("CronCreate", { prompt: "/loop check CI", cron: "*/5 * * * *" }), null);
      assert.equal(t("SendMessage", { to: "s2", message: "merged" }), null);
    }
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test("while a code is pending: reads of ~/.claude and the transcripts are denied; after expiry they are not", () => {
  const h = home(), env = { HOME: h }, tty = terminal();
  try {
    const who = { session_id: "s9", cwd: "/r/merge", permission_mode: "default" };
    const t = (tool_name, tool_input) => guard({ ...who, tool_name, tool_input }, env, ctx());
    assert.equal(t("Read", { file_path: join(h, ".claude/projects/p/s.jsonl") }), null, "nothing pending");
    onPrompt(prompt("/orbit:unattended on 1h", { session_id: SID }), env, { now: () => Date.now(), tty: tty.io().tty });
    for (const [tool, input] of [["Read", { file_path: join(h, ".claude/projects/p/s.jsonl") }], ["Grep", { pattern: "confirm", path: join(h, ".claude") }], ["Glob", { pattern: "**/*.jsonl", path: join(h, ".claude/projects") }]]) {
      assert.equal(kind(t(tool, input)), "deny", tool);
    }
    for (const c of ["cat ~/.claude/projects/p/s.jsonl", "grep -r confirm ~/.claude", "tail -n 5 $HOME/.claude/projects/p/s.jsonl", "tmux capture-pane -p", "screen -X hardcopy /tmp/x"]) {
      assert.equal(kind(t("Bash", { command: c })), "deny", c);
    }
    assert.equal(t("Read", { file_path: "/r/merge/README.md" }), null);
    assert.equal(t("Bash", { command: "ls /r/merge" }), null);
    const later = join(stateDir(h), `pending-${SID}.json`);
    writeFileSync(later, JSON.stringify({ ...JSON.parse(readFileSync(later, "utf8")), expires: Date.now() - 1 }));
    assert.equal(t("Read", { file_path: join(h, ".claude/projects/p/s.jsonl") }), null, "expired: reads are back");
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test("capture: an allowed go action is recorded as class go with the sha; without a go it stays shared", () => {
  withGo((env) => {
    const ev = { ...MAIN, tool_name: "Bash", tool_input: { command: PINNED }, tool_response: { exit_code: 0 } };
    const [e, ...rest] = outwardEvents(ev, () => ctx(), env);
    assert.deepEqual(rest, []);
    assert.ok(e.argv.includes("class=go") && e.argv.includes(`sha=${M}`), e.argv.join(" "));
    const del = outwardEvents({ ...ev, tool_input: { command: "git push origin --delete old-topic" } }, () => ctx(), env);
    assert.ok(del[0].argv.includes("class=go"), del[0].argv.join(" "));
    const sub = outwardEvents({ ...ev, agent_id: "a1" }, () => ctx(), env);
    assert.ok(sub[0].argv.includes("class=shared"), "a subagent never has a go");
  });
});

test("hooks.json: the prompt hook runs on UserPromptSubmit; the guard matcher covers reads, schedulers and message tools", () => {
  const h = JSON.parse(readFileSync(join(repo, "hooks/hooks.json"), "utf8")).hooks;
  assert.ok(h.UserPromptSubmit.some((e) => e.hooks.some((x) => x.command.includes("hooks/unattended.sh"))));
  const m = h.PreToolUse.find((e) => e.hooks.some((x) => x.command.includes("hooks/guard"))).matcher.split("|");
  for (const name of ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "Read", "Grep", "Glob", "mcp__.*", ".*Cron.*", ".*Schedule.*", ".*Wakeup.*", ".*Trigger.*", ".*Message.*", ".*Skill.*", "SlashCommand"]) assert.ok(m.includes(name), name);
  assert.ok(existsSync(join(repo, "commands/unattended.md")), "the command file exists, so the slash command is not rejected before the hook");
});

// ---------- full review of 0.21.0 (Orbit #16) ----------
test("#16 finding 1: the go's evidence reads the URL the push uses; a pushurl or pushInsteadOf that differs denies", () => {
  withGo((env) => {
    assert.equal(guard(bash(PINNED), env, ctx()), null, "same URL: allowed");
    for (const u of ["git@github.com:evil/r.git", "https://github.com/o/r.git", "https://example.com/o/r.git"]) {
      assert.equal(kind(guard(bash(PINNED), env, ctx({ git: { "remote get-url --push origin": u } }))), "deny", u);
    }
    assert.equal(kind(guard(bash(PINNED), env, ctx({ git: { "remote get-url --push origin": FAIL } }))), "deny", "push URL unreadable");
    // The base tip is read from the push URL, not from the name origin.
    assert.equal(kind(guard(bash(PINNED), env, ctx({ git: { [`ls-remote ${ORIGIN} refs/heads/main`]: undefined, "ls-remote origin refs/heads/main": `${P1}\trefs/heads/main` } }))), "deny");
    assert.equal(guard(bash("git push origin --delete old-topic"), env, ctx()), null);
    assert.equal(kind(guard(bash("git push origin --delete old-topic"), env, ctx({ git: { "remote get-url --push origin": "git@github.com:evil/r.git" } }))), "deny", "delete: push URL differs");
  });
});

test("#16 finding 2: a dangling link to the go file (or into ~/.claude) is a ~/.claude write; ln and cp -s to ~/.claude are denied", () => {
  const h = home(), env = { HOME: h }, w = realpathSync(mkdtempSync(join(tmpdir(), "orbit-wt-")));
  const goFile = join(stateDir(h), `go-${SID}.json`);
  try {
    symlinkSync(goFile, join(w, "link"));                 // ~/.claude/orbit/unattended does not exist: the link dangles
    symlinkSync(join(h, ".claude"), join(w, "cl"));        // ~/.claude does not exist either
    symlinkSync("link", join(w, "link2"));                 // a relative link to the link
    symlinkSync("loop", join(w, "loop"));                  // cannot be resolved: treated as protected
    const body = JSON.stringify({ session_id: SID, opened: 1, until: 2 });
    for (const mode of ["default", "bypassPermissions", "dontAsk"]) {
      const who = { session_id: SID, cwd: w, permission_mode: mode };
      const t = (tool_name, tool_input) => guard({ ...who, tool_name, tool_input }, env, ctx());
      for (const c of [`printf '%s' '${body}' > link`, `printf x > ${w}/link`, "echo x > link2", "tee link < /dev/null", "cp x link", "echo x > cl/orbit/unattended/go-sess-1.json", "echo x > loop",
        `ln -s ${goFile} /tmp/x`, "ln -s ~/.claude/orbit/unattended/go-sess-1.json here", "ln -sf ~/.claude/settings.json here", "ln ~/.claude/settings.json here", `cp -s ${goFile} here`, "cp --symbolic-link ~/.claude/x here", "ln -s ~/.claude here"]) {
        assert.equal(kind(t("Bash", { command: c })), "deny", `${mode} ${c}`);
      }
      for (const f of ["link", join(w, "link"), join(w, "link2"), join(w, "cl/orbit/unattended/go-sess-1.json"), join(w, "loop")]) {
        for (const tool of ["Write", "Edit"]) assert.equal(kind(t(tool, { file_path: f })), "deny", `${mode} ${tool} ${f}`);
      }
      assert.equal(t("Bash", { command: "ln -s /tmp/a here" }), null, "a link outside ~/.claude stays allowed");
      assert.equal(t("Write", { file_path: join(w, "plain.txt") }), null);
    }
    assert.ok(!existsSync(goFile), "no go file");
    assert.equal(goState({ session_id: SID, permission_mode: "bypassPermissions" }, env), null, "no go armed");
  } finally { rmSync(h, { recursive: true, force: true }); rmSync(w, { recursive: true, force: true }); }
});

test("#16 finding 5: a git whose grandchild holds stdout cannot hold the guard past the evidence deadline", () => {
  // The stub lives in the checkout (CI mounts /tmp noexec); a temp dir links it as `git`.
  const bin = realpathSync(mkdtempSync(join(tmpdir(), "orbit-bin-")));
  symlinkSync(join(repo, "scripts/fixtures/git-hang-stub.sh"), join(bin, "git"));
  const live = realCtx(repo, {});
  const path = process.env.PATH;
  try {
    withGo((env) => {
      process.env.PATH = `${bin}:${path}`;
      process.env.GIT_STUB_PIDS = join(bin, "pids");
      const t0 = Date.now();
      const r = guard(bash(PINNED), env, ctx({ ctx: { evidence: () => live.evidence() } }));
      const ms = Date.now() - t0;
      process.env.PATH = path;
      assert.equal(kind(r), "deny", JSON.stringify(r));
      assert.ok(ms < EVIDENCE_MS + 2000, `took ${ms} ms`);
      // The grandchild is gone too (its process group was killed): no ssh left connecting after the hook answered.
      const pid = Number(readFileSync(join(bin, "pids"), "utf8").trim().split("\n")[0]);
      const alive = () => { try { return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return false; } };
      const until = Date.now() + 2000;
      while (alive() && Date.now() < until) { /* reaping takes a moment */ }
      assert.ok(!alive(), `grandchild ${pid} still runs`);
    });
  } finally { process.env.PATH = path; delete process.env.GIT_STUB_PIDS; rmSync(bin, { recursive: true, force: true }); }
  const g = JSON.parse(readFileSync(join(repo, "hooks/hooks.json"), "utf8")).hooks.PreToolUse.flatMap((e) => e.hooks).find((x) => x.command.includes("hooks/guard"));
  assert.equal(g.onFailure, "block", "a guard timeout blocks the call");
});

test("#16 findings 6, 7, 8: the go's base, trailer key and required checks come from the main checkout's profile", () => {
  withGo((env) => {
    const P = (o) => ({ ctx: { profile: () => ({ base: "main", pusher: "agent", trailer: "Reviewed-by", protected: [], checks: [], ...o }) } });
    const msg = (key) => ({ [`log -1 --no-show-signature --format=%B ${M}`]: `Merge\n\n${key}: reviewer\nCo-Authored-By: X <x@example.com>` });
    const deny = (label, over) => assert.equal(kind(guard(bash(PINNED), env, ctx(over))), "deny", label);
    // 6: <base> must be the profile's base_branch and origin/HEAD's target.
    deny("profile base differs from origin/HEAD", P({ base: "develop" }));
    deny("no profile", { ctx: { profile: () => null } });
    deny("profile without a base", P({ base: null }));
    // 7: the trailer key is the profile's; Reviewed-by only when it names none.
    deny("profile names Security-Review, message has Reviewed-by", P({ trailer: "Security-Review" }));
    assert.equal(guard(bash(PINNED), env, ctx({ ...P({ trailer: "Security-Review" }), git: msg("Security-Review") })), null, "the profile's key passes");
    assert.equal(guard(bash(PINNED), env, ctx(P({ trailer: null }))), null, "no profile trailer: Reviewed-by");
    // 8: the base tip needs at least one green workflow; HEAD^2 also covers the profile's required checks.
    const tip = (o) => ({ [`repos/o/r/actions/runs?head_sha=${P1}&per_page=100`]: o });
    deny("base tip without runs", { gh: tip({ total_count: 0, workflow_runs: [] }) });
    deny("base tip without a green run", { gh: tip({ total_count: 1, workflow_runs: [run("ci", { head_sha: P1, conclusion: "failure" })] }) });
    deny("a required check missing on HEAD^2", P({ checks: ["lint"] }));
    assert.equal(guard(bash(PINNED), env, ctx(P({ checks: ["codeql"] }))), null, "a required check green on HEAD^2");
  });
});

test("#16 finding 9: capture writes the go's actions to the go log under ~/.claude, which the guard protects", () => {
  withGo((env, h) => {
    const log = join(stateDir(h), "go-log.jsonl");
    const ev = { ...MAIN, tool_name: "Bash", tool_input: { command: PINNED }, tool_response: { exit_code: 0 } };
    goLog(ev, outwardEvents(ev, () => ctx(), env), env);
    const sub = { ...ev, agent_id: "a1" };
    goLog(sub, outwardEvents(sub, () => ctx(), env), env);
    const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 1, "a subagent's push is no go action");
    assert.deepEqual({ ...lines[0], ts: undefined }, { ts: undefined, session: SID, subcommand: "push", ref: "main", sha: M, exit_code: 0 });
    assert.equal(kind(guard(bash(`echo '{}' >> ${log}`), env, ctx())), "deny");
  });
});

// ---------- fix-round 2 re-review of 0.21.0 (Orbit #20) ----------
test("#20 row 1: a gh placeholder in a GraphQL query is shared when attended and denied under the go; the tracker's --plan commands stay silent", () => {
  const attack = "GH_REPO=x/mergePullRequest gh api graphql -F query='mutation{updateIssueIssueType(input:{}){issue{id}} {repo}(input:{pullRequestId:\"PR_x\"}){pullRequest{id}}}'";
  const attended = { ...MAIN, permission_mode: "default" };
  withGo((env) => {
    for (const c of [attack, "gh api graphql -F query='mutation{updateIssueIssueType(input:{}){issue{id}} {owner}(input:{}){x{id}}}'", "gh api graphql -F query='mutation{createProjectV2(input:{title:\":branch\"}){projectV2{id}}}'"]) {
      assert.equal(kind(guard(bash(c, attended), env, ctx())), "ask", `attended: ${c}`);
      const r = guard(bash(c), env, ctx());
      assert.equal(kind(r), "deny", `under the go: ${c}`);
      assert.match(r, /needs the owner/, c);
    }
    const all = { issues: true, labels: true, milestones: true, issue_types: true, projects: true };
    const cmds = plan({ repo: "o/r" }, all, "M1 plan", ["core"]).filter((l) => l.startsWith("gh ")).map((l) => l.replace(/<[^>]*>/g, "X"));
    assert.ok(cmds.some((c) => c.includes("graphql")), "the plan holds the issue type mutation");
    for (const c of cmds) assert.equal(guard(bash(c, attended), env, ctx()), null, c);
  });
});

test("#20 row 4: attached -f/-F query forms are read; a gh api graphql whose query the guard did not read is shared", () => {
  const attended = { ...MAIN, permission_mode: "default" };
  withGo((env) => {
    for (const c of ["gh api graphql -fquery='mutation{mergePullRequest(input:{pullRequestId:\"x\"}){clientMutationId}}'", "gh api graphql -Fquery=@file",
      "gh api graphql -Fquery='mutation{mergePullRequest(input:{pullRequestId:\"x\"}){clientMutationId}}'", "gh api graphql", "gh api graphql -f q='mutation{x}'"]) {
      assert.equal(kind(guard(bash(c, attended), env, ctx())), "ask", `attended: ${c}`);
      assert.equal(kind(guard(bash(c), env, ctx())), "deny", `under the go: ${c}`);
    }
    assert.equal(kind(guard(bash("gh api graphql -fquery='mutation{deleteRef(input:{refId:\"x\"}){clientMutationId}}'", attended), env, ctx())), "deny", "attached form reaches the deleteRef denial");
    assert.equal(kind(guard(bash("gh api graphql -fquery='query{viewer{login}}'", attended), env, ctx())), "ask", "an attached field is not an exact shape (#21)");
    assert.equal(guard(bash("gh api graphql -f query='query{viewer{login}}'", attended), env, ctx()), null, "a read query stays silent");
  });
});

test("#20 row 2: a link hop resolves against the link's real directory; an ln -s relative target resolves against the link's directory", () => {
  const h = home(), env = { HOME: h }, w = realpathSync(mkdtempSync(join(tmpdir(), "orbit-wt-")));
  try {
    mkdirSync(join(h, "x", "y"), { recursive: true });
    mkdirSync(join(h, "proj"));
    symlinkSync(join(h, "x", "y"), join(w, "a"));                                   // w/a -> a real dir two levels deep in HOME
    symlinkSync(`../../.claude/orbit/unattended/go-${SID}.json`, join(h, "x", "y", "l"));   // dangling; from x/y, ../../ is HOME
    for (const mode of ["default", "bypassPermissions"]) {
      const t = (command, cwd = w) => guard({ session_id: SID, cwd, permission_mode: mode, tool_name: "Bash", tool_input: { command } }, env, ctx());
      for (const c of ["echo x > a/l", `printf x > ${w}/a/l`]) assert.equal(kind(t(c)), "deny", `${mode} ${c}`);
      assert.equal(kind(t(`ln -s ../.claude/orbit/unattended/go-${SID}.json ${h}/proj/l`)), "deny", `${mode} ln -s from another cwd`);
      assert.equal(kind(t(`ln -s ../.claude/orbit/unattended/go-${SID}.json ${h}/proj`)), "deny", `${mode} ln -s into a directory`);
      assert.equal(kind(t(`ln -s ../notes.md ${h}/proj/l`)), "ask", `${mode} a relative target with .. is shared (#21)`);
    }
  } finally { rmSync(h, { recursive: true, force: true }); rmSync(w, { recursive: true, force: true }); }
});

// ---------- fix-round 3 re-review of 0.21.0 (Orbit #21): allowlists that fail closed ----------
const MERGE_PR = "{mergePullRequest(input:{pullRequestId:\"x\"}){clientMutationId}}";
const DEL_REF = "(input:{refId:\"x\"}){clientMutationId}}";
const attendedAsk = (env, cmds, who = { ...MAIN, permission_mode: "default" }) => {
  for (const c of cmds) {
    assert.equal(kind(guard(bash(c, who), env, ctx())), "ask", `attended: ${c}`);
    assert.match(guard(bash(c, { ...who, permission_mode: "bypassPermissions" }), env, ctx()), /needs the owner/, `under the go: ${c}`);
  }
};

test("#21 row 1: a gh placeholder that supplies mutation or deleteRef is shared, never silent", () => {
  withGo((env) => attendedAsk(env, [
    `GH_REPO=mutation/x gh api graphql -F query='{owner}${MERGE_PR}'`,
    `GH_REPO=mutation/x gh api graphql -F query=':owner${MERGE_PR}'`,
    `GH_REPO=x/mutation gh api graphql -F query='{repo}${MERGE_PR}'`,
    `gh api graphql -F query='{branch}${MERGE_PR}'`,
    `GH_REPO=mutation/deleteRef gh api graphql -F query='{owner}{{repo}${DEL_REF}'`,
    `GH_REPO=x/deleteRef gh api graphql -F query='mutation{{repo}${DEL_REF}'`,
    `gh api graphql -F query=':owner{{branch}${DEL_REF}'`,
  ]));
});

test("#21 row 2: ln -s with a target directory in any spelling, or a relative target with .., is shared", () => {
  const h = home(), env = { HOME: h }, w = realpathSync(mkdtempSync(join(tmpdir(), "orbit-wt-")));
  try {
    mkdirSync(join(h, "proj"));
    mkdirSync(stateDir(h), { recursive: true });
    writeFileSync(join(stateDir(h), `go-${SID}.json`), JSON.stringify({ session_id: SID, opened: Date.now() - 1000, until: Date.now() + 3600_000 }));
    const g = `../.claude/orbit/unattended/go-${SID}.json`, d = `${h}/proj`;
    attendedAsk(env, [`ln -s --target-directory ${d} ${g}`, `ln -s -t${d} ${g}`, `ln -st ${d} ${g}`, `ln -s --target=${d} ${g}`, `cp -s --target-directory ${d} ${g}`,
      `ln -s ../notes.md ${d}/l`], { session_id: SID, cwd: w, permission_mode: "default" });
    assert.equal(kind(guard(bash(`ln -s -t ${d} ${g}`, { session_id: SID, cwd: w, permission_mode: "default" }), env, ctx())), "deny", "-t DIR resolves into ~/.claude");
  } finally { rmSync(h, { recursive: true, force: true }); rmSync(w, { recursive: true, force: true }); }
});

test("#21 row 3: a clustered short flag carrying the query beside a decoy read is shared", () => {
  withGo((env) => {
    attendedAsk(env, [`gh api graphql -iFquery='mutation${MERGE_PR}' -f query='query{viewer{login}}'`, `gh api graphql -f query='query{viewer{login}}' -iFquery='mutation${MERGE_PR}'`]);
    assert.equal(kind(guard(bash(`gh api graphql -iFquery='mutation{deleteRef${DEL_REF}' -f query='query{viewer{login}}'`, { ...MAIN, permission_mode: "default" }), env, ctx())), "deny", "a destructive name keeps its class");
  });
});

test("#21 row 4: /graphql, the full URL and GRAPHQL are the GraphQL endpoint", () => {
  withGo((env) => {
    const eps = ["/graphql", "https://api.github.com/graphql", "GRAPHQL"];
    attendedAsk(env, eps.map((e) => `gh api ${e} -f query='mutation${MERGE_PR}'`));
    for (const e of eps) assert.equal(kind(guard(bash(`gh api ${e} -f query='mutation{deleteRef${DEL_REF}'`, { ...MAIN, permission_mode: "default" }), env, ctx())), "deny", `deleteRef via ${e}`);
  });
});

test("#21: the tracker --plan lines, a plain read query and a plain link in the repo stay silent", () => {
  withGo((env) => {
    const who = { ...MAIN, permission_mode: "default" };
    const all = { issues: true, labels: true, milestones: true, issue_types: true, projects: true };
    const cmds = plan({ repo: "o/r" }, all, "M1 plan", ["core"]).filter((l) => l.startsWith("gh ")).map((l) => l.replace(/<[^>]*>/g, "X"));
    assert.ok(cmds.length >= 4 && cmds.some((c) => c.includes("graphql")));
    for (const c of [...cmds, "gh api graphql -f query='query{viewer{login}}'"]) assert.equal(guard(bash(c, who), env, ctx()), null, c);
    assert.equal(guard(bash("ln -s a b", { ...who, cwd: repo }), env, ctx()), null, "ln -s a b in the repo");
  });
});

// ---------- fix-round 4 re-review of 0.21.0 (Orbit #22): what the guard cannot read exactly is shared ----------
const QV = "-f query='query{viewer{login}}'";
test("#22 row 1: a control character in a gh api argument is shared; a read query holds no # and no mutation", () => {
  withGo((env) => attendedAsk(env, [
    `gh api graphql -f query='query A{viewer{login}}#\rmutation B${MERGE_PR}' -f operationName=B`,
    "gh api graphql -f query='query{viewer{login}}' -f x='a\rb'",
    "gh api repos/o/r/issues -f body='a\u0001b'",
    "gh api graphql -f query='query{viewer{login}} # mutation'",
    "gh api graphql -f query='{viewer{login}} #'",
  ]));
});

test("#22 row 2: a clustered or unknown flag in gh api is shared; graphql in any positional is read; odd endpoint spellings are shared", () => {
  withGo((env) => {
    attendedAsk(env, [
      `gh api -iX POST graphql -f query='mutation${MERGE_PR}'`,
      `gh api -iq .x graphql -f query='mutation${MERGE_PR}'`,
      `gh api -iH 'Accept: x' graphql -f query='mutation${MERGE_PR}'`,
      `gh api -ip x graphql -f query='mutation${MERGE_PR}'`,
      `gh api -it x graphql -f query='mutation${MERGE_PR}'`,
      `gh api /%67raphql -f query='mutation${MERGE_PR}'`,
      `gh api https://api.github.com/./graphql -f query='mutation${MERGE_PR}'`,
      `gh api ./graphql -f query='mutation${MERGE_PR}'`,
      `gh api repos/o/r//pulls/1/merge -X PUT`,
      `gh api repos/o/r/../r/pulls/1/merge -X PUT`,
    ]);
    const who = { ...MAIN, permission_mode: "default" };
    assert.equal(kind(guard(bash(`gh api -iX POST graphql -f query='mutation{deleteRef${DEL_REF}'`, who), env, ctx())), "deny", "a destructive name keeps its class");
    for (const c of ["gh api repos/o/r/pulls", "gh api -i repos/o/r", "gh api --paginate repos/o/r/issues --jq .[].number", "gh api repos/o/r -q .name"]) assert.equal(guard(bash(c, who), env, ctx()), null, c);
  });
});

test("#22 row 3: xargs, find, fd and parallel around gh api are shared", () => {
  withGo((env) => {
    // In a pipe the shared finding is not alone in its call: denied.
    assert.equal(kind(guard(bash(`printf -- --input m.json | xargs gh api graphql ${QV}`, { ...MAIN, permission_mode: "default" }), env, ctx())), "deny");
    attendedAsk(env, [
      `xargs -a args.txt gh api graphql ${QV}`,
      `find . -exec gh api graphql ${QV} {} +`,
      `find . -exec gh api graphql ${QV} \\;`,
      `parallel gh api graphql ${QV} ::: a`,
      `fd -x gh api graphql ${QV}`,
      "xargs -a args.txt gh api repos/o/r/issues",
    ]);
  });
});

test("#22 row 4: a glob in an ln/cp operand or a write target is shared; one that can match under ~/.claude is denied", () => {
  withGo((env, h) => {
    const who = { ...MAIN, cwd: h, permission_mode: "default" };
    for (const c of ["echo x > ~/.claud?/settings.json", "ln ~/.claud*/x ~/s", "ln ~/.claud?/settings.json ~/s", "cp -l ~/.c[l]aude/settings.json ~/s",
      "ln -s ~/.claude/{a,settings.json} ~/s", "echo x > ~/**/settings.json", "touch .claud?/x"]) assert.equal(kind(guard(bash(c, who), env, ctx())), "deny", c);
    attendedAsk(env, ["echo x > /tmp/o?.txt", "ln /tmp/a* ~/s", "cp /tmp/a[0-9] ~/s", "rm ~/x/*.log", "ln -s /tmp/{a,b} ~/s"], who);
    for (const c of ["ls *.md", "cat ~/.claude/*.json | head", "ln -s a b"]) assert.equal(guard(bash(c, { ...who, cwd: repo }), env, ctx()), null, c);
  });
});

test("#22 row 5: gh extension exec, install and upgrade are shared", () => {
  withGo((env) => attendedAsk(env, ["gh extension exec x", "gh extension install o/r", "gh extension upgrade x"]));
});

test("#22: the tracker --plan lines and a plain read query stay silent", () => {
  withGo((env) => {
    const who = { ...MAIN, permission_mode: "default" };
    const all = { issues: true, labels: true, milestones: true, issue_types: true, projects: true };
    const cmds = plan({ repo: "o/r" }, all, "M1 plan", ["core"]).filter((l) => l.startsWith("gh ")).map((l) => l.replace(/<[^>]*>/g, "X"));
    for (const c of [...cmds, `gh api graphql ${QV}`]) assert.equal(guard(bash(c, who), env, ctx()), null, c);
  });
});
