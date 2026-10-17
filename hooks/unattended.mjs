// UserPromptSubmit hook: `/orbit:unattended on [dur] | confirm <code> | off | status`. Zero dependencies.
// The prompt hook fires the same way for a typed prompt, a subagent's hand-back, a scheduled prompt and a cross-session message,
// with no field naming the source, so `on` opens nothing: it writes a one-time code to the owner's terminal (/dev/tty, never the
// block reason, which may reach the transcript; when the hook has no controlling terminal, the terminal of a parent, #30) and stores only its hash for 2 minutes. `confirm <code>` with that code opens the
// go for this session; one wrong confirm clears the pending code. `off` and `status` are accepted from any source (they only close
// or show). Every handled prompt is blocked, so the model never sees it. Without a terminal no code is issued: no go.
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, constants, mkdirSync, openSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { isatty } from "node:tty";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { GO_MAX_MS, PENDING_MS, goState, stateDir, validSession } from "./go.mjs";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const DEFAULT_MS = 12 * 3600_000;
const USAGE = "usage: /orbit:unattended on [duration] (like 8h or 90m, at most 24 h; default 12h) | confirm <code> | off | status";
const hash = (sid, code) => createHash("sha256").update(`${sid}:${code}`).digest();
const readJson = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };
const at = (ms) => new Date(ms).toISOString().slice(11, 16) + " UTC";

function duration(arg) {
  if (arg === undefined) return DEFAULT_MS;
  const m = /^(\d{1,4})([mh])$/.exec(arg);
  if (!m) return null;
  return Number(m[1]) * (m[2] === "h" ? 3600_000 : 60_000);
}

// Claude Code starts hooks without a controlling terminal, so /dev/tty fails (#30). Linux: the first of fd 0-2 of the hook's
// nearest parents (Claude Code) that is /dev/pts/N or /dev/ttyN, a character device of this user. Never a pipe, file, socket or
// /dev/null, never the hook's own stdio (the agent can read those). Elsewhere (no /proc) or none found: null, no code.
export function parentTerminal(fs = { readlinkSync, readFileSync, statSync }, pid = process.ppid, uid = process.getuid?.()) {
  for (let i = 0; i < 4 && pid > 1; i++) {
    for (const fd of [0, 1, 2]) {
      try {
        const p = fs.readlinkSync(`/proc/${pid}/fd/${fd}`), s = /^\/dev\/(pts\/\d+|tty\d+)$/.test(p) && fs.statSync(p);
        if (s && s.isCharacterDevice() && s.uid === uid) return p;
      } catch { /* gone or not ours */ }
    }
    try { pid = Number(/\) \S+ (\d+)[^)]*$/.exec(fs.readFileSync(`/proc/${pid}/stat`, "utf8"))?.[1]); } catch { return null; }
  }
  return null;
}

function writeTo(path, text) {
  let fd;
  try { fd = openSync(path, constants.O_WRONLY | constants.O_NOCTTY); if (!isatty(fd)) return false; writeSync(fd, text); return true; } catch { return false; } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* closing a terminal that went away */ } }
}

function writeTty(text) {
  if (writeTo("/dev/tty", text)) return true;
  const p = parentTerminal();
  return p !== null && writeTo(p, text);
}

function save(dir, name, data) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(join(dir, name), JSON.stringify(data), { mode: 0o600 });
}

// io: { now(): ms, tty(text): boolean, code?(): string } (tests pass their own). Returns { block: reason } or null.
export function onPrompt(input, env, io = { now: Date.now, tty: writeTty }) {
  const text = typeof input?.prompt === "string" ? input.prompt.trim() : "";
  if (text !== "/orbit:unattended" && !text.startsWith("/orbit:unattended ")) return null;
  const [sub, arg, ...extra] = text.split(/\s+/).slice(1);
  const block = (reason) => ({ block: `orbit unattended: ${reason}` });
  const sid = input?.session_id, dir = stateDir(env), now = io.now();
  if (!validSession(sid) || !dir) return block("this prompt has no session id (or no home directory), so no go can open.");
  const pending = join(dir, `pending-${sid}.json`), goFile = join(dir, `go-${sid}.json`);
  const clear = (...f) => { for (const x of f) rmSync(x, { force: true }); };
  if (sub === "off" && arg === undefined) { clear(goFile, pending); return block("off. The go for this session is closed."); }
  if (sub === "status" && arg === undefined) {
    const g = goState({ ...input, permission_mode: "bypassPermissions", agent_id: undefined }, env, now);
    return block(g ? `open until ${at(g.until)} for this session (it counts only in bypassPermissions mode, in the main thread).` : "no go is open for this session.");
  }
  if (sub === "on" && extra.length === 0) {
    const ms = duration(arg);
    if (ms === null || ms < 60_000 || ms > GO_MAX_MS) return block(`the duration must be like 8h or 90m, from 1m to 24 h. ${USAGE}`);
    const code = io.code?.() ?? Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("").replace(/^(.{4})/, "$1-");
    clear(pending);
    if (!io.tty(`\r\n  Orbit unattended go code: ${code}  (2 minutes)\r\n  type: /orbit:unattended confirm ${code}\r\n\r\n`)) return block("Orbit cannot reach your terminal, so no code was issued and no go can open.");
    save(dir, `pending-${sid}.json`, { session_id: sid, hash: hash(sid, code).toString("hex"), expires: now + PENDING_MS, duration_ms: ms });
    return block(`a one-time code is on your terminal (not in this conversation). Type /orbit:unattended confirm <code> within 2 minutes to open a go of ${Math.round(ms / 60_000)} minutes. If you did not ask for this, ignore it.`);
  }
  if (sub === "confirm" && arg !== undefined && extra.length === 0) {
    const p = readJson(pending);
    clear(pending);   // one try: right or wrong, the pending code is spent
    if (!p || p.session_id !== sid || !(p.expires > now) || typeof p.hash !== "string" || !Number.isFinite(p.duration_ms)) return block("no code is pending for this session (or it expired), so no go opened.");
    const want = Buffer.from(p.hash, "hex"), got = hash(sid, arg.toUpperCase());
    if (want.length !== got.length || !timingSafeEqual(want, got)) return block("wrong code. The pending code is cleared; start again with /orbit:unattended on.");
    const until = now + Math.min(p.duration_ms, GO_MAX_MS);
    save(dir, `go-${sid}.json`, { session_id: sid, opened: now, until });
    return block(`go open until ${at(until)} for this session. It counts only in bypassPermissions mode, in the main thread; it allows only the pinned base push of a verified merge and the delete of a merged topic branch. Close it with /orbit:unattended off.`);
  }
  return block(USAGE);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let r = null, raw = "";
  try { raw = readFileSync(0, "utf8"); r = onPrompt(JSON.parse(raw), process.env); } catch {
    // An error on our own command still keeps it (and any code in it) away from the model; no go opens.
    r = raw.includes("/orbit:unattended") ? { block: "orbit unattended: the hook failed, so no go opened." } : null;
  }
  if (r) process.stdout.write(JSON.stringify({ decision: "block", reason: r.block }) + "\n");
  process.exit(0);
}
