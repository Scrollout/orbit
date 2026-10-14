// PreToolUse guard: OPR-01 for the operator session, DEC-08 for every session. Zero dependencies.
// Reads the hook event on stdin. Prints a PreToolUse "deny" decision naming the rule, or nothing (allow).
// The operator is the main thread (no `agent_id`) of a session started with `claude --agent orbit:operator`
// (`agent_type`), or of any session with ORBIT_ROLE=operator in its environment. A subagent (`agent_id` set) never is.
// OPR-01 (operator only): no Edit/Write/MultiEdit/NotebookEdit except .agents/operator.md; Bash runs only read-only
// git (the one exception: a lone `git [-C <dir>] push origin HEAD:<base>` when the profile names a base_pusher), no
// `gh pr merge|checkout`, and no shell write (redirect, tee, sed -i, mv, cp, ln, install, rm, rmdir, mkdir, touch,
// truncate) into a worktree of the repo. A command it cannot parse or resolve is denied (fail closed).
// DEC-08 (any session, only with a profile whose review_trailer is set): `git merge --no-ff -m|-F` of a non-base ref,
// and `git commit -m|-F` that concludes such a merge, need the review trailer in the last paragraph, with Co-Authored-By.
// A guardrail against slips, not a sandbox: it does not model every way a program can write a file.
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parseProfileText } from "../scripts/profile.mjs";

export const OPERATOR_AGENTS = ["orbit:operator", "operator"];
const EDIT_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
const DELEGATE = "every repo change goes to a worker: brief a fresh worker (orbit:coder) on its own branch, or send the owning worker its GO";

export const isOperator = (input, env) => !input?.agent_id && (OPERATOR_AGENTS.includes(input?.agent_type) || env.ORBIT_ROLE === "operator");

// ---------- shell parser (a POSIX subset: quotes, escapes, $(), ``, <(), >(), $VAR, heredocs, ; && || | &) ----------
export class ParseError extends Error {}
const META = new Set([" ", "\t", "\n", ";", "&", "|", "(", ")", "<", ">"]);
const REDIR = /^(\d*)(&>>|&>|>>|>\||>&|>|<<<|<<-|<<|<>|<&|<)/;
const WRITE_OPS = new Set([">", ">>", ">|", "&>", "&>>", "<>", ">&"]);

export function parseShell(src, env = {}) {
  const p = { s: src, i: 0, cmds: [], env };
  list(p, 0, false);
  return p.cmds;
}

