// PostToolUse hook: appends a `push` event (a successful `git push`) to the session ledger, so the ledger does not depend on the
// operator remembering. (`agent_start` stays a hand-appended event: the hook sees the call after it finished and from the wrong
// checkout.) Reads the hook event on stdin and always exits 0 and prints nothing: a failure here must never block or slow a tool
// call. Silent without a project profile (.agents/project.md) in the repo's main checkout, where the ledger lives, so removing a
// worktree never loses events. Records only ref, sha, `chained` and `by: agent`: never the command line, the remote or an option.
// Also appends `outward` (class, subcommand, refs, session kind, agent_id, exit code) for each shared or destructive action the
// guard's classifier finds in the call, read again after it ran; never the command line or a token. Nothing reads it as an authorisation.
// Under an unattended go, the go's own action (the pinned base push, a merged branch delete) is recorded as class `go`, with the sha
// pushed: the owner's night log.
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { loadProfile } from "../scripts/profile.mjs";
import { FAIL, classifyOutward, isOperator, parseShell, realCtx, safe } from "./guard.mjs";
import { goForm, goState } from "./go.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REF_SRC = /^\+?[\w./@^~-]+$/;
const REF_DST = /^[\w./-]+$/;
const isRef = (t) => { const i = t.indexOf(":"); return i < 0 ? REF_SRC.test(t) : REF_SRC.test(t.slice(0, i)) && REF_DST.test(t.slice(i + 1)); };
const VALUE_OPTS = new Set(["-o", "--push-option", "--receive-pack", "--exec"]);
const NO_BRANCH_PUSH = new Set(["-n", "--dry-run", "-d", "--delete", "--tags", "--mirror", "--all", "--prune", "--repo"]);

// The `git push` commands of a shell command, read the way a shell reads it (quotes, heredocs and `$(...)` are not commands):
// {dir, specs, chained}; dir follows `git -C` and a literal `cd`; specs are the refspecs ("" for none).
export function pushes(command, cwd) {
  let cmds;
  try { cmds = parseShell(String(command)); } catch { return []; }
  const chained = cmds.length > 1 || cmds.complex, out = [];
  let dir = cwd;
  for (const c of cmds) {
    const w = c.words.map((x) => x.lit);
    if (w[0] === "cd") {
      if (cmds.complex || w.length !== 2 || w[1] === null || w[1] === "-" || w[1].startsWith("-") || c.depth) dir = null;
      else if (dir) dir = resolve(dir, w[1]);
      continue;
    }
    if (w[0] !== "git" || w.includes(null)) continue;
    let i = 1, d = dir;
    for (; i < w.length; i++) {
      if (w[i] === "-C" && i + 1 < w.length) { d = d && resolve(d, w[++i]); }
      else if (w[i] === "-c" && i + 1 < w.length) i++;
      else break;
    }
    if (w[i] !== "push" || !d) continue;
    const args = w.slice(i + 1), pos = [];
    let skip = false;
    for (let j = 0; j < args.length; j++) {
      const a = args[j];
      if (NO_BRANCH_PUSH.has(a) || a.startsWith("--repo=")) skip = true;
      if (VALUE_OPTS.has(a)) j++;
      else if (a.startsWith("-")) continue;
      else pos.push(a);
    }
    if (skip) continue;
    const specs = pos.slice(1).filter((t) => isRef(t) && !t.startsWith(":") && !t.includes("refs/tags/"));
    if (pos.length > 1 && !specs.length) continue;
    out.push({ dir: d, specs: pos.length > 1 ? specs.slice(0, 4) : [""], chained });
  }
  return out;
}

// A push the response shows failed: an error flag, an interrupted call, a non-zero exit, or git's own failure lines.
export function failed(resp) {
  if (!resp || typeof resp !== "object") return false;
  if (resp.is_error === true || resp.interrupted === true || (typeof resp.error === "string" && resp.error)) return true;
  if ([resp.exit_code, resp.exitCode, resp.returnCode].some((x) => typeof x === "number" && x !== 0)) return true;
  return /^(error|fatal): |\[(remote )?rejected\]/m.test(String(resp.stderr ?? ""));
}

// The main checkout of the repo that holds `dir` (a linked worktree resolves to it), or "".
export function mainRoot(dir, git) {
  const common = git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir");
  return common && basename(common) === ".git" ? dirname(common) : "";
}

