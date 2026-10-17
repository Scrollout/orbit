// `node <plugin root>/hooks/unattended.mjs on [dur] | off | status`: the one Bash call of /orbit:unattended (commands/unattended.md).
// Zero dependencies. The guard (hooks/guard.mjs) answers `on` with a permission "ask" in every mode, bypassPermissions too: the
// owner's answer to that prompt is the proof (the model can ask for it, not answer it). `off` and `status` run silently. The
// session is CLAUDE_CODE_SESSION_ID, which Claude Code sets in the Bash environment (the hook input's session_id).
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { GO_MAX_MS, goState, stateDir, validSession } from "./go.mjs";

const DEFAULT_MS = 12 * 3600_000;
export const USAGE = "usage: /orbit:unattended on [duration] (like 8h or 90m, at most 24 h; default 12h) | off | status";
const at = (ms) => new Date(ms).toISOString().slice(11, 16) + " UTC";

export function duration(arg) {
  if (arg === undefined) return DEFAULT_MS;
  const m = /^(\d{1,4})([mh])$/.exec(arg);
  if (!m) return null;
  return Number(m[1]) * (m[2] === "h" ? 3600_000 : 60_000);
}

// Returns the line to print.
export function unattended(args, env, now = Date.now()) {
  const [sub, arg, ...extra] = args;
  const sid = env?.CLAUDE_CODE_SESSION_ID, dir = stateDir(env);
  const say = (text) => `orbit unattended: ${text}`;
  if (!validSession(sid) || !dir) return say("no session id (CLAUDE_CODE_SESSION_ID) or no home directory, so no go can open.");
  const goFile = join(dir, `go-${sid}.json`);
  if (sub === "off" && arg === undefined) { rmSync(goFile, { force: true }); return say("off. The go for this session is closed."); }
  if (sub === "status" && arg === undefined) {
    const g = goState({ session_id: sid }, env, now);
    return say(g ? `open until ${at(g.until)} for this session (it counts in any permission mode, in the main thread only).` : "no go is open for this session.");
  }
  if (sub === "on" && extra.length === 0) {
    const ms = duration(arg);
    if (ms === null || ms < 60_000 || ms > GO_MAX_MS) return say(`the duration must be like 8h or 90m, from 1m to 24 h. ${USAGE}`);
    const until = now + ms;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    writeFileSync(goFile, JSON.stringify({ session_id: sid, opened: now, until }), { mode: 0o600 });
    return say(`go open until ${at(until)} for this session. It counts in any permission mode, in the main thread only; without a prompt it allows only, for a verified merge, the pinned base push, the pinned tag push and gh release create, and the delete of a merged topic branch. Close it with /orbit:unattended off.`);
  }
  return say(USAGE);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(unattended(process.argv.slice(2), process.env) + "\n");
}
