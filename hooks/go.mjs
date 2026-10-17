// The unattended go (Orbit 0.21.0): its state, and the evidence for the shared actions it allows (base push, release tag and release since 0.22.1, merged branch delete). Zero dependencies.
// The owner opens a go with `/orbit:unattended on [dur]` (hooks/unattended.mjs, behind a permission prompt). The state file is
// forgeable by any program the agent runs, so the go is intent only: safety rests on the evidence below, checked on GitHub and
// in git for the exact object pushed. A go counts only for its own session's main thread under bypassPermissions, at most 24 h.
import { readFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";

export const GO_MAX_MS = 24 * 3600_000;
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

// The go itself, which allows its actions: the unattended session's main thread only (no agent_id). Any missing or
// unexpected field means no go (the attended behaviour).
export function goState(input, env, now = Date.now()) {
  if (!input || (input.agent_id !== undefined && input.agent_id !== null)) return null;
  return goSession(input, env, now);
}

// DEC-08's trailer rule: the key's line in the last paragraph, with every Co-Authored-By line.
export function trailerOk(msg, key) {
  const paras = msg.replace(/\r\n/g, "\n").trim().split(/\n[ \t]*\n/);
  const last = paras.pop().split("\n"), lc = key.toLowerCase();
  const has = (lines, k) => lines.some((l) => l.toLowerCase().startsWith(`${k}:`) && l.slice(k.length + 1).trim());
  return has(last, lc) && !paras.some((p) => has(p.split("\n"), "co-authored-by"));
}

// The go's command shapes, exactly, alone in the call (Anything else, another spelling, an option, a variable, is not a go action):
// - base: `git [-C <dir>] push origin <40-hex>:refs/heads/<branch>` ({ sha });
// - tag: `git [-C <dir>] push origin <40-hex>:refs/tags/<vX.Y.Z>` ({ sha }: the tag object, or the commit of a lightweight tag; #41);
//   pinned only: git re-resolves a ref at push time, so the go allows exactly the object it checked. The ref forms `<branch>`,
//   `HEAD:<branch>`, `<branch>:<branch>` ({ src }) and `vX.Y.Z`, `refs/tags/vX.Y.Z` ({ ref: true }) are read only to deny them
//   with the pinned command to run instead;
// - delete: `git [-C <dir>] push origin --delete <branch>`;
// - release: `gh release create <vX.Y.Z>` with only -R/--repo, -t/--title, -n/--notes, --verify-tag, --latest, --target (all
//   literal; the guard checks repo, target and the tag). No -F/--notes-file: gh would read any path (/proc/self/environ, /dev/stdin).
export const SEMVER_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export function goForm(cmds) {
  if (cmds.length !== 1 || cmds.complex) return null;
  const c = cmds[0];
  if (c.depth || c.redirs.length || c.heredoc !== null || c.words.some((w) => w.lit === null)) return null;
  const w = c.words.map((x) => x.lit);
  if (w[0] === "gh") return releaseForm(w);
  let i = 1, dir = null;
  if (w[0] !== "git") return null;
  if (w[1] === "-C") { if (!w[2]) return null; dir = w[2]; i = 3; }
  if (w[i] !== "push" || w[i + 1] !== "origin") return null;
  const rest = w.slice(i + 2), name = (b) => /^\w[\w./-]*$/.test(b) && !b.includes("..") && !b.startsWith("refs/") && !b.endsWith(".lock");
  if (rest.length === 1 && /^[0-9a-f]{40}:refs\/heads\//.test(rest[0])) {
    const dst = rest[0].slice(52);
    return name(dst) ? { kind: "base", dir, sha: rest[0].slice(0, 40), dst } : null;
  }
  if (rest.length === 1 && /^[0-9a-f]{40}:refs\/tags\//.test(rest[0])) {
    const tag = rest[0].slice(51);
    return SEMVER_TAG.test(tag) ? { kind: "tag", dir, sha: rest[0].slice(0, 40), tag } : null;
  }
  if (rest.length === 2 && rest[0] === "--delete" && name(rest[1])) return { kind: "delete", dir, name: rest[1] };
  if (rest.length !== 1) return null;
  const r = rest[0], t = r.startsWith("refs/tags/") ? r.slice(10) : r;
  if (SEMVER_TAG.test(t)) return { kind: "tag", dir, tag: t, ref: true };
  const [src, dst, extra] = r.split(":");
  if (extra !== undefined) return null;
  if (dst === undefined) return name(src) ? { kind: "base", dir, src, dst: src } : null;
  return name(dst) && (src === "HEAD" || src === dst) ? { kind: "base", dir, src, dst } : null;
}

function releaseForm(w) {
  if (w[1] !== "release" || w[2] !== "create") return null;
  const VAL = { "-R": "repo", "--repo": "repo", "-t": "title", "--title": "title", "-n": "notes", "--notes": "notes", "--target": "target" };
  const o = { kind: "release", dir: null, tag: null, repo: null, target: null };
  const seen = new Set();
  for (let i = 3; i < w.length; i++) {
    const a = w[i], eq = a.startsWith("--") ? a.indexOf("=") : -1, f = eq > 0 ? a.slice(0, eq) : a;
    if (f === "--verify-tag" || f === "--latest") { if (eq > 0) return null; continue; }
    if (VAL[f]) {
      const v = eq > 0 ? a.slice(eq + 1) : w[++i];
      if (v === undefined || v.startsWith("-") || seen.has(VAL[f])) return null;
      seen.add(VAL[f]);
      if (VAL[f] === "repo" || VAL[f] === "target") o[VAL[f]] = v;
      continue;
    }
    if (a.startsWith("-") || o.tag !== null || !SEMVER_TAG.test(a)) return null;
    o.tag = a;
  }
  return o.tag ? o : null;
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
// The URL `git push origin` uses: origin has exactly one fetch URL and one push URL (get-url --all), and the push URL (pushurl,
// pushInsteadOf) equals the fetch URL (insteadOf applied) on github.com; the gh owner/repo comes from it. Every ref read is
// `git ls-remote origin`, so git applies the same single url rewrite as the push (the rewritten URL would be rewritten again).
// null on any mismatch or failure.
export function pushUrl(ev, dir) {
  const fetch = out(ev.git(dir, "remote", "get-url", "--all", "origin")), push = out(ev.git(dir, "remote", "get-url", "--push", "--all", "origin"));
  return fetch && push && fetch === push && !fetch.includes("\n") && githubRepo(fetch) ? fetch : null;
}
const remoteTip = (ev, dir, b) => {
  const l = out(ev.git(dir, "ls-remote", "origin", `refs/heads/${b}`))?.split("\n").filter(Boolean);
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
// pushed (the tag and release steps): the merge may also already be origin/<base>'s tip; every other check is the same.
export function baseEvidence(ev, dir, sha, base, trailerKey, requiredChecks = [], pushed = false) {
  const g = (...a) => out(ev.git(dir, ...a));
  const url = pushUrl(ev, dir);
  if (!url) return "origin's push URL is not its fetch URL on github.com";
  const parents = g("rev-list", "--parents", "-n", "1", sha)?.split(/\s+/);
  if (!parents || parents.length !== 3 || parents[0] !== sha) return "it is not a two-parent merge";
  const [, p1, p2] = parents;
  const head = remoteTip(ev, dir, base);
  if (head !== p1 && !(pushed && head === sha)) return pushed ? `it is neither the tip of origin/${base} nor its next merge` : `its first parent is not the tip of origin/${base}`;
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

// What else a pinned push could send: remote.origin.push must be unset, push.followTags and submodule.recurse off, and
// push.recurseSubmodules unset or no (git config exits 1 when unset). null when they hold, else the reason.
export function pushConfigEvidence(ev, dir) {
  const r = (...a) => ev.git(dir, "config", ...a), off = (x, no) => x && (x.code === 1 || (x.code === 0 && x.out === no));
  if (!off(r("--get-all", "remote.origin.push"), null)) return "remote.origin.push is set or cannot be read";
  if (!off(r("--bool", "--get", "push.followTags"), "false")) return "push.followTags is on or cannot be read";
  if (!off(r("--get-all", "push.recurseSubmodules"), "no")) return "push.recurseSubmodules is not no or cannot be read";
  if (!off(r("--bool", "--get", "submodule.recurse"), "false")) return "submodule.recurse is on or cannot be read";
  return null;
}

// The commit a local ref or object names (rev-parse --verify), or null.
export function localCommit(ev, dir, ref) {
  const s = out(ev.git(dir, "rev-parse", "--verify", "-q", `${ref}^{commit}`));
  return s && /^[0-9a-f]{40}$/.test(s) ? s : null;
}

// The commit a remote tag peels to, read through origin: the ^{} line of an annotated tag, else the tag's own line.
export function remoteTagCommit(ev, dir, tag) {
  const l = out(ev.git(dir, "ls-remote", "origin", `refs/tags/${tag}`))?.split("\n").filter(Boolean).map((x) => x.split("\t"));
  if (!l || !l.length || l.length > 2 || l.some(([s]) => !/^[0-9a-f]{40}$/.test(s))) return null;
  const own = l.filter(([, r]) => r === `refs/tags/${tag}`), peeled = l.filter(([, r]) => r === `refs/tags/${tag}^{}`);
  if (own.length !== 1 || peeled.length !== l.length - 1) return null;
  return (peeled[0] ?? own[0])[0];
}

// The branch delete evidence: the branch's remote tip is an ancestor of the remote base tip.
export function deleteEvidence(ev, dir, name, base) {
  const url = pushUrl(ev, dir);
  if (!url) return "origin's push URL is not its fetch URL on github.com";
  const tip = remoteTip(ev, dir, name);
  if (!tip) return "the branch is not on origin";
  const bt = remoteTip(ev, dir, base);
  if (!bt) return `origin/${base} cannot be read in time`;
  return out(ev.git(dir, "merge-base", "--is-ancestor", tip, bt)) === null ? `it is not merged into origin/${base}` : null;
}