function list(p, depth, inParen) {
  const s = p.s;
  let cmd = { words: [], redirs: [], heredoc: null, depth }, pending = [];
  const finish = () => { if (cmd.words.length || cmd.redirs.length) p.cmds.push(cmd); cmd = { words: [], redirs: [], heredoc: null, depth }; };
  while (p.i < s.length) {
    const c = s[p.i];
    if (c === " " || c === "\t") { p.i++; continue; }
    if (c === "\\" && s[p.i + 1] === "\n") { p.i += 2; continue; }
    if (c === "\n") { finish(); p.i++; heredocs(p, pending); pending = []; continue; }
    if (c === "#") { while (p.i < s.length && s[p.i] !== "\n") p.i++; continue; }
    if (c === ")") {
      if (!inParen) throw new ParseError("unmatched )");
      if (pending.length) throw new ParseError("heredoc not terminated");
      finish(); p.i++; return;
    }
    if (c === "(") {
      if (cmd.words.length) throw new ParseError("( inside a command");
      finish(); p.i++; list(p, depth + 1, true); continue;
    }
    if ((c === ";" || c === "|" || c === "&") && !(c === "&" && s[p.i + 1] === ">")) {
      finish(); p.i += s[p.i + 1] === c || (c === "|" && s[p.i + 1] === "&") ? 2 : 1; continue;
    }
    const m = REDIR.exec(s.slice(p.i));
    if (m && !/^[<>]\(/.test(s.slice(p.i + m[1].length))) {
      p.i += m[0].length;
      while (s[p.i] === " " || s[p.i] === "\t") p.i++;
      const w = word(p, depth);
      if (!w) throw new ParseError(`${m[2]} without a target`);
      const op = m[2];
      if (op === "<<" || op === "<<-") {
        if (w.lit === null) throw new ParseError("dynamic heredoc delimiter");
        pending.push({ cmd, delim: w.lit, strip: op === "<<-" });
      } else if (WRITE_OPS.has(op) && !(op === ">&" && /^(\d+|-)$/.test(w.lit ?? ""))) cmd.redirs.push({ op, target: w });
      continue;
    }
    cmd.words.push(word(p, depth));
  }
  if (inParen) throw new ParseError("unclosed (");
  if (pending.length) throw new ParseError("heredoc not terminated");
  finish();
}

function heredocs(p, pending) {
  for (const h of pending) {
    const body = [];
    for (;;) {
      if (p.i >= p.s.length) throw new ParseError(`heredoc ${h.delim} not terminated`);
      const nl = p.s.indexOf("\n", p.i), end = nl < 0 ? p.s.length : nl;
      const line = p.s.slice(p.i, end);
      p.i = nl < 0 ? p.s.length : nl + 1;
      if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
      body.push(line);
    }
    h.cmd.heredoc = body.length ? body.join("\n") + "\n" : "";
  }
}

// A word: `lit` is its text when fully static (else null), `exp` its text with $VAR, ${VAR} and ~ expanded from the
// environment (null when anything else is dynamic), `subs` the [from, to) ranges of the commands it substitutes.
function word(p, depth) {
  const s = p.s, start = p.i, subs = [];
  let lit = "", exp = "", dyn = false, unexp = false, litChars = 0, vars = 0;
  const add = (t) => { lit += t; exp += t; litChars += t.length; };
  const sub = () => { const from = p.cmds.length; list(p, depth + 1, true); subs.push([from, p.cmds.length]); dyn = unexp = true; };
  const dollar = () => {
    if (s.startsWith("$((", p.i)) {
      let n = 0;
      for (; p.i < s.length; p.i++) { if (s[p.i] === "(") n++; else if (s[p.i] === ")" && --n === 0) break; }
      if (p.i >= s.length) throw new ParseError("unclosed $((");
      p.i++; dyn = unexp = true; return;
    }
    if (s[p.i + 1] === "(") { p.i += 2; sub(); return; }
    let name = null;
    if (s[p.i + 1] === "{") {
      const e = s.indexOf("}", p.i);
      if (e < 0) throw new ParseError("unclosed ${");
      const inner = s.slice(p.i + 2, e);
      p.i = e + 1;
      if (/^[A-Za-z_]\w*$/.test(inner)) name = inner; else { dyn = unexp = true; return; }
    } else {
      const m = /^[A-Za-z_]\w*/.exec(s.slice(p.i + 1));
      if (m) { name = m[0]; p.i += 1 + name.length; }
      else if (/^[0-9@*#?$!-]/.test(s[p.i + 1] ?? "")) { p.i += 2; dyn = unexp = true; return; }
      else { p.i++; add("$"); return; }
    }
    dyn = true; vars++;
    const v = p.env[name];
    if (v === undefined) unexp = true; else exp += v;
  };
  const backtick = () => {
    let j = p.i + 1, inner = "";
    for (; j < s.length && s[j] !== "`"; j++) { if (s[j] === "\\" && j + 1 < s.length) { j++; inner += s[j]; } else inner += s[j]; }
    if (j >= s.length) throw new ParseError("unclosed `");
    const q = { s: inner, i: 0, cmds: p.cmds, env: p.env }, from = p.cmds.length;
    list(q, depth + 1, false);
    subs.push([from, p.cmds.length]); dyn = unexp = true; p.i = j + 1;
  };
  while (p.i < s.length) {
    const c = s[p.i];
    if ((c === "<" || c === ">") && s[p.i + 1] === "(") { p.i += 2; sub(); continue; }
    if (META.has(c)) break;
    if (c === "\\") { if (s[p.i + 1] !== "\n") add(s[p.i + 1] ?? ""); p.i += 2; continue; }
    if (c === "'") {
      const e = s.indexOf("'", p.i + 1);
      if (e < 0) throw new ParseError("unclosed '");
      add(s.slice(p.i + 1, e)); p.i = e + 1; continue;
    }
    if (c === "$" && s[p.i + 1] === "'") {
      let j = p.i + 2, t = "";
      const esc = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"', e: "\x1b", a: "\x07", "0": "\0" };
      for (; j < s.length && s[j] !== "'"; j++) { if (s[j] === "\\" && j + 1 < s.length) { j++; t += esc[s[j]] ?? "\\" + s[j]; } else t += s[j]; }
      if (j >= s.length) throw new ParseError("unclosed $'");
      add(t); p.i = j + 1; continue;
    }
    if (c === '"') {
      p.i++;
      while (p.i < s.length && s[p.i] !== '"') {
        const d = s[p.i];
        if (d === "\\" && "$`\"\\\n".includes(s[p.i + 1] ?? "x")) { if (s[p.i + 1] !== "\n") add(s[p.i + 1]); p.i += 2; }
        else if (d === "$") dollar();
        else if (d === "`") backtick();
        else { add(d); p.i++; }
      }
      if (p.i >= s.length) throw new ParseError('unclosed "');
      p.i++; continue;
    }
    if (c === "$") { dollar(); continue; }
    if (c === "`") { backtick(); continue; }
    if (c === "~" && p.i === start && (p.i + 1 >= s.length || s[p.i + 1] === "/" || META.has(s[p.i + 1]))) {
      lit += "~"; litChars++; p.i++;
      if (p.env.HOME === undefined) unexp = true; else exp += p.env.HOME;
      continue;
    }
    add(c); p.i++;
  }
  if (p.i === start) return null;
  return { lit: dyn ? null : lit, exp: unexp ? null : exp, raw: s.slice(start, p.i), subs, onlySub: subs.length === 1 && litChars === 0 && vars === 0 ? subs[0] : null };
}

// ---------- command resolution ----------
const KEYWORDS = new Set(["!", "{", "}", "then", "do", "else", "elif", "if", "while", "until", "fi", "done", "esac"]);
const ASSIGN = /^[A-Za-z_]\w*(\[[^\]]*\])?\+?=/;
// Wrapper programs and their options that take a value; the wrapped command follows.
const WRAPPERS = {
  env: ["-u", "--unset", "-C", "--chdir", "-S", "--split-string"], command: [], nice: ["-n", "--adjustment"], nohup: [], exec: ["-a"],
  time: [], sudo: ["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U"], timeout: ["-s", "--signal", "-k", "--kill-after"],
  xargs: ["-I", "-n", "-P", "-d", "-L", "-s", "-a", "-E", "-e", "--max-args", "--max-procs", "--delimiter", "--arg-file"], stdbuf: ["-i", "-o", "-e"],
};
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

export function resolveCmd(words) {
  let i = 0, xargs = false;
  for (;;) {
    while (i < words.length && (KEYWORDS.has(words[i].lit) || ASSIGN.test(words[i].raw))) i++;
    const w = words[i];
    if (!w) return null;
    if (w.lit === null) return { dynamic: true };
    const name = basename(w.lit);
    if (name in WRAPPERS) {
      i++; xargs ||= name === "xargs";
      while (i < words.length) {
        const a = words[i].lit;
        if (a === null) return { dynamic: true };
        if (a === "--") { i++; break; }
        if (name === "env" && ASSIGN.test(a)) { i++; continue; }
        if (!a.startsWith("-") || a === "-") break;
        i += WRAPPERS[name].includes(a) ? 2 : 1;
      }
      if (name === "timeout") i++;
      continue;
    }
    const args = words.slice(i + 1);
    if (SHELLS.has(name)) {
      const c = args.findIndex((a) => a.lit !== null && /^-[a-z]*c[a-z]*$/.test(a.lit));
      if (c >= 0) return { name, args, inner: args[c + 1]?.lit ?? null };
    }
    if (name === "eval") return { name, args, inner: args.some((a) => a.lit === null) ? null : args.map((a) => a.lit).join(" ") };
    return { name, args, xargs };
  }
}

// ---------- context (git and the profile); tests pass their own ----------
const git = (dir, ...a) => {
  const r = spawnSync("git", ["-C", dir, ...a], { encoding: "utf8", timeout: 5000 });
  return r.status === 0 ? r.stdout.trim() : null;
};
const todo = (v) => typeof v !== "string" || !v.trim() || /^TODO\b/i.test(v.trim());

export function realCtx(cwd, env) {
  const project = env.CLAUDE_PROJECT_DIR ? resolve(env.CLAUDE_PROJECT_DIR) : null;
  const list = (git(cwd, "worktree", "list", "--porcelain") ?? "").split("\n").filter((l) => l.startsWith("worktree ")).map((l) => resolve(l.slice(9)));
  const roots = [...new Set([...list, ...(project ? [project] : [])])];
  if (!roots.length) roots.push(resolve(cwd));
  const main = list[0] ?? project ?? resolve(cwd);
  const profiles = new Map();
  return {
    roots,
    operatorFiles: [...new Set([main, ...(project ? [project] : [])].map((r) => join(r, ".agents/operator.md")))],
    profile(dir) {
      const key = dir ?? "";
      if (!profiles.has(key)) {
        let data = null;
        for (const r of [dir && git(dir, "rev-parse", "--show-toplevel"), main, project].filter(Boolean)) {
          const f = join(r, ".agents/project.md");
          if (existsSync(f)) { data = parseProfileText(readFileSync(f, "utf8")); if (data) break; }
        }
        profiles.set(key, data && {
          base: todo(data.base_branch) ? null : data.base_branch,
          pusher: ["agent", "owner"].includes(data.base_pusher) ? data.base_pusher : null,
          trailer: todo(data.review_trailer) || data.review_trailer === "none" ? null : data.review_trailer,
        });
      }
      return profiles.get(key);
    },
    mergeHead(dir) {
      const f = git(dir, "rev-parse", "--path-format=absolute", "--git-path", "MERGE_HEAD");
      return f && existsSync(f) ? readFileSync(f, "utf8").split("\n")[0].trim() : null;
    },
    baseShas: (dir, base) => [base, `origin/${base}`].map((r) => git(dir, "rev-parse", "--verify", "-q", `${r}^{commit}`)).filter(Boolean),
    readFile: (f) => { try { return readFileSync(f, "utf8"); } catch { return null; } },
  };
}

// ---------- the checks ----------
const inside = (root, f) => f === root || f.startsWith(root.endsWith(sep) ? root : root + sep);
const shown = (w) => w.raw;

function gitSplit(args, cwd) {
  let i = 0, dir = cwd;
  while (i < args.length) {
    const a = args[i].lit;
    if (a === null) return { bad: "a dynamic git option" };
    if (a === "-C") {
      const d = args[i + 1]?.exp;
      if (d == null) return { bad: "a dynamic git -C path" };
      dir = isAbsolute(d) ? d : dir && resolve(dir, d); i += 2; continue;
    }
    if (["--git-dir", "--work-tree", "--namespace"].includes(a)) { i += 2; continue; }
    if (/^--(git-dir|work-tree|namespace)=/.test(a) || ["--no-pager", "-p", "--paginate", "-P", "--no-replace-objects", "--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs", "--no-optional-locks", "--bare"].includes(a)) { i++; continue; }
    if (["--version", "--help", "--exec-path", "--html-path", "--man-path", "--info-path"].includes(a)) return { dir, sub: "version", rest: [] };
    if (a.startsWith("-")) return { bad: `git option ${a}` };
    return { dir, sub: a, rest: args.slice(i + 1) };
  }
  return { dir, sub: null, rest: [] };
}

const READ_GIT = new Set(["status", "log", "diff", "show", "fetch", "rev-parse", "ls-remote", "ls-files", "ls-tree", "cat-file", "rev-list", "merge-base", "describe", "blame", "grep", "shortlog", "show-ref", "for-each-ref", "name-rev", "check-ignore", "help", "version", "whatchanged", "diff-tree", "diff-files", "diff-index", "show-branch", "count-objects", "var", "range-diff", "cherry"]);
const BRANCH_LIST = ["--list", "-l", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "-a", "--all", "-r", "--remotes"];
const BRANCH_FLAG = /^(-a|--all|-r|--remotes|-v|-vv|--verbose|--show-current|--list|-l|--contains|--no-contains|--merged|--no-merged|--points-at|-i|--ignore-case|--no-color|--color(=.*)?|--column(=.*)?|--no-column|--sort=.*|--format=.*|--abbrev=.*|--no-abbrev|-q|--quiet|--omit-empty)$/;

function gitReadOnly(sub, rest) {
  const a = rest.map((w) => w.lit);
  if (a.includes(null)) return false;
  if (READ_GIT.has(sub)) return true;
  if (sub === "worktree") return a[0] === "list";
  if (sub === "branch") return a.every((x) => BRANCH_FLAG.test(x) || (!x.startsWith("-") && a.some((y) => BRANCH_LIST.includes(y))));
  if (sub === "tag") return a.length === 0 || a[0] === "-l" || a[0] === "--list";
  if (sub === "remote") return a.length === 0 || ["-v", "--verbose", "show", "get-url"].includes(a[0]);
  if (sub === "config") return a.some((x) => /^(--get|--get-all|--get-regexp|--get-urlmatch|--list|-l)$/.test(x)) || ["get", "list"].includes(a[0]);
  if (sub === "reflog") return !["expire", "delete", "drop"].includes(a[0]);
  if (sub === "symbolic-ref") return !a.some((x) => ["-d", "--delete", "-m"].includes(x)) && a.filter((x) => !x.startsWith("-")).length <= 1;
  return false;
}

// Options with a value, per writer; the targets are the positionals (cp, ln, install: the last one, or -t).
const WRITERS = {
  tee: { opts: [] }, rm: { opts: [] }, rmdir: { opts: [] }, mkdir: { opts: ["-m", "--mode"] }, touch: { opts: ["-d", "-t", "-r", "--date", "--reference"] },
  truncate: { opts: ["-s", "-r", "--size", "--reference"] }, mv: { opts: ["-S", "--suffix"], all: true },
  cp: { opts: ["-S", "--suffix"], last: true }, ln: { opts: ["-S", "--suffix"], last: true }, install: { opts: ["-m", "-o", "-g", "-S", "--mode", "--owner", "--group", "--suffix"], last: true },
};

function writeTargets(name, args) {
  if (name === "sed") {
    if (!args.some((w) => /^(-i.*|--in-place.*|-[a-zA-Z]*i[a-zA-Z]*)$/.test(w.lit ?? ""))) return [];
    const pos = [], script = args.some((w) => /^(-e|-f|--expression.*|--file.*)$/.test(w.lit ?? ""));
    for (let i = 0; i < args.length; i++) {
      const a = args[i].lit;
      if (a !== null && /^-[efl]$/.test(a)) { i++; continue; }
      if (a !== null && a.startsWith("-") && a !== "-") continue;
      pos.push(args[i]);
    }
    return script ? pos : pos.slice(1);
  }
  const spec = WRITERS[name];
  if (!spec) return [];
  const pos = [], dirs = [];
  let ended = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i].lit;
    if (!ended && a === "--") { ended = true; continue; }
    if (!ended && a !== null && a.startsWith("-") && a !== "-") {
      if (["-t", "--target-directory"].includes(a)) { if (args[i + 1]) dirs.push(args[i + 1]); i++; }
      else if (a.startsWith("--target-directory=")) dirs.push({ ...args[i], exp: a.slice(19) });
      else if (spec.opts.includes(a)) i++;
      continue;
    }
    pos.push(args[i]);
  }
  if (dirs.length) return name === "cp" || name === "ln" || name === "install" ? dirs : [...dirs, ...pos];
  return spec.last ? pos.slice(-1) : pos;
}

