// Unattended go (Orbit 0.21.0, security conditions 1-9; opened with a permission prompt since 0.21.2, #38). The one test: the
// exact `node <plugin root>/hooks/unattended.mjs on [dur]` asks in every mode, for every session kind, and every other command
// naming the script is denied, so no go opens without the owner's answer to a prompt. With a hand-written valid go, every
// base-push spelling that lacks the evidence is denied; the pinned sha with full evidence is allowed and captured as class `go`.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { FAIL, guard, parseShell, realCtx } from "../hooks/guard.mjs";
import { EVIDENCE_MS, goState } from "../hooks/go.mjs";
import { unattended } from "../hooks/unattended.mjs";
import { goLog, outwardEvents } from "../hooks/capture.mjs";
import { plan } from "./tracker.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const SID = "sess-1";
const home = () => realpathSync(mkdtempSync(join(tmpdir(), "orbit-home-")));
const stateDir = (h) => join(h, ".claude/orbit/unattended");
const files = (h) => (existsSync(stateDir(h)) ? readdirSync(stateDir(h)) : []);
const kind = (r) => (r === null ? "allow" : typeof r === "string" ? "deny" : "ask");
const SCRIPT = realpathSync(join(repo, "hooks/unattended.mjs"));

test("the one test, part 1: only the exact on command opens a go, and it asks in every mode for every session kind", () => {
  const h = home(), env = { HOME: h };
  try {
    const kinds = { main: {}, operator: { agent_type: "orbit:operator" }, agent: { agent_id: "a1", agent_type: "orbit:coder" } };
    for (const mode of ["default", "acceptEdits", "plan", "auto", "bypassPermissions", "dontAsk"]) {
      for (const [k, extra] of Object.entries(kinds)) {
        const who = { session_id: SID, cwd: repo, permission_mode: mode, ...extra };
        const g = (command) => guard({ ...who, tool_name: "Bash", tool_input: { command } }, env, ctx());
        const on = g(`node "${SCRIPT}" on 8h`);
        assert.equal(kind(on), "ask", `${mode} ${k}: ${JSON.stringify(on)}`);
        assert.match(on.ask, /open an unattended go of 480 minutes for this session/);
        assert.match(g(`node ${SCRIPT} on`).ask, /of 720 minutes/, `${mode} ${k}: default 12 h`);
        assert.match(g(`node "${SCRIPT}" on 90m`).ask, /of 90 minutes/);
        assert.equal(kind(g(`node ${join(repo, "hooks/../hooks/unattended.mjs")} on 8h`)), "ask", `${mode} ${k}: another spelling of the same file still asks`);
        for (const sub of ["off", "status"]) assert.equal(g(`node "${SCRIPT}" ${sub}`), null, `${mode} ${k}: ${sub} runs silently`);
        assert.equal(g(`node "${SCRIPT}"`), null, `${mode} ${k}: no argument prints the usage`);
        for (const d of ["0m", "9999h", "25h"]) assert.match(g(`node "${SCRIPT}" on ${d}`), /usage: \/orbit:unattended/, `${mode} ${k}: on ${d} is refused with the usage`);
        // The command as Claude Code renders commands/unattended.md: ${CLAUDE_PLUGIN_ROOT} substituted, $ARGUMENTS as typed (#38).
        const tpl = /`(node "\$\{CLAUDE_PLUGIN_ROOT\}[^`]*)`/.exec(readFileSync(join(repo, "commands/unattended.md"), "utf8"))[1].replace("${CLAUDE_PLUGIN_ROOT}", repo);
        assert.equal(kind(g(tpl.replace("$ARGUMENTS", "on 8h"))), "ask", `${mode} ${k}: the rendered command asks`);
        assert.equal(g(tpl.replace(" $ARGUMENTS", "")), null, `${mode} ${k}: the rendered bare command prints the usage`);
        // Respellings of the script path (#38): each asks or is denied, never runs silently.
        for (const c of [`node ${repo}/hooks/unattended''.mjs on 24h`, `node ${repo}/hooks/unatt"ended".mjs on 24h`, `node ${repo}/hooks/unattended.m?s on 24h`,
          `node ${repo}/hooks/unattended\\.mjs on 24h`, `node $'${repo}/hooks/unattended\\x2emjs' on 24h`, `ln -s ${repo}/hooks/unattende?.mjs /tmp/x.mjs; node /tmp/x.mjs on 24h`,
          `node ${repo}/hooks/unatt*.mjs on 24h`, `bun ${repo}/hooks/unattende[d].mjs on 24h`]) {
          assert.ok(["ask", "deny"].includes(kind(g(c))), `${mode} ${k}: ${c}`);
        }
        // Nested in sh -c, eval or find (#38): denied, never asked (the prompt would not show the real command).
        for (const c of [`bash -c "node ${repo}/hooks/unattended''.mjs on 24h"`, `bash -c 'node ${repo}/hooks/unattende?.mjs on 24h'`, `eval "node ${repo}/hooks/unattende''d.mjs on 24h"`,
          `bash -c 'node ${SCRIPT} on 8h'`, `find ${repo}/hooks -name 'unattende?.mjs' -exec node {} on 24h \\;`, `find ${repo} -path '*/hooks/unatt*' -exec node {} on 24h +`,
          `find ${repo}/hooks -execdir bun {} on 24h \\;`, `find ${repo}/hooks -iname 'UNATT*' | xargs -I{} node {} on 24h`,
          // Unparsable text (#38): the script next to a runtime is denied; find operators and exec wrappers do not hide it.
          `node ${repo}/hooks/unattended''.mjs on 24h; x=(a)`, `a=(1); node ${repo}/hooks/unattende?.mjs on 24h`, `bash -c 'a=(1); node ${repo}/hooks/unattende?.mjs on 24h'`,
          `eval 'a=(1); node ${repo}/hooks/unattende?.mjs on 24h'`, `a=(1); node ${repo}/hooks/u*.mjs on 24h`,
          `find ${repo}/hooks -name '*.test.mjs' -prune -o -exec node {} on 24h \\;`, `find ${repo}/hooks ! -name zz -exec node {} on 24h \\;`,
          `find ${repo}/hooks -not -name zz -exec node {} on 24h \\;`, `find ${repo}/hooks -name zz -o -exec node {} on 24h \\;`, `find ${repo}/hooks -name zz , -exec node {} on 24h \\;`,
          `a=(1); node ${repo}/hooks/una\\\ntt*.mjs on 24h`, `a=(1); no\\\nde ${repo}/hooks/unatt*.mjs on 24h`, `a=(1); node $'${repo}/hooks/\\165nattended.mjs' on 24h`, `a=(1); node $'${repo}/hooks/\\x75nattended.mjs' on 24h`,
          `find ${repo}/hooks -name 'unattende?.mjs' -exec timeout 9 node {} on 24h \\;`, `find ${repo}/hooks -name 'unattende?.mjs' -exec command node {} on 24h \\;`,
          `find ${repo}/hooks -name 'unattende?.mjs' -exec env node {} on 24h \\;`, `find ${repo}/hooks -name 'unattende?.mjs' -exec nice node {} on 24h \\;`,
          `find ${repo}/hooks -name 'unattende?.mjs' -exec xargs node \\;`,
          // A word split by an empty expansion, or an extglob group, is still the script name (#38).
          ...['unattended$"".mjs', 'unattended.mj$"s"', "unattended$().mjs", "unattended.m$()js", "$(echo unattended).mjs", "`echo unattended`.mjs", "@(unattended).mjs",
            "unattended${x}.mjs", "unattended$x.mjs", "unattended${x:-}.mjs"].map((f) => `a=(1); node ${repo}/hooks/${f} on 24h`),
          `a=(1)\nshopt -s extglob\nnode ${repo}/hooks/+(unattended).mjs on 24h`, `shopt -s extglob\nnode ${repo}/hooks/@(unattended).mjs on 24h`,
          // Unparsable text that names the hooks folder (or unatt) and a runtime is denied whatever the spelling, with no stem or glob logic (#38).
          ...['@(zz|u*).mjs', '*(zz|u*)', '+(zz|u*)', '?(zz|u*)nattended.mjs', '@(zz|[u]*).mjs', '@(zz|u?attended).mjs', '@(zz|u)nattended.mjs', 'u@(n|x)attended.mjs',
            '@(u|x)n@(a|x)ttended.mjs', '!(zz|guard*|[a-t]*).mjs', 'una$"tt"ended.mjs', 'u$"n"attended.mjs', 'una$()ttended.mjs', 'una`true`ttended.mjs'].map((f) => `a=(1)\nshopt -s extglob\nnode ${repo}/hooks/${f} on 24h`),
          `a=(1)\ncd ${repo}/hooks\nnode @(zz|u*).mjs on 24h`, `shopt -s extglob\nbash -c "a=(1); node ${repo}/hooks/@(zz|u*).mjs on 24h"`, "a=(1); cd hooks; node $(echo x).mjs",
          // A script path with a glob or an expansion, in an unparsable command or a parsed one, is denied (#38).
          ...['ho$"o"ks/@(zz|u*).mjs', 'h?oks/@(zz|u*).mjs', 'ho*s/u*.mjs', 'h?oks/u*.mjs', '[h]ooks/[u]nattended.mjs', 'h{o,p}oks/@(zz|u*).mjs', 'h$()ooks/@(zz|u*).mjs',
            '*/u*.mjs', '?ooks/?nattended.mjs', 'ho$"o"ks/una$"tt"ended.mjs'].map((f) => `a=(1); cd /tmp; node ${repo}/${f} on 24h`),
          ...['una$()ttended.mjs', 'una$"tt"ended.mjs', 'u$"n"attended.mjs', 'una$(echo)ttended.mjs'].map((f) => `node ${repo}/hooks/${f} on 24h`),
          `shopt -s nocaseglob\nnode ${repo}/hooks/U*.MJS on 24h`, `a=(1); shopt -s nocaseglob\nnode ${repo}/hooks/U*.MJS on 24h`, `shopt -s nocaseglob\nnode U*.MJS on 24h`]) {
          assert.equal(kind(g(c)), "deny", `${mode} ${k}: ${c}`);
        }
        // A glob that cannot match unattended.mjs, or a variable operand, is not the go's command: this rule does not deny it.
        for (const c of ["node --test scripts/*.test.mjs", "node --check scripts/*.test.mjs", "cd hooks && node --test *.test.mjs", 'node "$HOME/x.mjs"',
          'node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs"', 'node "$X" on 24h', "find . -name '*.test.mjs' -exec node --test {} +", "x=(a); node --test scripts/*.test.mjs", "a=(1); ls hooks", "bash -c 'a=(1); node --check x.mjs'",
          // An unparsable command naming neither hooks nor unatt is left alone (one that does is denied by design: see the denies above).
          "a=(1); node --test scripts/guard.test.mjs", "a=(1); git log --oneline | head; node --version", "a=(1); grep -n go README.md && node -v"]) {
          const r = g(c);
          assert.doesNotMatch(String(r?.ask ?? r ?? ""), /unattended go's script/, `${mode} ${k}: ${c}`);
        }
        for (const c of [`node "${SCRIPT}" on 8h extra`, `node "${SCRIPT}" on 8h --force`, `node "${SCRIPT}" on 30x`, `node "${SCRIPT}" confirm ABCD`, `node "${SCRIPT}" off now`,
          `node --no-warnings "${SCRIPT}" on 8h`, "node /tmp/x/hooks/unattended.mjs on 8h", "node hooks/unattended.mjs on 8h", `node "${SCRIPT}.bak" on 8h`,
          `FOO=1 node "${SCRIPT}" on 8h`, `env node "${SCRIPT}" on 8h`, `/usr/bin/node "${SCRIPT}" on 8h`, `true && node "${SCRIPT}" on 8h`, `node "${SCRIPT}" on 8h; echo ok`,
          `node "${SCRIPT}" on 8h | cat`, `echo $(node "${SCRIPT}" on 8h)`, `sh -c 'node "${SCRIPT}" on 8h'`, `bash -c "node ${SCRIPT} on 8h"`, `eval node "${SCRIPT}" on 8h`,
          `bash <<'EOF'\nnode "${SCRIPT}" on 8h\nEOF`, `node "${SCRIPT}" on 8h > ${h}/.claude/orbit/unattended/go-${SID}.json`, `node "${SCRIPT}" on 8h 2>/dev/null`,
          `node "$X" on 8h # unattended.mjs`, `cp "${SCRIPT}" /tmp/u.mjs`, `node "${SCRIPT}" on 8h 'unterminated`]) {
          assert.equal(kind(g(c)), "deny", `${mode} ${k}: ${c}`);
        }
        for (const c of [`echo '{}' > ${h}/.claude/orbit/unattended/go-${SID}.json`, `sed -i s/1/2/ ${h}/.claude/orbit/unattended/go-${SID}.json`, `cp go.json ${h}/.claude/orbit/unattended/go-${SID}.json`]) {
          assert.equal(kind(g(c)), "deny", `${mode} ${k}: ${c}`);
        }
        for (const tool of ["Write", "Edit"]) assert.equal(kind(guard({ ...who, tool_name: tool, tool_input: { file_path: join(h, `.claude/orbit/unattended/go-${SID}.json`) } }, env, ctx())), "deny", `${mode} ${k}: ${tool}`);
      }
    }
    assert.deepEqual(files(h), [], "the guard writes nothing");
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test("the script: on writes the go bound to the session (default 12 h, at most 24 h); off and status; no session, no go; no terminal or code anywhere", () => {
  const h = home(), env = { HOME: h, CLAUDE_CODE_SESSION_ID: SID }, now = Date.UTC(2026, 9, 17, 1, 0);
  const go = (t = now + 1000) => goState({ session_id: SID, permission_mode: "bypassPermissions" }, env, t);
  try {
    assert.match(unattended(["on"], env, now), /go open until 13:00 UTC/);
    assert.deepEqual(JSON.parse(readFileSync(join(stateDir(h), `go-${SID}.json`), "utf8")), { session_id: SID, opened: now, until: now + 12 * 3600_000 });
    assert.equal(statSync(stateDir(h)).mode & 0o777, 0o700);
    assert.equal(statSync(join(stateDir(h), `go-${SID}.json`)).mode & 0o777, 0o600);
    assert.ok(go(), "open for its session");
    assert.equal(goState({ session_id: "other", permission_mode: "bypassPermissions" }, env, now + 1000), null, "not for another session");
    assert.equal(goState({ session_id: SID, permission_mode: "default" }, env, now + 1000), null, "not outside bypassPermissions");
    assert.match(unattended(["status"], env, now + 1000), /open until 13:00 UTC/);
    assert.match(unattended(["off"], env, now + 2000), /closed/);
    assert.equal(go(), null, "off closes it");
    assert.match(unattended(["status"], env, now + 3000), /no go is open/);
    unattended(["on", "24h"], env, now);
    assert.ok(go(now + 24 * 3600_000 - 1) && !go(now + 24 * 3600_000), "24 h, then expired");
    unattended(["on", "90m"], env, now);
    assert.equal(JSON.parse(readFileSync(join(stateDir(h), `go-${SID}.json`), "utf8")).until, now + 90 * 60_000);
    unattended(["off"], env, now);
    for (const a of [["on", "25h"], ["on", "1441m"], ["on", "0m"], ["on", "8"], ["on", "8h", "x"], ["confirm", "ABCD-EFGH"], ["frob"], []]) {
      assert.match(unattended(a, env, now), /usage|duration/, a.join(" "));
      assert.deepEqual(files(h), [], `${a.join(" ")}: no go`);
    }
    for (const bad of [{ HOME: h }, { HOME: h, CLAUDE_CODE_SESSION_ID: "../x" }, { CLAUDE_CODE_SESSION_ID: SID }]) {
      assert.match(unattended(["on"], bad, now), /no session id/);
      assert.deepEqual(files(h), [], "no session: no go");
    }
    const r = spawnSync(process.execPath, [SCRIPT, "on", "2h"], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^orbit unattended: go open until/);
    assert.ok(goState({ session_id: SID, permission_mode: "bypassPermissions" }, env), "the CLI opens the go");
    for (const f of ["hooks/unattended.mjs", "hooks/go.mjs", "hooks/hooks.json", "commands/unattended.md"]) {
      const text = readFileSync(join(repo, f), "utf8");
      for (const x of ["/dev/tty", "/dev/pts", "confirm", "one-time", "pending", "randomInt", "UserPromptSubmit"]) assert.ok(!text.includes(x), `${f}: ${x}`);
    }
    assert.ok(!existsSync(join(repo, "hooks/unattended.sh")), "no prompt hook script");
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
      for (const [tool, input] of [["CronCreate", { prompt: "/orbit:unattended on 24h", cron: "0 1 * * *" }], ["ScheduleWakeup", { prompt: "run /orbit:unattended on" }],
        ["SendMessage", { to: "s2", message: "/orbit:unattended on" }], ["RemoteTrigger", { body: { text: "/ORBIT:UNATTENDED on" } }], ["mcp__peers__send", { text: "/orbit:unattended on" }], ["SlashCommand", { command: "/orbit:unattended on 24h" }]]) {
        assert.equal(kind(t(tool, input)), "deny", `${mode} ${tool}`);
      }
      assert.equal(t("CronCreate", { prompt: "/loop check CI", cron: "*/5 * * * *" }), null);
      assert.equal(t("SendMessage", { to: "s2", message: "merged" }), null);
    }
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

test("hooks.json: no prompt hook; the guard matcher covers reads, schedulers and message tools", () => {
  const h = JSON.parse(readFileSync(join(repo, "hooks/hooks.json"), "utf8")).hooks;
  assert.equal(h.UserPromptSubmit, undefined);
  const m = h.PreToolUse.find((e) => e.hooks.some((x) => x.command.includes("hooks/guard"))).matcher.split("|");
  for (const name of ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "Read", "Grep", "Glob", "mcp__.*", ".*Cron.*", ".*Schedule.*", ".*Wakeup.*", ".*Trigger.*", ".*Message.*", ".*Skill.*", "SlashCommand"]) assert.ok(m.includes(name), name);
  assert.ok(existsSync(join(repo, "commands/unattended.md")), "the command file exists");
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

test("#22 row 4: a glob in an ln/cp operand or a write target that can match under ~/.claude is denied; any other is silent", () => {
  withGo((env, h) => {
    const who = { ...MAIN, cwd: h, permission_mode: "default" };
    for (const c of ["echo x > ~/.claud?/settings.json", "ln ~/.claud*/x ~/s", "ln ~/.claud?/settings.json ~/s", "cp -l ~/.c[l]aude/settings.json ~/s",
      "ln -s ~/.claude/{a,settings.json} ~/s", "echo x > ~/**/settings.json", "touch .claud?/x"]) assert.equal(kind(guard(bash(c, who), env, ctx())), "deny", c);
    for (const c of ["echo x > /tmp/o?.txt", "ln /tmp/a* ~/s", "cp /tmp/a[0-9] ~/s", "rm ~/x/*.log", "ln -s /tmp/{a,b} ~/s"]) for (const m of ["default", "bypassPermissions"]) assert.equal(guard(bash(c, { ...who, permission_mode: m }), env, ctx()), null, `${m}: ${c}`);
    for (const c of ["ls *.md", "cat ~/.claude/*.json | head", "ln -s a b"]) assert.equal(guard(bash(c, { ...who, cwd: repo }), env, ctx()), null, c);
  });
});

test("#22 narrowing: everyday local globs are silent; a segment-wise match under ~/.claude or CLAUDE_CONFIG_DIR is denied", () => {
  withGo((env, h) => {
    for (const m of ["default", "bypassPermissions"]) {
      const at = { ...MAIN, cwd: repo, permission_mode: m };
      for (const c of ["rm *.log", "sed -i s/a/b/ *.md", "mkdir a/{b,c}", "cp src/*.js dist/", "ln -s *.md d/"]) assert.equal(guard(bash(c, at), env, ctx()), null, `${m}: ${c}`);
      const inH = { ...at, cwd: h };
      for (const c of ["echo x > ~/.claud?/settings.json", "ln ~/.claud*/x ~/s", "cp x ~/.c*/settings.json", "rm .cl*/settings.json"]) assert.equal(kind(guard(bash(c, inH), env, ctx())), "deny", `${m}: ${c}`);
      // .. resolves, also inside a brace alternative; a relative pattern counts against the cwd.
      const sub = { ...at, cwd: join(h, "x") };
      for (const c of ["touch ../.cl*/settings.json", "touch {a,../.claud?}/settings.json", "rm *.json"]) assert.equal(kind(guard(bash(c, c === "rm *.json" ? { ...at, cwd: join(h, ".claude") } : sub), env, ctx())), "deny", `${m}: ${c}`);
      assert.equal(guard(bash("touch ../x*/a", sub), env, ctx()), null, `${m}: a .. glob outside`);
      // An unknown cwd: a pattern that could match .claude is denied, another is silent.
      const unk = { ...at, cwd: undefined };
      assert.equal(kind(guard(bash("rm .cl*/settings.json", unk), env, ctx())), "deny", `${m}: unknown cwd`);
      assert.equal(guard(bash("rm *.log", unk), env, ctx()), null, `${m}: unknown cwd, *.log`);
      // CLAUDE_CONFIG_DIR counts like ~/.claude.
      const cfg = join(h, "cfg");
      assert.equal(kind(guard(bash(`echo x > ${join(h, "c?g")}/settings.json`, inH), { ...env, CLAUDE_CONFIG_DIR: cfg }, ctx())), "deny", `${m}: CLAUDE_CONFIG_DIR`);
      assert.equal(guard(bash(`echo x > ${join(h, "c?g")}/settings.json`, inH), env, ctx()), null, `${m}: no CLAUDE_CONFIG_DIR`);
    }
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

// ---------- fix-round 5 re-review of 0.21.0 (Orbit #24): globs and wrappers the guard cannot read exactly ----------
test("#24 row 1: a glob form the matcher does not model exactly is never silent; everyday globs stay silent", () => {
  withGo((env, h) => {
    for (const m of ["default", "bypassPermissions"]) {
      const who = { ...MAIN, cwd: h, permission_mode: m };
      for (const c of [
        "echo '{}' > ~/.[[:lower:]]laude/settings.json", "cp x ~/.[[:lower:]]laude/settings.json", "ln -sf x ~/.[[:lower:]]laude/settings.json",
        "echo '{}' > ~/.{c..c}laude/settings.json", "cp x ~/.{c..c}laude/settings.json", "ln -sf x ~/.{c..c}laude/settings.json",
        "cp x {~,/nonexistent}/.claud?/settings.json", "ln -sf x {~,/nonexistent}/.claud?/settings.json", "echo '{}' > {~,/nonexistent}/.claud?/settings.json",
        "echo '{}' > ~/.[[=c=]]laude/settings.json", "echo '{}' > ~/.[[.c.]]laude/settings.json", "echo '{}' > ~/{x/../.{c,x}laude/settings.json",
      ]) assert.notEqual(guard(bash(c, who), env, ctx()), null, `${m}: ${c}`);
      // A brace group without a comma is literal; the comma group after it still expands.
      assert.equal(kind(guard(bash("echo '{}' > ~/{x}/../.{c,x}laude/settings.json", who), env, ctx())), "deny", `${m}: a literal group before a comma group`);
      for (const c of ["rm *.log", "sed -i s/a/b/ *.md", "ls src/{a,b}.js", "cp src/{a,b}.js dist/", "rm a[0-9].txt", "touch {}"]) assert.equal(guard(bash(c, { ...who, cwd: repo }), env, ctx()), null, `${m}: ${c}`);
    }
  });
});

test("#24 row 2: any gh call under xargs, find -exec, fd -x or parallel is shared", () => {
  withGo((env) => {
    for (const m of ["default", "bypassPermissions"]) {
      for (const c of ["printf merge | xargs -I{} gh pr {} 1", "echo delete 5 --yes | xargs gh issue", "echo 1 --approve | xargs gh pr review", "echo exec x | xargs gh extension"]) assert.notEqual(guard(bash(c, { ...MAIN, permission_mode: m }), env, ctx()), null, `${m}: ${c}`);
    }
    attendedAsk(env, ["xargs -a a.txt gh issue", "xargs -I{} -a a.txt gh pr {} 1", "find . -exec gh pr view {} \\;", "find . -execdir gh issue view {} \\;", "fd -x gh issue view", "fd -X gh pr view", "parallel gh pr view ::: 1"]);
  });
});

// ---------- Orbit #25: guard residuals accepted at 0.21.0 ----------
test("#25 row 1: a line with shopt shares every glob operand", () => {
  withGo((env, h) => {
    for (const m of ["default", "bypassPermissions"]) {
      const who = { ...MAIN, cwd: h, permission_mode: m };
      for (const c of [
        "shopt -s nocaseglob; cp x ~/.CLAUD?/settings.json", "bash -c 'shopt -s nocaseglob; cp x ~/.CLAUD?/settings.json'",
        "eval 'shopt -s nocaseglob'; echo x > ~/.CLAUD?/settings.json", "sh''opt -s nocaseglob; cp x ~/.CLAUD?/settings.json",
        "BASHOPTS=nocaseglob bash -c 'cp x ~/.CLAUD?/settings.json'", "x=shopt; $x -s nocaseglob; cp x ~/.CLAUD?/settings.json",
      ]) assert.notEqual(guard(bash(c, who), env, ctx()), null, `${m}: ${c}`);
      for (const c of ["rm *.log", "cp x ~/.CLAUD?/settings.json"]) assert.equal(guard(bash(c, { ...who, cwd: c === "rm *.log" ? repo : h }), env, ctx()), null, `${m}: ${c}`);
    }
  });
});

test("#25 row 2: an extglob form is a glob the matcher does not model (shared)", () => {
  withGo((env, h) => {
    for (const m of ["default", "bypassPermissions"]) {
      const who = { ...MAIN, cwd: h, permission_mode: m };
      for (const c of ["cp x ~/.@(claude)/settings.json", "echo x > ~/.+(c)laude/settings.json", "ln -sf x ~/.!(x)laude/settings.json", "cp x ~/.?(c)laude/settings.json", "cp x ~/.*(c)laude/settings.json", "echo x > \"a+(b)\""]) assert.notEqual(guard(bash(c, who), env, ctx()), null, `${m}: ${c}`);
      for (const c of ["echo \"a+(b)\"", "echo x > a+b", "echo x > \"a?b\""]) assert.equal(guard(bash(c, { ...who, cwd: repo }), env, ctx()), null, `${m}: ${c}`);
    }
  });
});

test("#25 row 3: ] first in a negated set is a set character, as in bash", () => {
  withGo((env, h) => {
    for (const m of ["default", "bypassPermissions"]) {
      const who = { ...MAIN, cwd: h, permission_mode: m };
      for (const c of ["echo x > ~/.[!]x]laude/settings.json", "echo x > ~/.[^]x]laude/settings.json"]) assert.equal(kind(guard(bash(c, who), env, ctx())), "deny", `${m}: ${c}`);
      // [!]c] excludes c; [!]laude has no closing ] after the set, so it is literal: neither names ~/.claude.
      for (const c of ["echo x > ~/.[!]c]laude/settings.json", "echo x > ~/.[!]laude/settings.json"]) assert.equal(guard(bash(c, who), env, ctx()), null, `${m}: ${c}`);
    }
  });
});

// ---------- Orbit #25 send-back and #27: extglob groups, set, glob refspecs ----------
test("#25 fix 1: an extglob group holding a substitution, a backtick or a quote is unreadable, never silent", () => {
  withGo((env, h) => {
    for (const m of ["default", "bypassPermissions"]) {
      const who = { ...MAIN, cwd: h, permission_mode: m };
      for (const c of ["shopt -s extglob\necho @($(echo x > ~/.claude/settings.json))", "shopt -s extglob\nx=@($(rm -rf ~/.claude))", "echo @(\"x\"$(echo x > ~/.claude/s))"]) assert.equal(kind(guard(bash(c, who), env, ctx())), "deny", `${m}: ${c}`);
    }
    attendedAsk(env, ["shopt -s extglob\necho @($(git push --force origin main))", "echo +(a|`git push -f`) ok", "shopt -s extglob\necho @($(gh release delete v1))", "shopt -s extglob\necho @($(gh pr merge 1))", "echo @('x'|git push origin main)"]);
  });
});

// #29: a git push word with an unquoted glob character, { or extglob group may expand to any option or refspec; a push never
// needs one, so it is denied in every mode (0.21.1 changed the ask for m?in, {main,feat} and @(main) to a deny).
const denyEvery = (env, cmds) => {
  for (const m of ["default", "bypassPermissions", "dontAsk", undefined]) {
    const who = { ...MAIN, ...(m ? { permission_mode: m } : {}) };
    for (const c of cmds) assert.equal(kind(guard(bash(c, who), env, ctx())), "deny", `${m}: ${c}`);
  }
};

test("#25 fix 2: a push target holding an extglob group is a glob word: denied in every mode (#29)", () => {
  withGo((env) => denyEvery(env, ["git push origin @(main)", "git push origin HEAD:@(main)", "git push origin +(main)"]));
});

test("#25 fix 5: an escaped, quoted or expanded glob character before ( is no extglob group (fails closed)", () => {
  withGo((env) => attendedAsk(env, ["echo \\*(git push origin main)", "echo $?(git push origin main)", "echo '*'(git push origin main)"]));
});

test("#25 fix 3: set (any -o/+o or short flags) does not share globs; shopt still does", () => {
  withGo((env, h) => {
    for (const m of ["default", "bypassPermissions"]) {
      const who = { ...MAIN, cwd: repo, permission_mode: m };
      for (const c of ["set -euo pipefail; rm *.log", "set -o posix; rm *.log", "set +o noglob; rm *.log"]) assert.equal(guard(bash(c, who), env, ctx()), null, `${m}: ${c}`);
      assert.notEqual(guard(bash("shopt -s nocaseglob; cp x ~/.CLAUD?/settings.json", { ...who, cwd: h }), env, ctx()), null, `${m}: shopt`);
    }
  });
});

test("#27/#28/#29: any unquoted glob or brace word in git push is denied in every mode; quoted or escaped ones stay names", () => {
  withGo((env, h) => {
    denyEvery(env, [
      "git push origin m?in", "git push origin ma[i]n", "git push origin HEAD:m?in", "git push origin ma*", "git push origin -- m?in",
      "git push origin {main,feat}", "git push origin {main..main}", "git push origin HEAD:{main,x}", "git push origin -- {main,x}",
      "git push origin +ma?n", "git push origin +feat*", "git push origin +HEAD:{feat,x}", "git push origin -- +feat*", "git push -f* origin feat",
      "git push -{f,} origin feat", "git push --force-with-lease={a,b} origin feat", "git push --force-with-lease=feat:{abc} origin feat", "git push origin {+feat,x}",
      "git push origin {-f,feat}", "git push origin {feat,-f}", "git push origin {,-f}", "git push origin {x,{y,-f}}", "git push origin {--force,feat}",
      "git push origin {\\-f,x}", "git push origin {x,\\-f}", "git push origin {x,\"-f\"}", "git push origin -- {-f,x}", "git -C /r/merge push origin {x,-f}",
      "git push origin [+]main", "git push origin [-]f",
      "git push origin {,}-f feat", "git push origin {,}+main", "git push origin {x,{,}-f}", "git push origin {x,$'\\x2df'}", "git push origin []+]main",
      "git push origin [!a]main", "git push origin [[:punct:]]main", "git push origin ?main", "git push origin --delete ma?n", "git push -o {a,b} origin feat",
    ]);
    const branch = ctx({ ctx: { refKind: () => ({ tag: false, branch: true, remote: true }) } });
    for (const c of ["git push origin feat", "git push -u origin feat", "git push origin HEAD:refs/heads/feat", "git push origin '{-f,x}'", "git push origin \"{-f,x}\"", "git push origin \\{-f,x\\}", "git push origin 'x{y}'", "git push origin x\\{y\\}"]) assert.equal(guard(bash(c, { ...MAIN, permission_mode: "default" }), env, branch), null, `stays silent: ${c}`);
    // Braces outside git push keep their result.
    for (const c of ["echo {a,b}", "find . -name '*.go' -exec gofmt -l {} +", "mkdir -p x/{a,b}", "git log --format=%H -n1 HEAD@{1}"]) assert.equal(guard(bash(c, { ...MAIN, cwd: h, permission_mode: "default" }), env, ctx()), null, `stays silent: ${c}`);
  });
});

test("#31: $'...' decodes every ANSI-C escape as bash does, so a force option or +refspec spelled with escapes is denied", () => {
  withGo((env) => {
    denyEvery(env, ["git push origin $'\\x2df'", "git push origin $'-f'", "git push origin $'\\053main'", "git push $'\\055\\055force' origin feat", "git push origin $'\\u002bmain'", "git push origin $'\\U0000002Bmain'", "git push origin $'\\0'-f"]);
    const branch = ctx({ ctx: { refKind: () => ({ tag: false, branch: true, remote: true }) } });
    assert.equal(guard(bash("git push origin $'feat'", { ...MAIN, permission_mode: "default" }), env, branch), null, "a plain $'feat' stays silent");
  });
});

test("#32: a locale string $\"...\" drops its $, so a force option, +refspec or protected write spelled with it is denied", () => {
  withGo((env, h) => {
    denyEvery(env, ['git push origin $"+main"', 'git push $"-f" origin feat', 'git push origin $"--force" feat']);
    for (const m of ["default", "bypassPermissions"]) {
      const who = { ...MAIN, cwd: h, permission_mode: m };
      for (const c of ['echo x > "$HOME/.claude/settings.json"', 'echo x > $"$HOME/.claude/settings.json"']) assert.equal(kind(guard(bash(c, who), env, ctx())), "deny", `${m}: ${c}`);
    }
    assert.equal(parseShell('$"-f"x"$"')[0].words[0].lit, "-fx$");
  });
});

test("#33: $'...' forms bash accepts are decoded or only that word is unreadable; a destructive push in the line is still denied", () => {
  withGo((env) => denyEvery(env, ["git push origin +main; echo $'\\c\\\\'", "git push origin +main; echo $'a\\c'", "git push origin +main; echo $'\\U110000'", "echo $'\\c'; git push -f origin feat"]));
  const lit = (w) => parseShell(`echo ${w}`)[0].words[1].lit;
  assert.equal(lit("$'\\c\\\\'"), "\x1c");
  assert.equal(lit("$'\\c\\\\x'"), "\x1cx");
  assert.equal(lit("$'a\\c'"), "a\\c");
  assert.equal(lit("$'\\U110000'"), null);
});

test("#34: a glob or brace word among git's global options or as the subcommand is denied in every mode", () => {
  withGo((env) => {
    denyEvery(env, ["git -C {.,push} origin +main", "git {-C,.} push --force origin feat", "git -C . pu{s,}h origin +main", "git -C . p[u]sh origin +main",
      "git -c {x.y=z,push} origin +main", "git --git-dir {.git,push} origin +main", "git -[C] . push origin +main", "git p?sh origin +main"]);
    const branch = ctx({ ctx: { refKind: () => ({ tag: false, branch: true, remote: true }) } });
    for (const c of ["git -C /r push origin feat", "git -c x=y push origin feat"]) assert.equal(guard(bash(c, { ...MAIN, permission_mode: "default" }), env, branch), null, `stays silent: ${c}`);
  });
});

test("#35: only a word bash brace-expands is a brace word: {} placeholders after git -C stay allowed; {a,b}, {1..3}, {,} stay denied", () => {
  withGo((env, h) => {
    denyEvery(env, ["git -C {a,b} status", "git -C {1..3} status", "git -C . {,}status", "git -C {{a,b} status"]);
    for (const m of ["default", "bypassPermissions"]) {
      for (const c of ["ls -d */ | xargs -I{} git -C {} status", "find . -maxdepth 1 -type d -exec git -C {} status ';'", "git -C {a} status", "git -C x{a,b status"]) {
        assert.equal(guard(bash(c, { ...MAIN, cwd: h, permission_mode: m }), env, ctx()), null, `${m}: ${c}`);
      }
    }
  });
});

test("#36: a command substitution inside an unquoted here-doc, ${...} or $((...)) is checked as a bare one; a quoted here-doc stays inert", () => {
  withGo((env, h) => {
    for (const m of ["default", "bypassPermissions"]) {
      const who = { ...MAIN, cwd: h, permission_mode: m };
      for (const s of ["git push -f origin feat", "echo x > ~/.claude/settings.json"]) {
        const bare = kind(guard(bash(`echo $(${s})`, who), env, ctx()));
        assert.notEqual(bare, "allow", `${m}: bare ${s}`);
        for (const c of [`cat <<EOF\nmsg $(${s})\nEOF`, `cat <<-EOF\n\t\`${s}\`\n\tEOF`, `echo \${x:-$(${s})}`, `echo "\${x:-$(${s})}"`, `echo \${x:-\`${s}\`}`, `echo $((1 + $(${s})))`, `echo $((\`${s}\`))`]) {
          assert.equal(kind(guard(bash(c, who), env, ctx())), bare, `${m}: ${c}`);
        }
        assert.equal(guard(bash(`cat <<'EOF'\n$(${s})\nEOF`, who), env, ctx()), null, `${m}: quoted here-doc ${s}`);
      }
      for (const c of ["cat <<EOF\nFix the parser\n\nCo-Authored-By: X <x@example.com>\nEOF", "cat <<EOF\nhome $HOME, ${x:-y}, $((1+2))\nEOF", "echo ${x:-y} $((1+2)) ${#x}"]) {
        assert.equal(guard(bash(c, who), env, ctx()), null, `${m}: plain ${c}`);
      }
      for (const c of ["cat <<EOF\n$(git push -f origin feat (\nEOF", "echo ${x:-$(git push -f origin feat (}", "echo $(( $(git push -f origin feat ( ))"]) assert.notEqual(kind(guard(bash(c, who), env, ctx())), "allow", `${m}: unparsable ${c}`);
    }
  });
});

test("#36: a backslash-newline is removed before parsing, in a here-doc body, ${...}, double quotes and backticks", () => {
  withGo((env, h) => {
    for (const m of ["default", "bypassPermissions"]) {
      const who = { ...MAIN, cwd: h, permission_mode: m };
      for (const s of ["git push -f origin feat", "echo x > ~/.claude/settings.json"]) {
        const bare = kind(guard(bash(`echo $(${s})`, who), env, ctx())), cs = s.replace(" ", " \\\n");
        assert.notEqual(bare, "allow", `${m}: bare ${s}`);
        for (const c of [`cat <<EOF\n$\\\n(${s})\nEOF`, `echo "\${x:-$\\\n(${s})}"`, `echo \${x:-$\\\n(${s})}`, `echo "$\\\n(${s})"`, `echo $((1 + $\\\n(${s})))`,
          `echo \`${cs}\``, `cat <<EOF\n\`${cs}\`\nEOF`, `echo "\`${cs}\`"`]) {
          assert.equal(kind(guard(bash(c, who), env, ctx())), bare, `${m}: ${JSON.stringify(c)}`);
        }
        assert.equal(guard(bash(`cat <<'EOF'\n$\\\n(${s})\nEOF`, who), env, ctx()), null, `${m}: quoted here-doc ${s}`);
      }
      for (const c of ["cat <<EOF\nFix the parser\n\nCo-Authored-By: X <x@example.com>\nEOF", "cat <<EOF\nFix the parser, \\\nand the docs\nEOF", "cat <<EOF\nhome $\\\nHOME\nEOF"]) {
        assert.equal(guard(bash(c, who), env, ctx()), null, `${m}: plain ${JSON.stringify(c)}`);
      }
    }
  });
});

test("#37: $(( ... ) ) without a closing )) is $( and a subshell; $\\<newline>'..' and $\\<newline>\"..\" are $'..' and $\"..\"", () => {
  withGo((env, h) => {
    for (const m of ["default", "bypassPermissions"]) {
      const who = { ...MAIN, cwd: h, permission_mode: m };
      for (const s of ["git push -f origin feat", "echo x > ~/.claude/settings.json"]) {
        const bare = kind(guard(bash(`echo $(${s})`, who), env, ctx()));
        assert.notEqual(bare, "allow", `${m}: bare ${s}`);
        for (const c of [`echo $((${s}) )`, `echo $(\\\n(${s}) )`, `echo $\\\n((${s}) )`, `echo "$((${s}) )"`, `cat <<EOF\n$((${s}) )\nEOF`,
          `echo $(( $((${s}) ) ))`, `echo \${x:-$((${s}) )}`, `echo $((echo "))"; ${s}) )`, `echo $((echo ')'; ${s}) )`,
          // a quote in $(( does not drop the arithmetic reading: bash expands '$(...)' in it and runs it
          `echo $(( '$(${s})' ))`, `cat <<EOF\n$(( '$(${s})' ))\nEOF`, `echo $(( x '$(${s})' ))`, `echo "$(( '$(${s})' ))"`]) {
          assert.equal(kind(guard(bash(c, who), env, ctx())), bare, `${m}: ${JSON.stringify(c)}`);
        }
        // $'\'' in $(( is one quoted quote; where the arithmetic and subshell closes differ, nothing between is skipped
        const c = `echo $(( $'\\'' ))\n${s}\necho ' ))`;
        assert.notEqual(kind(guard(bash(c, who), env, ctx())), "allow", `${m}: ${JSON.stringify(c)}`);
      }
      const force = kind(guard(bash("git push origin -f feat", who), env, ctx()));
      assert.notEqual(force, "allow", `${m}: bare -f`);
      for (const c of ["git push origin $\\\n'-f' feat", 'git push origin $\\\n"-f" feat', "git push origin $\\\n'\\x2d'f feat"]) {
        assert.equal(kind(guard(bash(c, who), env, ctx())), force, `${m}: ${JSON.stringify(c)}`);
      }
      for (const c of ["echo $((1+2))", "echo $(( $(date +%s) - 1 ))", "echo $(((1+2)*3))", "echo $(( (1+2) ))", "echo $(\\\n(1+2)\\\n)", "cat <<EOF\n$((1+2))'s\nEOF", "git push origin $\\\n'feat'",
        'echo $(( "1" + 2 ))', "echo $(( '1' ))", 'git log -n $(( "$n" * 2 ))', 'echo $(( "1" > 2 ))']) {
        assert.equal(guard(bash(c, who), env, ctx()), null, `${m}: plain ${JSON.stringify(c)}`);
      }
    }
  });
});
