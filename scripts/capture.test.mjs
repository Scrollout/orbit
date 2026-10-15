import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentRole, events, pushRefs } from "../hooks/capture.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE = readFileSync(join(repo, "scripts/fixtures/real-profile.md"), "utf8");
const git = (cwd, ...a) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd, encoding: "utf8" });

function project({ profile = true } = {}) {
  const d = mkdtempSync(join(tmpdir(), "cap-"));
  git(d, "init", "-q", "-b", "topic-x");
  git(d, "commit", "-q", "--allow-empty", "-m", "c");
  if (profile) { mkdirSync(join(d, ".agents")); writeFileSync(join(d, ".agents/project.md"), PROFILE); }
  return d;
}
const fire = (d, input, session = "sess-1") => spawnSync("sh", [join(repo, "hooks/capture.sh")], { encoding: "utf8", input: JSON.stringify({ session_id: session, cwd: d, ...input }), env: { ...process.env, CLAUDE_PLUGIN_ROOT: repo } });
const ledger = (d) => { const f = join(d, ".agents/ledger.jsonl"); return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []; };
const task = (o) => ({ tool_name: "Task", tool_input: { subagent_type: "orbit:coder", description: "SECRET-DESC", prompt: "SECRET-PROMPT", ...o } });
const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });

test("pushRefs reads the refspecs of a git push and whether it is chained; dry runs, deletes and tags are not pushes", () => {
  assert.deepEqual(pushRefs("git push origin topic-x"), { refs: ["topic-x"], chained: false });
  assert.deepEqual(pushRefs("git push -u origin HEAD:main"), { refs: ["HEAD:main"], chained: false });
  assert.deepEqual(pushRefs("git push"), { refs: [""], chained: false });
  assert.deepEqual(pushRefs("git push origin main && git tag v1"), { refs: ["main"], chained: true });
  assert.deepEqual(pushRefs("git -C /w push origin +topic"), { refs: ["+topic"], chained: false });
  for (const c of ["git push -n origin x", "git push --delete origin x", "git push origin :x", "git push --tags", "git push origin refs/tags/v1", "git status", "echo git push origin x"]) assert.equal(pushRefs(c)?.refs?.filter(Boolean).length ? pushRefs(c) : null, null, c);
});

test("agentRole maps orbit agents to ledger roles and ignores others", () => {
  assert.deepEqual(agentRole("orbit:architect"), { name: "architect", role: "techlead" });
  assert.deepEqual(agentRole("coder"), { name: "coder", role: "coder" });
  assert.equal(agentRole("general-purpose"), null);
  assert.equal(agentRole("orbit:__proto__"), null);
  assert.equal(agentRole(undefined), null);
});

test("events: an agent_start needs a known agent, a model and a branch", () => {
  const e = (ev, branch = "b") => events(ev, "/x", branch, () => "");
  assert.deepEqual(e(task({ model: "opus" })), [["agent_start", "role=coder", "model=opus", "topic=b"]]);
  assert.deepEqual(e(task({})), [["agent_start", "role=coder", "model=sonnet", "topic=b"]], "model from the agent's frontmatter");
  assert.deepEqual(e(task({ subagent_type: "general-purpose" })), []);
  assert.deepEqual(e(task({}), ""), []);
});

test("hook: a Task call appends agent_start without the prompt or description", () => {
  const d = project();
  const r = fire(d, task({ model: "opus" }));
  assert.equal(r.status, 0);
  assert.equal(r.stdout + r.stderr, "");
  const [e] = ledger(d);
  assert.deepEqual([e.kind, e.role, e.model, e.topic, e.session], ["agent_start", "coder", "opus", "topic-x", "sess-1"]);
  assert.doesNotMatch(readFileSync(join(d, ".agents/ledger.jsonl"), "utf8"), /SECRET/);
});

test("hook: a git push appends push with the sha, chained and by agent, never the command", () => {
  const d = project(), head = git(d, "rev-parse", "HEAD").stdout.trim();
  fire(d, bash("git push https://user:SECRET-TOKEN@example.com/r.git topic-x"));
  fire(d, bash("git push origin HEAD:main && echo done"));
  const [a, b] = ledger(d);
  assert.deepEqual([a.kind, a.ref, a.sha, a.chained, a.by], ["push", "topic-x", head, false, "agent"]);
  assert.deepEqual([b.ref, b.chained], ["HEAD:main", true]);
  assert.doesNotMatch(readFileSync(join(d, ".agents/ledger.jsonl"), "utf8"), /SECRET|example\.com/);
});

test("hook: a push with no refspec records the current branch", () => {
  const d = project();
  fire(d, bash("git push"));
  assert.equal(ledger(d)[0].ref, "topic-x");
});

test("hook is fail-open and silent: no profile, bad input, no session, other tools write nothing and exit 0", () => {
  const d = project({ profile: false });
  assert.equal(fire(d, task({ model: "opus" })).status, 0);
  assert.equal(existsSync(join(d, ".agents/ledger.jsonl")), false);
  const p = project();
  for (const input of [{ tool_name: "Edit", tool_input: { file_path: "x" } }, bash("git status"), { tool_name: "Bash", tool_input: {} }, { tool_name: "Task" }]) assert.equal(fire(p, input).status, 0);
  assert.equal(fire(p, task({ model: "opus" }), "--bad").status, 0);
  assert.deepEqual(ledger(p), []);
  const junk = spawnSync("sh", [join(repo, "hooks/capture.sh")], { encoding: "utf8", input: "not json", env: { ...process.env, CLAUDE_PLUGIN_ROOT: repo } });
  assert.equal(junk.status, 0);
  assert.equal(junk.stdout + junk.stderr, "");
  const broken = spawnSync("sh", [join(repo, "hooks/capture.sh")], { encoding: "utf8", input: "{}", env: { ...process.env, CLAUDE_PLUGIN_ROOT: "/nonexistent" } });
  assert.equal(broken.status, 0);
});

test("hooks.json registers the capture hook after Task, Agent and Bash calls", () => {
  const h = JSON.parse(readFileSync(join(repo, "hooks/hooks.json"), "utf8")).hooks.PostToolUse;
  assert.ok(h.some((x) => x.matcher === "Task|Agent|Bash" && x.hooks.some((k) => k.command.includes("hooks/capture.sh"))));
});