function trailerOk(msg, key) {
  const paras = msg.replace(/\r\n/g, "\n").trim().split(/\n[ \t]*\n/);
  const last = paras.pop().split("\n"), lc = key.toLowerCase();
  const has = (lines, k) => lines.some((l) => l.toLowerCase().startsWith(`${k}:`) && l.slice(k.length + 1).trim());
  return has(last, lc) && !paras.some((p) => has(p.split("\n"), "co-authored-by"));
}

// The literal text of a -m value: a static word, or "$(cat <<'EOF' ... EOF)".
function messageOf(w, cmds) {
  if (w.lit !== null) return w.lit;
  if (!w.onlySub) return null;
  const [from, to] = w.onlySub;
  const c = cmds.slice(from, to);
  if (c.length !== 1 || c[0].heredoc === null || c[0].words.length !== 1 || c[0].words[0].lit !== "cat") return null;
  return c[0].heredoc.replace(/\n+$/, "");
}

function dec08(sub, rest, dir, cmd, cmds, ctx) {
  if (sub !== "merge" && sub !== "commit") return null;
  const prof = ctx.profile(dir);
  if (!prof?.trailer) return null;
  const msgs = [], files = [], pos = [];
  let noff = false, other = false;
  const valued = sub === "merge" ? ["-s", "-X", "--strategy", "--strategy-option", "--into-name", "--cleanup"] : ["-c", "-C", "--author", "--date", "--cleanup", "--fixup", "--squash", "-t", "--template", "--trailer", "--pathspec-from-file"];
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i], a = w.lit;
    if (a === "-m" || a === "--message") { msgs.push(rest[i + 1] ? messageOf(rest[i + 1], cmds) : null); i++; }
    else if (a === "-F" || a === "--file") { files.push(rest[i + 1]?.exp ?? null); i++; }
    else if (a?.startsWith("--message=")) msgs.push(a.slice(10));
    else if (a?.startsWith("--file=")) files.push(a.slice(7));
    else if (a?.startsWith("-m") && a.length > 2 && !a.startsWith("--")) msgs.push(a.slice(2));
    else if (a?.startsWith("-F") && a.length > 2) files.push(a.slice(2));
    else if (a === "--no-ff") noff = true;
    else if (["--abort", "--continue", "--quit", "--amend"].includes(a)) other = true;
    else if (valued.includes(a)) i++;
    else if (a === null || !a.startsWith("-")) pos.push(w);
  }
  if (other || (!msgs.length && !files.length)) return null;
  const base = prof.base;
  if (sub === "merge") {
    if (!noff || !pos.length) return null;
    const baseRefs = base ? [base, `origin/${base}`, `refs/heads/${base}`, `refs/remotes/origin/${base}`] : [];
    if (pos.every((w) => baseRefs.includes(w.lit))) return null;
  } else {
    if (!dir) return null;
    const head = ctx.mergeHead(dir);
    if (!head || (base && ctx.baseShas(dir, base).includes(head))) return null;
  }
  const texts = [...msgs];
  for (const f of files) texts.push(f === "-" ? cmd.heredoc : f === null ? null : ctx.readFile(isAbsolute(f) ? f : dir ? resolve(dir, f) : null));
  const why = `DEC-08: the merge commit message needs the "${prof.trailer}:" trailer (the reviewer that ran and the review pointer, or "<owner> waived - <reason>") in the same last paragraph as Co-Authored-By`;
  if (texts.some((t) => t === null || t === undefined)) return `${why}; this message cannot be read before it runs: write it to a file and pass -F <file>.`;
  return trailerOk(texts.join("\n\n"), prof.trailer) ? null : `${why}.`;
}

