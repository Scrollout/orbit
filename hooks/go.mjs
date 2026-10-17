// The unattended go (Orbit 0.21.0): its state, and the evidence for the only two shared actions it allows. Zero dependencies.
// The owner opens a go with `/orbit:unattended on [dur]` and `confirm <code>` (hooks/unattended.mjs). The state file is
// forgeable by any program the agent runs, so the go is intent only: safety rests on the evidence below, checked on GitHub and
// in git for the exact object pushed. A go counts only for its own session's main thread under bypassPermissions, at most 24 h.
import { readFileSync, readdirSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";

export const GO_MAX_MS = 24 * 3600_000;
export const PENDING_MS = 120_000;
export const EVIDENCE_MS = 6000;   // every gh and git evidence call of one hook run shares it
const SID = /^[\w-]{1,128}$/;

export const stateDir = (env) => (typeof env?.HOME === "string" && isAbsolute(env.HOME) ? join(env.HOME, ".claude", "orbit", "unattended") : null);
export const validSession = (sid) => typeof sid === "string" && SID.test(sid);
const readJson = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };

// The session is unattended: a valid go file for its session_id and the bypassPermissions mode, any thread. Then every
// shared action is denied (nobody answers a prompt), a subagent's too.
export function goSession(input, env, now = Date.now()) {
  const sid = input?.session_id, dir = stateDir(env);
  if (!validSession(sid) || !dir || input.permission_mode !== "bypassPermissions") return null;
  const s = readJson(join(dir, `go-${sid}.json`));
  if (!s || s.session_id !== sid || !Number.isFinite(s.opened) || !Number.isFinite(s.until)) return null;
  if (s.opened > now || s.until <= now || s.until - s.opened > GO_MAX_MS) return null;
  return { opened: s.opened, until: s.until };
}

// The go itself, which allows its two actions: the unattended session's main thread only (no agent_id). Any missing or
// unexpected field means no go (the attended behaviour).
export function goState(input, env, now = Date.now()) {
  if (!input || (input.agent_id !== undefined && input.agent_id !== null)) return null;
  return goSession(input, env, now);
}

// True while any session has a confirm code pending (unexpired).
export function anyPending(env, now = Date.now()) {
  const dir = stateDir(env);
  let names = [];
  try { names = dir ? readdirSync(dir) : []; } catch { return false; }
  return names.some((n) => n.startsWith("pending-") && n.endsWith(".json") && (readJson(join(dir, n))?.expires ?? 0) > now);
}

// DEC-08's trailer rule: the key's line in the last paragraph, with every Co-Authored-By line.
export function trailerOk(msg, key) {
  const paras = msg.replace(/\r\n/g, "\n").trim().split(/\n[ \t]*\n/);
  const last = paras.pop().split("\n"), lc = key.toLowerCase();
  const has = (lines, k) => lines.some((l) => l.toLowerCase().startsWith(`${k}:`) && l.slice(k.length + 1).trim());
  return has(last, lc) && !paras.some((p) => has(p.split("\n"), "co-authored-by"));
}

// The go's two command shapes, exactly, alone in the call: `git [-C <dir>] push origin <40-hex>:refs/heads/<branch>` and
// `git [-C <dir>] push origin --delete <branch>`. Anything else (another spelling, an option, a variable) is not a go action.
export function goForm(cmds) {
  if (cmds.length !== 1 || cmds.complex) return null;
  const c = cmds[0];
  if (c.depth || c.redirs.length || c.heredoc !== null || c.words.some((w) => w.lit === null)) return null;
  const w = c.words.map((x) => x.lit);
  let i = 1, dir = null;
  if (w[0] !== "git") return null;
  if (w[1] === "-C") { if (!w[2]) return null; dir = w[2]; i = 3; }
  if (w[i] !== "push" || w[i + 1] !== "origin") return null;
  const rest = w.slice(i + 2), name = (b) => /^\w[\w./-]*$/.test(b) && !b.includes("..") && !b.startsWith("refs/") && !b.endsWith(".lock");
  if (rest.length === 1 && /^[0-9a-f]{40}:refs\/heads\//.test(rest[0])) {
    const dst = rest[0].slice(52);
    return name(dst) ? { kind: "base", dir, sha: rest[0].slice(0, 40), dst } : null;
  }
  if (rest.length === 2 && rest[0] === "--delete" && name(rest[1])) return { kind: "delete", dir, name: rest[1] };
  return null;
}

// Paths a night merge may not touch: what runs CI or the guard. Test files it may not delete; skip markers it may not add.
const banned = (p) => p.startsWith(".github/") || p.startsWith(".githooks/") || p.startsWith("hooks/") || p.endsWith(".mk") ||
  ["Makefile", "makefile", "GNUmakefile", "hooks.json", "guard.mjs"].includes(basename(p));
const isTest = (p) => {
  const b = basename(p), dirs = p.split("/").slice(0, -1);
  return b.endsWith("_test.go") || b.includes(".test.") || b.includes(".spec.") || (b.startsWith("test_") && b.endsWith(".py")) ||
    dirs.some((d) => d === "test" || d === "tests" || d === "__tests__");
};
const SKIP_MARKERS = ["t.Skip(", "t.SkipNow(", "t.Skipf(", ".skip(", "xit(", "xdescribe(", "xtest(", "@pytest.mark.skip", "skip: true", "{ skip", "@Disabled", "@Ignore"];

