import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { events, failed, pushes } from "../hooks/capture.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE = readFileSync(join(repo, "scripts/fixtures/real-profile.md"), "utf8");
const git = (cwd, ...a) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd, encoding: "utf8" });

function project({ profile = true } = {}) {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "cap-")));
  git(d, "init", "-q", "-b", "topic-x");
  git(d, "commit", "-q", "--allow-empty", "-m", "c");
  if (profile) { mkdirSync(join(d, ".agents")); writeFileSync(join(d, ".agents/project.md"), PROFILE); }
  return d;
}
const fire = (cwd, input, session = "sess-1") => spawnSync("sh", [join(repo, "hooks/capture.sh")], { encoding: "utf8", input: JSON.stringify({ session_id: session, cwd, ...input }), env: { ...process.env, CLAUDE_PLUGIN_ROOT: repo } });
const ledger = (d) => { const f = join(d, ".agents/ledger.jsonl"); return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []; };
const bash = (command, tool_response) => ({ tool_name: "Bash", tool_input: { command }, ...(tool_response ? { tool_response } : {}) });
const specs = (c) => pushes(c, "/w").map((p) => p.specs);

test("pushes reads refspecs, -C and cd, chained; dry runs, deletes, tag refs and other commands are not pushes", () => {
  assert.deepEqual(pushes("git push origin topic-x", "/w"), [{ dir: "/w", specs: ["topic-x"], chained: false }]);
  assert.deepEqual(specs("git push -u origin HEAD:main"), [["HEAD:main"]]);
  assert.deepEqual(specs("git push"), [[""]]);
  assert.deepEqual(pushes("git push origin main && git tag v1", "/w"), [{ dir: "/w", specs: ["main"], chained: true }]);
  assert.deepEqual(pushes("git -C /r/wt push origin +topic", "/w"), [{ dir: "/r/wt", specs: ["+topic"], chained: false }]);
  assert.equal(pushes("cd /r/wt && git push origin t", "/w")[0].dir, "/r/wt");
  assert.deepEqual(pushes("cd sub && git push origin t", "/w")[0].dir, "/w/sub");
  assert.deepEqual(pushes("git push origin t | tail", "/w").map((p) => p.chained), [true]);
  for (const c of ["git push -n origin x", "git push --delete origin x", "git push origin :x", "git push --tags", "git push origin refs/tags/v1", "git status", "echo git push origin x", "git push origin $BR"]) assert.deepEqual(pushes(c, "/w"), [], c);
});

test("quotes, heredocs and substitutions are not commands", () => {
  assert.deepEqual(pushes('git commit -m "x; git push origin m2"', "/w"), []);
  assert.deepEqual(pushes("git commit -F - <<'EOF'\nmsg\ngit push origin m2\nEOF", "/w"), []);
  assert.deepEqual(pushes("echo 'git push origin m2'", "/w"), []);
  assert.deepEqual(pushes('git commit -m "unterminated', "/w"), []);
});

test("options that take a value do not shift the remote and refspec", () => {
  assert.deepEqual(specs("git push -o ci.skip origin topic-x"), [["topic-x"]]);
  assert.deepEqual(specs("git push --push-option=a origin topic-x"), [["topic-x"]]);
  assert.deepEqual(specs("git push --receive-pack /x/rp --force-with-lease origin topic-x"), [["topic-x"]]);
  assert.deepEqual(specs('git push -o "a b" origin topic-x'), [["topic-x"]]);
  assert.deepEqual(specs("git push --repo upstream topic-x"), [], "--repo changes what the positionals mean: not recorded");
});

test("failed: an error flag, an interrupted call, a non-zero exit or git's failure lines", () => {
  assert.equal(failed(undefined), false);
  assert.equal(failed({ stdout: "", stderr: "To host\n   a..b  m -> m" }), false);
  for (const r of [{ is_error: true }, { interrupted: true }, { error: "boom" }, { exit_code: 1 }, { stderr: "error: failed to push some refs" }, { stderr: " ! [rejected]        m -> m (fetch first)" }]) assert.equal(failed(r), true, JSON.stringify(r));
});

test("events: no push for a failed response, a bare tag name, or a Task call (agent_start is appended by hand)", () => {
  const d = project(), g = (cwd, ...a) => git(cwd, ...a).stdout.trim();
  git(d, "tag", "v1.2.0");
  const ev = (e) => events({ cwd: d, ...e }, g);
  assert.equal(ev(bash("git push origin topic-x")).length, 1);
  assert.deepEqual(ev(bash("git push origin topic-x", { is_error: true })), []);
  assert.deepEqual(ev(bash("git push origin v1.2.0")), []);
  assert.deepEqual(ev({ tool_name: "Task", tool_input: { subagent_type: "orbit:coder", model: "opus" } }), []);
});