function checkCmds(cmds, st, ctx, op, total) {
  for (const cmd of cmds) {
    const r = resolveCmd(cmd.words);
    const deny = (what) => `OPR-01: the operator session does not ${what}; ${DELEGATE}.`;
    if (op) {
      for (const { target } of cmd.redirs) { const d = target_(target, st, ctx); if (d) return deny(`write ${d} (shell redirect)`); }
      if (r?.dynamic) return deny("run a command whose program it cannot tell before it runs");
    }
    if (!r || r.dynamic) continue;
    if (r.name === "cd" || r.name === "pushd") {
      const t = r.args.find((w) => w.lit === null || !w.lit.startsWith("-"));
      const e = t ? t.exp : st.env.HOME;
      st.cwd = cmd.depth > 0 || e == null || e === "-" ? null : isAbsolute(e) ? e : st.cwd && resolve(st.cwd, e);
      continue;
    }
    if (r.name === "popd") { st.cwd = null; continue; }
    if ("inner" in r) {
      if (r.inner === null) { if (op) return deny(`run ${r.name} with a script it cannot read`); continue; }
      let inner;
      try { inner = parseShell(r.inner, st.env); } catch { if (op) return deny(`run a ${r.name} script it cannot parse`); continue; }
      const d = checkCmds(inner, { ...st }, ctx, op, total + inner.length);
      if (d) return d;
      continue;
    }
    if (r.name === "git") {
      const g = gitSplit(r.args, st.cwd);
      if (g.bad) { if (op) return deny(`run git with ${g.bad}`); continue; }
      if (!g.sub) continue;
      if (!op || gitReadOnly(g.sub, g.rest)) {
        const d8 = dec08(g.sub, g.rest, g.dir, cmd, cmds, ctx);
        if (d8) return d8;
        continue;
      }
      if (g.sub === "push") {
        const prof = ctx.profile(g.dir);
        const lone = g.rest.length === 2 && g.rest[0].lit === "origin" && prof?.base && g.rest[1].lit === `HEAD:${prof.base}`;
        if (!prof?.base || !prof?.pusher) return deny("push: the profile names no base_pusher (or no base_branch), so the operator pushes nothing; a worker pushes its own branch after your GO");
        if (!lone) return deny(`run "git push ${g.rest.map(shown).join(" ")}"; a worker pushes its own branch after your GO, and the operator pushes only the base, as "git push origin HEAD:${prof.base}"`);
        if (total !== 1) return deny(`chain the base push with other commands (OPR-03: the base is pushed alone)`);
        continue;
      }
      return deny(`run "git ${g.sub}"`);
    }
    if (!op) continue;
    if (r.name === "gh" && r.args[0]?.lit === "pr" && ["merge", "checkout"].includes(r.args[1]?.lit)) return deny(`run "gh pr ${r.args[1].lit}" (the merge is the verified local --no-ff merge a worker builds)`);
    if (r.xargs && (r.name in WRITERS || r.name === "sed")) return deny(`run "xargs ${r.name}" (its targets are unknown before it runs)`);
    for (const t of writeTargets(r.name, r.args)) { const d = target_(t, st, ctx); if (d) return deny(`write ${d} (${r.name})`); }
  }
  return null;
}