// owner/repo of a github.com origin URL, or null.
export function githubRepo(url) {
  if (typeof url !== "string") return null;
  const pre = ["git@github.com:", "ssh://git@github.com/", "https://github.com/"].find((p) => url.startsWith(p));
  if (!pre) return null;
  let rest = url.slice(pre.length);
  if (rest.endsWith("/")) rest = rest.slice(0, -1);
  if (rest.endsWith(".git")) rest = rest.slice(0, -4);
  const parts = rest.split("/");
  return parts.length === 2 && parts.every((x) => /^[\w.-]+$/.test(x)) ? `${parts[0]}/${parts[1]}` : null;
}

// ev: { git(dir, ...args), gh(apiPath) }, each { code, out } or a failure without a code (a timeout or an error).
const out = (r) => (r && r.code === 0 && typeof r.out === "string" ? r.out : null);
// The URL `git push origin` uses: the push URL (pushurl, pushInsteadOf) must equal the fetch URL (insteadOf applied) and be a
// github.com repository; every later read (ls-remote, the gh owner/repo) goes to it. null on any mismatch or failure.
export function pushUrl(ev, dir) {
  const fetch = out(ev.git(dir, "remote", "get-url", "origin")), push = out(ev.git(dir, "remote", "get-url", "--push", "origin"));
  return fetch && push && fetch === push && !fetch.includes("\n") && githubRepo(fetch) ? fetch : null;
}
const remoteTip = (ev, dir, url, b) => {
  const l = out(ev.git(dir, "ls-remote", url, `refs/heads/${b}`))?.split("\n").filter(Boolean);
  if (!l || l.length !== 1) return null;
  const [sha, ref] = l[0].split("\t");
  return ref === `refs/heads/${b}` && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
};
function runsOf(ev, repo, sha) {
  const o = out(ev.gh(`repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`));
  if (o === null) return null;
  try {
    const j = JSON.parse(o);
    return Array.isArray(j.workflow_runs) && Number.isInteger(j.total_count) && j.total_count <= j.workflow_runs.length ? j.workflow_runs : null;
  } catch { return null; }
}

// The base push evidence for the pinned merge sha: null when every check holds, else the first failing check (fixed text).
// trailerKey: the main checkout profile's review_trailer (Reviewed-by when it names none); requiredChecks: its required_checks.
// Commit statuses and check runs are never read (an agent can mint one); only GitHub Actions workflow runs count.
export function baseEvidence(ev, dir, sha, base, trailerKey, requiredChecks = []) {
  const g = (...a) => out(ev.git(dir, ...a));
  const url = pushUrl(ev, dir);
  if (!url) return "origin's push URL is not its fetch URL on github.com";
  const parents = g("rev-list", "--parents", "-n", "1", sha)?.split(/\s+/);
  if (!parents || parents.length !== 3 || parents[0] !== sha) return "it is not a two-parent merge";
  const [, p1, p2] = parents;
  if (remoteTip(ev, dir, url, base) !== p1) return `its first parent is not the tip of origin/${base}`;
  const trees = g("rev-parse", `${sha}^{tree}`, `${p2}^{tree}`)?.split("\n");
  if (!trees || trees.length !== 2 || !trees[0] || trees[0] !== trees[1]) return "its tree differs from the branch it merges";
  const msg = g("log", "-1", "--no-show-signature", "--format=%B", sha);
  if (msg === null || !trailerOk(msg, trailerKey)) return "the review trailer is not in its last paragraph with Co-Authored-By";
  const names = g("diff", "--name-status", "--no-renames", "--no-ext-diff", "--no-textconv", p1, sha);
  if (names === null) return "its changed files cannot be read";
  for (const l of names.split("\n").filter(Boolean)) {
    const t = l.indexOf("\t"), status = l.slice(0, t), path = l.slice(t + 1);
    if (t < 1 || banned(path)) return "it touches a CI, git hook or guard file";
    if (status.startsWith("D") && isTest(path)) return "it deletes a test file";
  }
  const diff = g("diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", p1, sha);
  if (diff === null) return "its diff cannot be read";
  if (diff.split("\n").some((l) => l.startsWith("+") && !l.startsWith("+++") && SKIP_MARKERS.some((m) => l.includes(m)))) return "it adds a test skip marker";
  const repo = githubRepo(url);
  const mine = runsOf(ev, repo, p2);
  if (!mine) return "the branch's CI runs cannot be read in time";
  if (!mine.length) return "the branch has no CI run";
  if (!mine.every((x) => x.head_sha === p2 && x.status === "completed" && x.conclusion === "success" && x.run_attempt === 1)) return "not every CI run of the branch passed on its first attempt";
  const tip = runsOf(ev, repo, p1);
  if (!tip) return "the base tip's CI runs cannot be read in time";
  const green = tip.filter((x) => x.head_sha === p1 && x.status === "completed" && x.conclusion === "success");
  if (!green.length) return "the base tip has no green CI run";
  const have = new Set(mine.map((x) => x.name));
  if (green.some((x) => !have.has(x.name))) return "a workflow green on the base tip did not run green on the branch";
  if (requiredChecks.some((n) => !have.has(n))) return "a required check of the profile did not run green on the branch";
  return null;
}

// The branch delete evidence: the branch's remote tip is an ancestor of the remote base tip.
export function deleteEvidence(ev, dir, name, base) {
  const url = pushUrl(ev, dir);
  if (!url) return "origin's push URL is not its fetch URL on github.com";
  const tip = remoteTip(ev, dir, url, name);
  if (!tip) return "the branch is not on origin";
  const bt = remoteTip(ev, dir, url, base);
  if (!bt) return `origin/${base} cannot be read in time`;
  return out(ev.git(dir, "merge-base", "--is-ancestor", tip, bt)) === null ? `it is not merged into origin/${base}` : null;
}