// The ledger events of a hook event: [{root, argv}] where argv are the ledger.mjs arguments after the session.
export function events(event, git) {
  if (event.tool_name !== "Bash" || failed(event.tool_response)) return [];
  const out = [];
  for (const p of pushes(event.tool_input?.command, resolve(event.cwd ?? process.cwd()))) {
    const root = mainRoot(p.dir, git), branch = git(p.dir, "branch", "--show-current");
    if (!root) continue;
    for (const r of p.specs) {
      const spec = r.replace(/^\+/, ""), src = spec.split(":")[0] || "HEAD";
      if (src.startsWith("-") || /^refs\/tags\//.test(src)) continue;
      const isBranch = git(p.dir, "rev-parse", "--verify", "--quiet", `refs/heads/${src}`);
      if (!isBranch && git(p.dir, "rev-parse", "--verify", "--quiet", `refs/tags/${src}`)) continue;   // a bare tag name
      const sha = git(p.dir, "rev-parse", "--verify", `${src}^{commit}`), ref = spec || branch;
      if (sha && ref) out.push({ root, argv: ["push", `ref=${ref}`, `sha=${sha}`, `chained:=${p.chained}`, "by=agent"] });
    }
  }
  return out;
}

// The outward events of a hook event: [{dir, argv}] for each shared or destructive action, argv after the session.
// After the call a deleted remote branch has no remote-tracking ref left, so a name that is no local tag reads as a branch.
export function outwardEvents(event, getCtx, env = {}) {
  const text = event.tool_input?.command;
  if (event.tool_name !== "Bash" || typeof text !== "string") return [];
  let cmds;
  try { cmds = parseShell(text); } catch { return []; }
  const cwd = resolve(event.cwd ?? process.cwd());
  const after = () => { const c = getCtx(); return { ...c, refKind: (d, n) => { const k = c.refKind(d, n); return k === FAIL || k.tag ? k : { ...k, remote: true }; } }; };
  const kind = isOperator(event, env) ? "operator" : event.agent_id ? "subagent" : "peer";
  const r = event.tool_response;
  const code = [r?.exit_code, r?.exitCode, r?.returnCode].find((x) => typeof x === "number") ?? (failed(r) ? 1 : 0);
  const g = goForm(cmds);
  if (g && goState(event, env)) {
    const dir = g.dir === null ? cwd : resolve(cwd, g.dir);
    const ref = g.kind === "base" ? g.dst : g.name;
    return [{ dir, argv: ["outward", "class=go", `subcommand=${g.kind === "base" ? "push" : "push --delete"}`, `refs:=${JSON.stringify([`origin/${safe(ref)}`])}`,
      ...(g.kind === "base" ? [`sha=${g.sha}`] : []), `session_kind=${kind}`, `exit_code:=${code}`] }];
  }
  return classifyOutward(cmds, text, cwd, env, after).findings.filter((f) => f.cls === "shared" || f.cls === "destructive").map((f) => ({
    dir: f.dir ?? cwd,
    argv: ["outward", `class=${f.cls}`, `subcommand=${String(f.sub ?? "?").split(" ").map(safe).join(" ")}`, `refs:=${JSON.stringify((f.refs ?? []).map((x) => String(x)))}`,
      `session_kind=${kind}`, ...(typeof event.agent_id === "string" ? [`agent_id=${safe(event.agent_id)}`] : []), `exit_code:=${code}`],
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const event = JSON.parse(readFileSync(0, "utf8"));
    const session = event.session_id;
    if (typeof session !== "string" || !/^[\w][\w.-]*$/.test(session)) process.exit(0);
    const git = (cwd, ...a) => { const r = spawnSync("git", a, { cwd, encoding: "utf8", timeout: 3000 }); return r.status === 0 ? r.stdout.trim() : ""; };
    for (const e of events(event, git)) {
      if (!loadProfile(e.root).data) continue;
      spawnSync("node", [join(here, "..", "scripts", "ledger.mjs"), "--root", e.root, "--session", session, ...e.argv], { timeout: 5000, stdio: "ignore" });
    }
    let ctx = null;
    const cwd = resolve(event.cwd ?? process.cwd());
    for (const o of outwardEvents(event, () => (ctx ??= realCtx(cwd, process.env)), process.env)) {
      const root = mainRoot(o.dir, git);
      if (!root || !loadProfile(root).data) continue;
      spawnSync("node", [join(here, "..", "scripts", "ledger.mjs"), "--root", root, "--session", session, ...o.argv], { timeout: 5000, stdio: "ignore" });
    }
  } catch { /* fail-open: a capture error never blocks a tool call */ }
  process.exit(0);
}