test("hook: a git push appends push with the sha, chained and by agent, never the command", () => {
  const d = project(), head = git(d, "rev-parse", "HEAD").stdout.trim();
  const r = fire(d, bash("git push https://user:SECRET-TOKEN@example.com/r.git topic-x"));
  fire(d, bash("git push origin HEAD:main && echo done"));
  assert.equal(r.stdout + r.stderr, "");
  const [a, b] = ledger(d);
  assert.deepEqual([a.kind, a.ref, a.sha, a.chained, a.by, a.session], ["push", "topic-x", head, false, "agent", "sess-1"]);
  assert.deepEqual([b.ref, b.chained], ["HEAD:main", true]);
  assert.doesNotMatch(readFileSync(join(d, ".agents/ledger.jsonl"), "utf8"), /SECRET|example\.com/);
});

test("hook: a push with no refspec records the current branch", () => {
  const d = project();
  fire(d, bash("git push"));
  assert.equal(ledger(d)[0].ref, "topic-x");
});

test("hook: -C and cd resolve the sha and branch in the target worktree, and the event lands in the main checkout's ledger", () => {
  const d = project(), wt = join(realpathSync(mkdtempSync(join(tmpdir(), "capwt-"))), "wt");
  git(d, "worktree", "add", "-q", "-b", "feat-y", wt);
  git(wt, "commit", "-q", "--allow-empty", "-m", "w");
  const wsha = git(wt, "rev-parse", "HEAD").stdout.trim();
  fire(d, bash(`git -C ${wt} push origin`));
  fire(d, bash(`cd ${wt} && git push origin HEAD`));
  fire(wt, bash("git push origin feat-y"));
  const got = ledger(d);
  assert.equal(got.length, 3);
  assert.deepEqual(got.map((e) => [e.ref, e.sha]), [["feat-y", wsha], ["HEAD", wsha], ["feat-y", wsha]]);
  assert.equal(existsSync(join(wt, ".agents/ledger.jsonl")), false, "the worktree has no ledger of its own");
  git(d, "worktree", "remove", "--force", wt);
  assert.equal(ledger(d).length, 3, "removing the worktree loses nothing");
});

test("hook: a quoted or heredoc push, a bare tag and a failed response write nothing", () => {
  const d = project();
  git(d, "tag", "v1.2.0");
  fire(d, bash('git commit -m "x; git push origin m2"'));
  fire(d, bash("git commit -F - <<'EOF'\ngit push origin m2\nEOF"));
  fire(d, bash("git push origin v1.2.0"));
  fire(d, bash("git push origin topic-x", { stderr: "error: failed to push some refs" }));
  assert.deepEqual(ledger(d), []);
});

test("hook is fail-open and silent: no profile, bad input, no session, other tools write nothing and exit 0", () => {
  const d = project({ profile: false });
  assert.equal(fire(d, bash("git push origin topic-x")).status, 0);
  assert.equal(existsSync(join(d, ".agents/ledger.jsonl")), false);
  const p = project();
  for (const input of [{ tool_name: "Edit", tool_input: { file_path: "x" } }, bash("git status"), { tool_name: "Bash", tool_input: {} }, { tool_name: "Task" }]) assert.equal(fire(p, input).status, 0);
  assert.equal(fire(p, bash("git push origin topic-x"), "--bad").status, 0);
  assert.deepEqual(ledger(p), []);
  const junk = spawnSync("sh", [join(repo, "hooks/capture.sh")], { encoding: "utf8", input: "not json", env: { ...process.env, CLAUDE_PLUGIN_ROOT: repo } });
  assert.equal(junk.status, 0);
  assert.equal(junk.stdout + junk.stderr, "");
  assert.equal(spawnSync("sh", [join(repo, "hooks/capture.sh")], { encoding: "utf8", input: "{}", env: { ...process.env, CLAUDE_PLUGIN_ROOT: "/nonexistent" } }).status, 0);
});

test("hooks.json registers the capture hook after Bash calls only", () => {
  const h = JSON.parse(readFileSync(join(repo, "hooks/hooks.json"), "utf8")).hooks.PostToolUse;
  assert.ok(h.some((x) => x.matcher === "Bash" && x.hooks.some((k) => k.command.includes("hooks/capture.sh"))));
  assert.ok(!h.some((x) => /Task|Agent/.test(x.matcher)));
});