// Returns a description when the write target is (or may be) inside a worktree of the repo, else null.
function target_(w, st, ctx) {
  if (w.exp === null) return `${shown(w)}, a path it cannot resolve before it runs`;
  if (!isAbsolute(w.exp) && !st.cwd) return `${shown(w)} in an unknown directory`;
  const f = resolve(st.cwd ?? "/", w.exp);
  if (ctx.operatorFiles.includes(f)) return null;
  return ctx.roots.some((r) => inside(r, f)) ? `${shown(w)} inside the repo` : null;
}

// Returns the deny reason, or null to allow.
export function guard(input, env = {}, ctx = null) {
  const op = isOperator(input, env);
  const tool = input?.tool_name, ti = input?.tool_input ?? {};
  const cwd = typeof input?.cwd === "string" && input.cwd ? resolve(input.cwd) : null;
  const getCtx = () => ctx ?? (ctx = realCtx(cwd ?? env.CLAUDE_PROJECT_DIR ?? process.cwd(), env));
  if (EDIT_TOOLS.includes(tool)) {
    if (!op) return null;
    const f = ti.file_path ?? ti.notebook_path;
    if (typeof f !== "string" || !f || (!isAbsolute(f) && !cwd)) return `OPR-01: the operator session does not edit a file it cannot locate; ${DELEGATE}.`;
    return getCtx().operatorFiles.includes(resolve(cwd ?? "/", f)) ? null : `OPR-01: the operator session does not edit or write ${f} (its one file is .agents/operator.md); ${DELEGATE}.`;
  }
  if (tool !== "Bash") return null;
  if (typeof ti.command !== "string") return op ? `OPR-01: the operator session does not run a Bash call without a command string; ${DELEGATE}.` : null;
  let cmds;
  try { cmds = parseShell(ti.command, env); } catch (e) { return op ? `OPR-01: the operator session does not run a command it cannot parse (${e.message}); ${DELEGATE}.` : null; }
  if (!op && !/\bgit\b/.test(ti.command)) return null;
  return checkCmds(cmds, { cwd, env }, getCtx(), op, cmds.length);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let input;
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch {
    if (process.env.ORBIT_ROLE === "operator") { process.stderr.write("OPR-01: the orbit guard cannot read the hook input, so the operator's tool call is denied.\n"); process.exit(2); }
    process.exit(0);
  }
  let reason;
  try { reason = guard(input, process.env); } catch (e) {
    if (!isOperator(input, process.env)) process.exit(0);
    reason = `OPR-01: the orbit guard failed (${e.message}), so the operator's tool call is denied.`;
  }
  if (reason) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }) + "\n");
  process.exit(0);
}
