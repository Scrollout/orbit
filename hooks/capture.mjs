// PostToolUse hook: appends `agent_start` (a Task or Agent call of an orbit agent) and `push` (a `git push`) events to the
// session ledger, so the ledger does not depend on the operator remembering. Reads the hook event on stdin and always exits 0
// and prints nothing: a failure here must never block or slow a tool call. Silent without a project profile (.agents/project.md).
// Records only role, model, topic (the branch of the session's checkout), the pushed ref and sha, `chained` and `by: agent`:
// never the prompt, the description, the command line or the remote.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { loadProfile } from "../scripts/profile.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ROLE = { architect: "techlead", designer: "engineer", explorer: "analyst", coder: "coder", reviewer: "reviewer", "re-reviewer": "re-reviewer", security: "security" };
const REF = /^\+?[\w./@^~-]+(:[\w./-]+)?$/;

// The refspecs of the first `git push` in a shell command, and whether it ran with other commands around it.
export function pushRefs(command) {
  const segs = String(command).split(/&&|\|\||[;|\n]/).map((s) => s.trim()).filter(Boolean);
  for (const s of segs) {
    const m = /^git(?:\s+-[Cc]\s+\S+)*\s+push(?:\s+(.*))?$/.exec(s);
    if (!m) continue;
    const toks = (m[1] ?? "").split(/\s+/).filter(Boolean).map((t) => t.replace(/^(["'])(.*)\1$/, "$2"));
    if (toks.some((t) => ["-n", "--dry-run", "-d", "--delete", "--tags", "--mirror", "--all"].includes(t))) return null;
    const pos = toks.filter((t) => !t.startsWith("-"));
    const specs = pos.slice(1).filter((t) => REF.test(t) && !t.startsWith(":") && !t.includes("refs/tags/")).slice(0, 4);
    return { refs: pos.length > 1 ? specs : [""], chained: segs.length > 1 };
  }
  return null;
}

export function agentRole(subagent) {
  const name = String(subagent ?? "").replace(/^orbit:/, "");
  return Object.hasOwn(ROLE, name) ? { name, role: ROLE[name] } : null;
}

const git = (cwd, args) => { const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 3000 }); return r.status === 0 ? r.stdout.trim() : ""; };

function modelOf(input, name) {
  if (typeof input.model === "string" && /^[\w.-]+$/.test(input.model)) return input.model;
  try { return /^model:[ \t]*(\S+)/m.exec(readFileSync(join(here, "..", "agents", `${name}.md`), "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "")?.[1]; } catch { return undefined; }
}

export function events(event, cwd, branch, sha) {
  const input = event.tool_input ?? {};
  if (["Task", "Agent"].includes(event.tool_name)) {
    const a = agentRole(input.subagent_type), model = a && modelOf(input, a.name);
    return a && model && branch ? [["agent_start", `role=${a.role}`, `model=${model}`, `topic=${branch}`]] : [];
  }
  if (event.tool_name === "Bash") {
    const p = pushRefs(input.command);
    if (!p) return [];
    const out = [];
    for (const r of p.refs) {
      const spec = r.replace(/^\+/, ""), src = spec.split(":")[0] || "HEAD";
      const s = sha(src);
      const ref = spec || branch;
      if (s && ref) out.push(["push", `ref=${ref}`, `sha=${s}`, `chained:=${p.chained}`, "by=agent"]);
    }
    return out;
  }
  return [];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const event = JSON.parse(readFileSync(0, "utf8"));
    const cwd = resolve(event.cwd ?? process.cwd());
    const session = event.session_id;
    if (typeof session !== "string" || !/^[\w][\w.-]*$/.test(session)) process.exit(0);
    const root = git(cwd, ["rev-parse", "--show-toplevel"]) || cwd;
    if (!loadProfile(root).data) process.exit(0);
    const branch = git(cwd, ["branch", "--show-current"]);
    const sha = (r) => (/^[\w./@^~-]+$/.test(r) && !r.startsWith("-") ? git(cwd, ["rev-parse", "--verify", `${r}^{commit}`]) : "");
    for (const a of events(event, cwd, branch, sha)) {
      spawnSync("node", [join(here, "..", "scripts", "ledger.mjs"), "--root", root, "--session", session, ...a], { timeout: 5000, stdio: "ignore" });
    }
  } catch { /* fail-open: a capture error never blocks a tool call */ }
  process.exit(0);
}
