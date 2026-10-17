// PreToolUse guard: OPR-01 for the operator session, DEC-08 for every session. Zero dependencies.
// Reads the hook event on stdin. Prints a PreToolUse "deny" decision naming the rule, or nothing (allow).
// The operator is the main thread (no `agent_id`) of a session started with `claude --agent orbit:operator`
// (`agent_type`), or of any session with ORBIT_ROLE=operator in its environment. A subagent (`agent_id` set) never is.
// OPR-01 (operator only): no Edit/Write/MultiEdit/NotebookEdit inside the repo's worktrees except .agents/operator.md;
// Bash runs only read-only git (the one exception: a lone `git [-C <dir>] push origin HEAD:<base>` when the profile
// names a base_pusher), no gh merge or ref writes, no shell write into a worktree (redirects and common writers), no
// inline scripts or shells it cannot read. What it cannot parse or resolve is denied (fail closed).
// DEC-08 (any session, only with a profile whose review_trailer is set): a `git merge --no-ff` of a non-base ref, and
// the commit that concludes it, need a readable message with the review trailer in the last paragraph, with Co-Authored-By.
// Outward (every session, every git, gh and GitHub MCP call): destructive actions are denied, shared ones ask where the
// permission mode prompts and are denied elsewhere or when not alone in their call (see "outward actions" below).
// A guardrail against slips, not a sandbox: it does not model every way a program can write a file.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
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
  // complex: an ||, a pipe, a background & or a condition, loop, case or function: a cd's effect is then unknown.
  const p = { s: src, i: 0, cmds: [], env, f: { complex: false } };
  list(p, 0, null);
  p.cmds.complex = p.f.complex;
  return p.cmds;
}

// close: null (top level), ")" (subshell or substitution), "case" (a case branch: ends at ;; ;& ;;& or esac).
function list(p, depth, close) {
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
      if (close !== ")") throw new ParseError("unmatched )");
      if (pending.length) throw new ParseError("heredoc not terminated");
      finish(); p.i++; return;
    }
    if (close === "case" && c === ";" && (s[p.i + 1] === ";" || s[p.i + 1] === "&")) {
      if (pending.length) throw new ParseError("heredoc not terminated");
      finish(); p.i += s.startsWith(";;&", p.i) ? 3 : 2; return;
    }
    if (c === "(") {
      // `name()`: a function definition; its body is checked like any other commands.
      if (cmd.words.length === 1 && !cmd.redirs.length && /^\(\s*\)/.test(s.slice(p.i))) { p.f.complex = true; p.i = s.indexOf(")", p.i) + 1; cmd.words = []; continue; }
      if (cmd.words.length) throw new ParseError("( inside a command");
      finish(); p.i++; list(p, depth + 1, ")"); continue;
    }
    if (!cmd.words.length && !cmd.redirs.length) {
      const kw = /^(case|esac)(?=[\s;&|()<>]|$)/.exec(s.slice(p.i))?.[1];
      if (kw === "esac" && close === "case") { if (pending.length) throw new ParseError("heredoc not terminated"); finish(); return; }
      if (kw === "case") { p.f.complex = true; p.i += 4; caseBody(p, depth); continue; }
      if (/^(if|elif|while|until|select|function)(?=[\s;&|()<>]|$)/.test(s.slice(p.i))) p.f.complex = true;
    }
    if ((c === ";" || c === "|" || c === "&") && !(c === "&" && s[p.i + 1] === ">")) {
      if (!(c === "&" && s[p.i + 1] === "&") && c !== ";") p.f.complex = true;
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
  if (close) throw new ParseError(close === "case" ? "case without esac" : "unclosed (");
  if (pending.length) throw new ParseError("heredoc not terminated");
  finish();
}

function caseBody(p, depth) {
  const s = p.s, blank = () => { while (/[ \t\n]/.test(s[p.i] ?? "")) p.i++; };
  blank();
  if (!word(p, depth)) throw new ParseError("case without a word");
  blank();
  if (!/^in(?=[\s;]|$)/.test(s.slice(p.i))) throw new ParseError("case without in");
  p.i += 2;
  for (;;) {
    blank();
    if (p.i >= s.length) throw new ParseError("case without esac");
    if (/^esac(?=[\s;&|)]|$)/.test(s.slice(p.i))) { p.i += 4; return; }
    if (s[p.i] === "(") p.i++;
    for (;;) {
      blank();
      if (!word(p, depth)) throw new ParseError("bad case pattern");
      blank();
      if (s[p.i] === "|") { p.i++; continue; }
      if (s[p.i] === ")") { p.i++; break; }
      throw new ParseError("bad case pattern");
    }
    list(p, depth + 1, "case");
  }
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
  const s = p.s, start = p.i, subs = [], names = [];
  let lit = "", exp = "", dyn = false, unexp = false, litChars = 0, vars = 0;
  const add = (t) => { lit += t; exp += t; litChars += t.length; };
  const sub = () => { const from = p.cmds.length; list(p, depth + 1, ")"); subs.push([from, p.cmds.length]); dyn = unexp = true; };
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
    dyn = true; vars++; names.push(name);
    const v = p.env[name];
    if (v === undefined) unexp = true; else exp += v;
  };
  const backtick = () => {
    let j = p.i + 1, inner = "";
    for (; j < s.length && s[j] !== "`"; j++) { if (s[j] === "\\" && j + 1 < s.length) { j++; inner += s[j]; } else inner += s[j]; }
    if (j >= s.length) throw new ParseError("unclosed `");
    const q = { s: inner, i: 0, cmds: p.cmds, env: p.env, f: p.f }, from = p.cmds.length;
    list(q, depth + 1, null);
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
  return { lit: dyn ? null : lit, exp: unexp ? null : exp, raw: s.slice(start, p.i), subs, vars: names, onlySub: subs.length === 1 && litChars === 0 && vars === 0 ? subs[0] : null };
}

// ---------- command resolution ----------
const KEYWORDS = new Set(["!", "{", "}", "then", "do", "else", "elif", "if", "while", "until", "fi", "done", "esac"]);
// A variable assignment word: NAME=, NAME+=, NAME[sub]=, NAME[sub]+= (two plain patterns: no nested quantifier, linear time).
export const isAssign = (t) => /^[A-Za-z_]\w*\+?=/.test(t) || /^[A-Za-z_]\w*\[[^\]]*\]\+?=/.test(t);
// `env -S` / `--split-string[=...]`: the argument that makes env run a string it splits itself (opaque to the guard).
export const isEnvSplit = (a) => (/^-[a-zA-Z]*S/.test(a) || a === "--split-string" || a.startsWith("--split-string="));
// Wrapper programs and their options that take a value; the wrapped command follows.
const WRAPPERS = {
  env: ["-u", "--unset", "-C", "--chdir"], command: [], builtin: [], nice: ["-n", "--adjustment"], nohup: [], exec: ["-a"],
  time: [], sudo: ["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U"], timeout: ["-s", "--signal", "-k", "--kill-after"],
  xargs: ["-I", "-n", "-P", "-d", "-L", "-s", "-a", "-E", "-e", "--max-args", "--max-procs", "--delimiter", "--arg-file"], stdbuf: ["-i", "-o", "-e"],
  setsid: [], chronic: [], ionice: ["-c", "-n", "-p", "-P", "-u", "--class", "--classdata", "--pid", "--pgid", "--uid"],
};
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
// Programs that run a command or script the guard cannot see; for the operator they fail closed.
const OPAQUE = new Set(["watch", "script", "flock", "source", "."]);
export const SCRIPTERS = { python: /^-[a-zA-Z]*c$/, python3: /^-[a-zA-Z]*c$/, node: { test: (a) => ["-e", "-p", "--eval", "--print"].includes(a) || a.startsWith("--eval=") || a.startsWith("--print=") }, perl: /^-[a-zA-Z]*[eEi]/, ruby: /^-[a-zA-Z]*[ei]/ };

export function resolveCmd(words) {
  let i = 0, xargs = false;
  for (;;) {
    while (i < words.length && (KEYWORDS.has(words[i].lit) || isAssign(words[i].raw))) i++;
    const w = words[i];
    if (!w) return null;
    if (w.lit === null) return { dynamic: true };
    if (w.lit === "function") { i += 2; continue; }
    const name = basename(w.lit);
    if (name in WRAPPERS) {
      i++; xargs ||= name === "xargs";
      while (i < words.length) {
        const a = words[i].lit;
        if (a === null) return { dynamic: true };
        if (a === "--") { i++; break; }
        if (name === "env" && isAssign(a)) { i++; continue; }
        if (name === "env" && isEnvSplit(a)) return { name, args: [], opaque: true };
        if (!a.startsWith("-") || a === "-") break;
        i += WRAPPERS[name].includes(a) ? 2 : 1;
      }
      if (name === "timeout") i++;
      continue;
    }
    const args = words.slice(i + 1);
    if (OPAQUE.has(name)) return { name, args, opaque: true };
    if (SHELLS.has(name)) {
      const c = args.findIndex((a) => a.lit !== null && /^-[a-z]*c[a-z]*$/.test(a.lit));
      if (c >= 0) { const j = args[c + 1]?.lit === "--" ? c + 2 : c + 1; return { name, args, inner: args[j]?.lit ?? null }; }
      if (args.length && args.every((a) => a.lit === "--version" || a.lit === "--help")) return { name, args, xargs };
      return { name, args, opaque: true };
    }
    if (name === "eval") return { name, args, inner: args.some((a) => a.lit === null) ? null : args.map((a) => a.lit).join(" ") };
    if (SCRIPTERS[name] && args.some((a) => a.lit === null || SCRIPTERS[name].test(a.lit))) return { name, args, scripter: true };
    return { name, args, xargs };
  }
}

// ---------- context (git and the profile); tests pass their own ----------
// A helper git call that times out or cannot run returns FAIL; the outward classes then take the stricter class.
export const FAIL = Object.freeze({ fail: true });
const HELPER_BUDGET_MS = 7000;   // every helper git call of one hook run shares it, so the hook stays under its 10 s timeout
const HELPER_CALL_MS = 3000;     // one helper git call
const todo = (v) => typeof v !== "string" || !v.trim() || /^TODO\b/i.test(v.trim());

// The path with symlinks resolved, for the part of it that exists.
export function real(f) {
  const rest = [];
  for (let cur = f; ; cur = dirname(cur)) {
    try { return join(realpathSync(cur), ...rest); } catch {
      if (dirname(cur) === cur) return f;
      rest.unshift(basename(cur));
    }
  }
}

export function realCtx(cwd, env, budgetMs = HELPER_BUDGET_MS) {
  const deadline = Date.now() + budgetMs;
  const run = (dir, ...a) => {
    const left = deadline - Date.now();
    if (left < 50) return FAIL;
    const r = spawnSync("git", ["-C", dir, ...a], { encoding: "utf8", timeout: Math.min(HELPER_CALL_MS, left) });
    return r.error || r.signal || r.status === null ? FAIL : { code: r.status, out: (r.stdout ?? "").trim() };
  };
  const git = (dir, ...a) => { const r = run(dir, ...a); return r !== FAIL && r.code === 0 ? r.out : null; };
  const project = env.CLAUDE_PROJECT_DIR ? real(resolve(env.CLAUDE_PROJECT_DIR)) : null;
  const list = (git(cwd, "worktree", "list", "--porcelain") ?? "").split("\n").filter((l) => l.startsWith("worktree ")).map((l) => real(resolve(l.slice(9))));
  const roots = [...new Set([...list, ...(project ? [project] : [])])];
  if (!roots.length) roots.push(real(resolve(cwd)));
  const main = list[0] ?? project ?? real(resolve(cwd));
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
          protected: (Array.isArray(data.protected_branches) ? data.protected_branches : []).filter((b) => !todo(b)),
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
    // Outward helpers: a value, null (none) or FAIL (timeout, error, or a name it will not pass to git).
    alias(dir, name) {
      if (!/^[\w.-]+$/.test(name)) return FAIL;
      const r = run(dir, "config", "--get", `alias.${name}`);
      return r === FAIL ? FAIL : r.code === 0 ? r.out : r.code === 1 ? null : FAIL;
    },
    refKind(dir, name) {
      if (name.startsWith("-") || !/^[\w./@{}^~-]+$/.test(name)) return FAIL;
      const r = run(dir, "for-each-ref", "--format=%(refname)", `refs/tags/${name}`, `refs/heads/${name}`, `refs/remotes/origin/${name}`);
      if (r === FAIL || r.code !== 0) return FAIL;
      const l = r.out.split("\n");
      return { tag: l.includes(`refs/tags/${name}`), branch: l.includes(`refs/heads/${name}`), remote: l.includes(`refs/remotes/origin/${name}`) };
    },
    head(dir) { const r = run(dir, "symbolic-ref", "-q", "--short", "HEAD"); return r === FAIL ? FAIL : r.code === 0 ? r.out : null; },
    followTags(dir) {
      const r = run(dir, "config", "--type=bool", "--get", "push.followTags");
      return r === FAIL ? FAIL : r.code === 0 ? r.out === "true" : r.code === 1 ? false : FAIL;
    },
    originHead(dir) {
      const r = run(dir, "symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD");
      if (r === FAIL) return FAIL;
      return r.code === 0 && r.out.startsWith("origin/") ? r.out.slice(7) : null;
    },
    commit(dir, rev) {
      if (rev.startsWith("-") || !/^[\w./@{}^~-]+$/.test(rev)) return null;
      const r = run(dir, "log", "-1", "--format=%h%x09%s", `${rev}^{commit}`, "--");
      if (r === FAIL || r.code !== 0 || !r.out) return null;
      const t = r.out.indexOf("\t");
      return { sha: r.out.slice(0, t), subject: r.out.slice(t + 1) };
    },
  };
}

// ---------- git ----------
const inside = (root, f) => f === root || f.startsWith(root.endsWith(sep) ? root : root + sep);
const shown = (w) => w.raw;

// Global options before the subcommand. A dynamic -C leaves the directory unknown (null): the operator is denied,
// a worker's DEC-08 check still runs, with the session's cwd for the repo state.
function gitSplit(args, cwd, op) {
  // redirect: --git-dir, --work-tree or a -C path that is not literal (the outward classes then cannot tell the repo).
  let i = 0, dir = cwd, config = false, redirect = false;
  while (i < args.length) {
    const a = args[i].lit;
    if (a === null) return { bad: "a dynamic git option" };
    if (a === "-C") {
      const d = args[i + 1]?.exp;
      if (d == null) { if (op || !args[i + 1]) return { bad: "a dynamic git -C path" }; dir = null; i += 2; continue; }
      if (args[i + 1].lit === null) redirect = true;
      dir = isAbsolute(d) ? d : dir && resolve(dir, d); i += 2; continue;
    }
    if (a === "-c" || a === "--config-env") { config = true; i += 2; continue; }
    if (/^(-c.|--config-env=)/.test(a)) { config = true; i++; continue; }
    if (["--git-dir", "--work-tree", "--namespace"].includes(a)) { redirect ||= a !== "--namespace"; i += 2; continue; }
    if (/^--(git-dir|work-tree)=/.test(a)) { redirect = true; i++; continue; }
    if (/^--namespace=/.test(a) || ["--no-pager", "-p", "--paginate", "-P", "--no-replace-objects", "--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs", "--no-optional-locks", "--bare"].includes(a)) { i++; continue; }
    if (["--version", "--help", "--exec-path", "--html-path", "--man-path", "--info-path"].includes(a)) return { dir, config, redirect, sub: "version", rest: [] };
    if (a.startsWith("-")) return { bad: `git option ${a}` };
    return { dir, config, redirect, sub: a, rest: args.slice(i + 1) };
  }
  return { dir, config, redirect, sub: null, rest: [] };
}

// Read-only git: a per-subcommand allowlist of options (default deny; no abbreviations). A spec has
// `bool` long options, `eq` long options that take `=value`, `req` long options whose value may also be the next
// argument, `s` short flags, `sv` short options with a value (attached or next), `so` short options whose value can
// only be attached (the rest of the cluster), and `num` for `-<n>`.
const sp = (o) => ({ bool: new Set((o.bool ?? "").split(" ").filter(Boolean)), eq: new Set((o.eq ?? "").split(" ").filter(Boolean)), req: new Set((o.req ?? "").split(" ").filter(Boolean)), s: o.s ?? "", sv: o.sv ?? "", so: o.so ?? "", num: !!o.num });
const merge = (a, b) => ({ bool: `${a.bool ?? ""} ${b.bool ?? ""}`, eq: `${a.eq ?? ""} ${b.eq ?? ""}`, req: `${a.req ?? ""} ${b.req ?? ""}`, s: (a.s ?? "") + (b.s ?? ""), sv: (a.sv ?? "") + (b.sv ?? ""), so: (a.so ?? "") + (b.so ?? ""), num: a.num || b.num });
const LOG = {
  bool: "oneline stat shortstat numstat name-only name-status graph all decorate no-decorate reverse first-parent merges no-merges patch no-patch raw abbrev-commit no-abbrev-commit full-diff follow cc summary color no-color word-diff color-words cached staged ignore-all-space ignore-space-change ignore-space-at-eol ignore-blank-lines ignore-cr-at-eol minimal patience histogram check exit-code quiet full-index binary no-renames find-renames find-copies find-copies-harder no-ext-diff no-textconv relative no-relative topo-order date-order author-date-order left-right left-only right-only cherry-pick cherry-mark cherry boundary ancestry-path simplify-by-decoration simplify-merges dense sparse full-history show-signature notes no-notes source mailmap use-mailmap no-mailmap remotes branches tags show-pulls dirstat compact-summary show-linear-break children parents ignore-missing all-match invert-grep regexp-ignore-case basic-regexp extended-regexp fixed-strings perl-regexp no-walk do-walk count objects objects-edge single-worktree reflog walk-reflogs irreversible-delete function-context text merge-base no-index no-prefix default-prefix color-moved no-color-moved pickaxe-all pickaxe-regex abbrev no-abbrev root no-commit-id always expand-tabs no-expand-tabs indent-heuristic no-indent-heuristic dual-color no-dual-color submodule ignore-submodules standard-notes no-standard-notes remerge-diff combined-all-paths",
  eq: "format pretty since after until before author committer grep max-count skip date abbrev decorate color word-diff stat dirstat find-renames find-copies diff-filter diff-algorithm unified relative encoding notes show-notes max-parents min-parents exclude glob branches tags remotes submodule ignore-submodules inter-hunk-context anchored color-moved color-moved-ws line-prefix src-prefix dst-prefix output-indicator-new output-indicator-old output-indicator-context break-rewrites rotate-to skip-to diff-merges decorate-refs decorate-refs-exclude creation-factor stat-width stat-name-width stat-graph-width stat-count word-diff-regex expand-tabs ws-error-highlight",
  // req: only options git really takes a separate value for (checked against git 2.53); --format, --pretty are `=` only.
  req: "since after until before author committer grep max-count skip date encoding",
  s: "pusbzwRaiEFPqtWDmcr", sv: "nLSGl", so: "MCBU", num: true,
};
const GIT_SPECS = {
  log: LOG, show: LOG, whatchanged: LOG, "rev-list": LOG, diff: LOG, "diff-tree": LOG, "diff-files": LOG, "diff-index": LOG, cherry: { s: "v", eq: "abbrev" },
  "range-diff": merge(LOG, { bool: "no-dual-color left-only right-only", eq: "creation-factor" }),
  shortlog: { bool: `${LOG.bool} committer numbered summary email`, eq: `${LOG.eq} group`, req: LOG.req.replace(" committer", ""), s: "nsec", so: "w", num: true },
  status: { bool: "short branch long porcelain verbose ahead-behind no-ahead-behind renames no-renames show-stash column no-column null", eq: "porcelain untracked-files ignored ignore-submodules column find-renames", s: "sbvz", so: "u" },
  fetch: { bool: "all prune prune-tags tags no-tags dry-run quiet verbose unshallow force progress no-progress no-recurse-submodules recurse-submodules multiple atomic append refetch write-fetch-head no-write-fetch-head update-shallow no-auto-gc auto-gc ipv4 ipv6 show-forced-updates no-show-forced-updates", eq: "depth deepen shallow-since shallow-exclude recurse-submodules jobs filter", req: "depth deepen shallow-since shallow-exclude jobs filter", s: "pPtnqvfa46", sv: "j" },
  "ls-remote": { bool: "heads tags branches refs quiet exit-code symref get-url", eq: "sort", req: "sort", s: "htbq" },
  "rev-parse": { bool: "verify quiet short abbrev-ref symbolic symbolic-full-name show-toplevel git-dir git-common-dir absolute-git-dir is-inside-work-tree is-inside-git-dir is-bare-repository is-shallow-repository show-prefix show-cdup show-superproject-working-tree all branches tags remotes revs-only no-revs flags no-flags sq not local-env-vars show-object-format show-ref-format keep-dashdash stop-at-non-option", eq: "short abbrev-ref path-format branches tags remotes glob exclude since after until before show-object-format disambiguate", req: "git-path default prefix resolve-git-dir", s: "q" },
  "merge-base": { bool: "all octopus independent is-ancestor fork-point", s: "a" },
  describe: { bool: "tags all long always contains exact-match first-parent dirty broken debug", eq: "abbrev match exclude dirty broken candidates", req: "match exclude candidates" },
  blame: { bool: "porcelain line-porcelain incremental root show-stats show-name show-number reverse first-parent color-lines color-by-age progress no-progress score-debug minimal", eq: "date since abbrev ignore-rev ignore-revs-file encoding", req: "ignore-rev ignore-revs-file date", s: "ltsewpcnfb", sv: "L", so: "MC" },
  "cat-file": { bool: "batch batch-check batch-all-objects buffer unordered follow-symlinks allow-unknown-type batch-command", eq: "batch batch-check batch-command", s: "tsepZ" },
  "ls-files": { bool: "cached deleted modified others ignored stage unmerged killed directory no-empty-directory eol exclude-standard full-name recurse-submodules error-unmatch deduplicate sparse debug resolve-undo abbrev", eq: "exclude exclude-from exclude-per-directory with-tree format abbrev", req: "exclude exclude-from exclude-per-directory with-tree format", s: "cdmoisuktvfz", sv: "xX" },
  "ls-tree": { bool: "long name-only name-status object-only full-name full-tree abbrev", eq: "abbrev format", req: "format", s: "drtlz" },
  grep: { bool: "cached untracked no-index exclude-standard no-exclude-standard recurse-submodules text ignore-case no-ignore-case word-regexp invert-match full-name extended-regexp basic-regexp fixed-strings perl-regexp line-number no-line-number column name-only files-with-matches files-without-match null count color no-color break heading show-function function-context only-matching quiet all-match and or not", eq: "max-depth threads color context after-context before-context max-count", req: "max-depth threads context after-context before-context max-count", s: "aiIwvhHEGFPnlLczqopW", sv: "eABCm" },
  "show-ref": { bool: "head heads branches tags dereference verify quiet exists exclude-existing hash abbrev", eq: "hash abbrev exclude-existing", s: "dsq" },
  "for-each-ref": { bool: "merged no-merged contains no-contains shell perl python tcl color ignore-case omit-empty stdin include-root-refs", eq: "format sort count points-at merged no-merged contains no-contains color exclude", req: "format sort count points-at exclude" },
  "name-rev": { bool: "tags all annotate-stdin name-only no-undefined always stdin", eq: "refs exclude", req: "refs exclude" },
  "check-ignore": { bool: "quiet verbose non-matching no-index stdin", s: "qvnz" },
  "show-branch": { bool: "all remotes topo-order date-order current sparse list merge-base independent no-name sha1-name topics color no-color reflog", eq: "more color reflog", s: "ar" },
  "count-objects": { bool: "verbose human-readable", s: "vH" }, var: { s: "l" }, help: { bool: "all guides", s: "ag" }, version: { bool: "build-options" },
  "symbolic-ref": { bool: "short quiet", s: "q" },
};
for (const k of Object.keys(GIT_SPECS)) GIT_SPECS[k] = sp(GIT_SPECS[k]);
const WORKTREE_LIST = sp({ bool: "porcelain verbose", eq: "expire", req: "expire", s: "vz" });
const BRANCH_SPEC = sp({ bool: "all remotes verbose show-current list contains no-contains merged no-merged points-at ignore-case no-color color column no-column no-abbrev quiet omit-empty", eq: "color column sort format abbrev contains no-contains merged no-merged points-at", s: "arvliq" });
const TAG_SPEC = sp({ bool: "list contains no-contains merged no-merged points-at ignore-case column no-column color omit-empty", eq: "sort format contains no-contains merged no-merged points-at column color", req: "sort format", s: "li", so: "n" });
const CONFIG_SPEC = sp({ bool: "get get-all get-regexp get-urlmatch get-color get-colorbool list global system local worktree show-origin show-scope null name-only includes no-includes bool int bool-or-int path expiry-date", eq: "type default file blob", req: "file blob default type", s: "lz", sv: "f" });
const REMOTE_SHOW = sp({ s: "n" }), REMOTE_URL = sp({ bool: "push all" });

// Returns { bad: option } or { pos: positionals } for args read against a spec.
function readOpts(spec, args) {
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { pos.push(...args.slice(i + 1)); break; }
    if (a.startsWith("--")) {
      const eq = a.indexOf("="), name = eq < 0 ? a.slice(2) : a.slice(2, eq);
      if (eq < 0 && spec.bool.has(name)) continue;
      if (eq >= 0 && (spec.eq.has(name) || spec.req.has(name))) continue;
      if (eq < 0 && spec.req.has(name)) { i++; continue; }
      return { bad: a };
    }
    if (a.length > 1 && a.startsWith("-")) {
      if (spec.num && /^-\d+$/.test(a)) continue;
      for (let k = 1; k < a.length; k++) {
        const ch = a[k];
        if (spec.sv.includes(ch)) { if (k === a.length - 1) i++; break; }
        if (spec.so.includes(ch)) break;
        if (!spec.s.includes(ch)) return { bad: a };
      }
      continue;
    }
    pos.push(a);
  }
  return { pos };
}

// Returns null when the git subcommand is read-only with these arguments, else the reason.
function gitNotReadOnly(sub, rest) {
  const a = rest.map((w) => w.lit);
  if (a.includes(null)) return "an argument it cannot read before it runs";
  const opt = (spec, args = a) => { const r = readOpts(spec, args); return r.bad !== undefined ? { bad: `option ${r.bad} (not on its read-only list)` } : r; };
  const check = (spec, args = a) => opt(spec, args).bad ?? null;
  if (GIT_SPECS[sub]) {
    const r = opt(GIT_SPECS[sub]);
    if (r.bad) return r.bad;
    if ((sub === "fetch" || sub === "ls-remote") && r.pos.slice(1).some((x) => x.includes(":"))) return "a src:dst refspec (a fetch writes refs)";
    if (sub === "symbolic-ref" && r.pos.length > 1) return "a symbolic-ref update";
    return null;
  }
  if (sub === "worktree") return a[0] === "list" ? check(WORKTREE_LIST, a.slice(1)) : "a worktree change";
  if (sub === "branch") {
    const r = opt(BRANCH_SPEC);
    if (r.bad) return r.bad;
    return r.pos.length && !a.some((x) => /^(-[a-z]*[lar][a-z]*|--list|--all|--remotes|--(no-)?contains.*|--(no-)?merged.*|--points-at.*)$/.test(x)) ? "a branch change" : null;
  }
  if (sub === "tag") {
    const r = opt(TAG_SPEC);
    if (r.bad) return r.bad;
    return r.pos.length && !a.some((x) => /^(-[a-z]*l[a-z]*|--list|--(no-)?contains.*|--(no-)?merged.*|--points-at.*)$/.test(x)) ? "a tag change" : null;
  }
  if (sub === "remote") {
    let i = 0;
    while (a[i] === "-v" || a[i] === "--verbose") i++;
    if (i === a.length) return null;
    if (a[i] === "show") return check(REMOTE_SHOW, a.slice(i + 1));
    if (a[i] === "get-url") return check(REMOTE_URL, a.slice(i + 1));
    return "a remote change";
  }
  if (sub === "config") {
    const r = opt(CONFIG_SPEC);
    if (r.bad) return r.bad;
    const read = a.some((x) => /^(--get|--get-all|--get-regexp|--get-urlmatch|--get-color|--get-colorbool|--list|-[a-z]*l[a-z]*)$/.test(x)) || ["get", "list"].includes(r.pos[0]);
    const n = ["get", "list"].includes(r.pos[0]) ? r.pos.length - 1 : r.pos.length;
    return read && n <= 2 ? null : "a config write";
  }
  if (sub === "reflog") {
    if (a[0] === "exists") return a.length === 2 && !a[1].startsWith("-") ? null : "a reflog change";
    if (["expire", "delete", "drop"].includes(a[0])) return "a reflog change";
    return check(GIT_SPECS.log, a[0] === "show" ? a.slice(1) : a);
  }
  if (sub === "stash") return a[0] === "list" || a[0] === "show" ? check(GIT_SPECS.log, a.slice(1)) : "a stash change";
  if (sub === "notes") {
    if (a[0] !== "show" && a[0] !== "list") return "a notes change";
    const o = a.slice(1).find((x) => x.startsWith("-"));
    return o ? `option ${o} (not on its read-only list)` : null;
  }
  return "a subcommand that is not read-only";
}

// ---------- gh ----------
const GH_GLOBAL_VALUED = ["-R", "--repo", "--hostname"];
const GH_API_VALUED = ["-X", "--method", "-f", "-F", "--field", "--raw-field", "-H", "--header", "--input", "-q", "--jq", "-t", "--template", "--hostname", "-p", "--preview", "--cache"];
const GH_WRITE_ENDPOINT = /(^|\/)(merges|pulls|merge|refs|contents|git)(\/|$|\?)/;

// The positionals, api method (null: dynamic), fields, --input, -R/--repo and the other flags of a gh call.
function ghParse(args) {
  const pos = [], fields = [], flags = new Set();
  let method, input = false, repo;
  for (let i = 0; i < args.length; i++) {
    const a = args[i].lit;
    if (a === null) { pos.push(args[i]); continue; }
    if (a === "-X" || a === "--method") { method = args[i + 1] ? args[i + 1].lit : null; i++; continue; }
    if (/^(-X|--method=)./.test(a)) { method = a.replace(/^(-X|--method=)/, ""); continue; }
    if (["-f", "-F", "--field", "--raw-field"].includes(a)) { fields.push(args[i + 1] ?? { lit: null }); i++; continue; }
    if (/^(--field|--raw-field)=/.test(a)) { fields.push({ lit: a.replace(/^[^=]*=/, "") }); continue; }
    if (a === "--input" || a.startsWith("--input=")) { input = true; if (a === "--input") i++; continue; }
    if (a === "-R" || a === "--repo") { repo = args[i + 1]?.lit ?? null; i++; continue; }
    if (a.startsWith("--repo=")) { repo = a.slice(7); continue; }
    if ([...GH_GLOBAL_VALUED, ...GH_API_VALUED].includes(a)) { i++; continue; }
    if (a.startsWith("-")) { flags.add(a.split("=")[0]); continue; }
    pos.push(args[i]);
  }
  return { pos, method, fields, input, repo, flags };
}

function ghDeny(args) {
  const { pos, method: m0, fields, input } = ghParse(args);
  const method = m0 === null ? "?" : m0 ?? null;
  const [p0, p1] = pos.map((w) => w.lit);
  if (p0 === "pr" && (p1 === "merge" || p1 === "checkout")) return `run "gh pr ${p1}" (the merge is the verified local --no-ff merge a worker builds)`;
  if (p0 !== "api") return null;
  const endpoint = p1;
  if (endpoint === "graphql") {
    if (input || fields.some((f) => f.lit === null || /\bmutation\b/.test(f.lit) || /^[^=]*=@/.test(f.lit))) return `run a GraphQL mutation, or a query it cannot read (a variable, @file or --input), through "gh api graphql"`;
    return null;
  }
  const m = (method ?? (fields.length || input ? "POST" : "GET")).toUpperCase();
  if (m !== "GET" && m !== "HEAD" && (endpoint == null || GH_WRITE_ENDPOINT.test(endpoint))) return `run "gh api" ${m} on ${endpoint ?? "an endpoint it cannot read"} (merges, pulls, refs and contents change the repo)`;
  return null;
}

// ---------- writers ----------
// Options with a value, per writer; the targets are the positionals (cp, ln, install, rsync: the last one, or -t).
const WRITERS = {
  tee: { opts: [] }, rm: { opts: [] }, rmdir: { opts: [] }, unlink: { opts: [] }, shred: { opts: ["-n", "-s", "--iterations", "--size"] },
  mkdir: { opts: ["-m", "--mode"] }, touch: { opts: ["-d", "-t", "-r", "--date", "--reference"] }, truncate: { opts: ["-s", "-r", "--size", "--reference"] },
  mv: { opts: ["-S", "--suffix"] }, cp: { opts: ["-S", "--suffix"], last: true }, ln: { opts: ["-S", "--suffix"], last: true },
  install: { opts: ["-m", "-o", "-g", "-S", "--mode", "--owner", "--group", "--suffix"], last: true },
  rsync: { opts: ["-e", "--rsh", "--exclude", "--include", "--filter", "-f", "--files-from", "--exclude-from", "--include-from", "--chmod", "--rsync-path"], last: true },
  chmod: { opts: [], skip: 1 }, chown: { opts: [], skip: 1 }, chgrp: { opts: [], skip: 1 },
};
const CWD = { raw: "the current directory", exp: ".", lit: ".", vars: [] };
const val = (w, s) => ({ ...w, raw: w.raw, exp: w.exp === null ? null : w.exp.slice(s), lit: w.lit === null ? null : w.lit.slice(s) });
const FIND_EXEC_WRITERS = new Set([...Object.keys(WRITERS), "sed", "dd", "patch", "truncate"]);

function positionals(args, opts) {
  const pos = [];
  let ended = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i].lit;
    if (!ended && a === "--") { ended = true; continue; }
    if (!ended && a !== null && a.startsWith("-") && a !== "-") { if (opts.includes(a)) i++; continue; }
    pos.push(args[i]);
  }
  return pos;
}

function writeTargets(name, args) {
  const lits = args.map((w) => w.lit ?? "");
  if (name === "sed") {
    const inPlace = lits.some((a) => /^(-i.*|--in-place.*|-[a-zA-Z]*i[a-zA-Z]*)$/.test(a));
    const pos = [], scripts = [];
    let explicit = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i].lit;
      if (a !== null && /^-[ef]$/.test(a)) { explicit = true; if (a === "-e" && args[i + 1]) scripts.push(args[i + 1]); i++; continue; }
      if (a !== null && /^--(expression|file)/.test(a)) { explicit = true; continue; }
      if (a === "-l") { i++; continue; }
      if (a !== null && a.startsWith("-") && a !== "-") continue;
      pos.push(args[i]);
    }
    if (!explicit && pos.length) scripts.push(pos.shift());
    const writesFile = scripts.some((w) => w.lit === null || /(^|[;{}\s/])[wW]\s+\S/.test(w.lit));
    return [...(inPlace ? pos : []), ...(writesFile ? [CWD] : [])];
  }
  if (name === "awk" || name === "gawk" || name === "mawk") {
    if (lits.some((a) => a === "-i" || a.startsWith("--include") || a === "inplace")) return [CWD];
    const prog = positionals(args, ["-f", "-v", "-F", "--file", "--assign", "--field-separator"])[0];
    return prog && (prog.lit === null || /\b(print|printf)\b[^;}]*>|system\s*\(|\|\s*getline|print[^;}]*\|/.test(prog.lit)) ? [CWD] : [];
  }
  if (name === "patch") {
    const t = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i].lit;
      if ((a === "-d" || a === "--directory" || a === "-o" || a === "--output") && args[i + 1]) { t.push(args[++i]); continue; }
      if (a !== null && /^(-d|-o)./.test(a)) t.push(val(args[i], 2));
    }
    const pos = positionals(args, ["-p", "-i", "-F", "-B", "-z", "-Y", "-V", "-D", "-r", "--input", "--strip", "--fuzz", "--reject-file"]);
    return [...(t.length ? t : [CWD]), ...pos.slice(0, 1)];
  }
  if (name === "dd") return args.filter((w) => w.raw.startsWith("of=")).map((w) => val(w, 3));
  if (name === "curl") {
    const t = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i].lit;
      if (a === null) continue;
      if (a === "-o" || a === "--output" || a === "--output-dir" || (/^-[a-zA-Z]+o$/.test(a))) { if (args[i + 1]) t.push(args[++i]); continue; }
      if (a.startsWith("--output=") || a.startsWith("--output-dir=")) { t.push(val(args[i], a.indexOf("=") + 1)); continue; }
      if (a === "-O" || a === "--remote-name" || a === "--remote-name-all" || /^-[a-zA-Z]*O[a-zA-Z]*$/.test(a)) t.push(CWD);
    }
    return t;
  }
  if (name === "tar") {
    const first = lits[0] ?? "";
    const extract = /^[a-zA-Z]*x/.test(first) && !first.startsWith("-") || lits.some((a) => a === "--extract" || a === "--get" || /^-[a-zA-Z]*x/.test(a));
    if (!extract) return [];
    for (let i = 0; i < args.length; i++) {
      if ((lits[i] === "-C" || lits[i] === "--directory") && args[i + 1]) return [args[i + 1]];
      if (lits[i].startsWith("--directory=")) return [val(args[i], 12)];
    }
    return [CWD];
  }
  if (name === "find") {
    const start = [];
    for (const w of args) { if (w.lit !== null && /^[-(!]/.test(w.lit)) break; start.push(w); }
    const execs = args.flatMap((w, i) => (["-exec", "-execdir", "-ok", "-okdir"].includes(w.lit) ? [args[i + 1]] : []));
    const writes = lits.includes("-delete") || lits.some((a) => /^-fprint/.test(a)) || execs.some((w) => !w || w.lit === null || FIND_EXEC_WRITERS.has(basename(w.lit)));
    return writes ? (start.length ? start : [CWD]) : [];
  }
  const spec = WRITERS[name];
  if (!spec) return [];
  const dirs = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i].lit;
    if (a === "-t" || a === "--target-directory") { if (args[i + 1]) dirs.push(args[i + 1]); i++; }
    else if (a?.startsWith("--target-directory=")) dirs.push(val(args[i], 19));
  }
  const pos = positionals(args, [...spec.opts, "-t", "--target-directory"]).slice(spec.skip ?? 0);
  if (dirs.length) return spec.last ? dirs : [...dirs, ...pos];
  return spec.last ? pos.slice(-1) : pos;
}

// ---------- DEC-08 ----------
function trailerOk(msg, key) {
  const paras = msg.replace(/\r\n/g, "\n").trim().split(/\n[ \t]*\n/);
  const last = paras.pop().split("\n"), lc = key.toLowerCase();
  const has = (lines, k) => lines.some((l) => l.toLowerCase().startsWith(`${k}:`) && l.slice(k.length + 1).trim());
  return has(last, lc) && !paras.some((p) => has(p.split("\n"), "co-authored-by"));
}

// The literal text of a -m value: a static word, or "$(cat <<'EOF' ... EOF)".
function messageOf(w, cmds) {
  if (!w) return null;
  if (w.lit !== null) return w.lit;
  if (!w.onlySub) return null;
  const [from, to] = w.onlySub;
  const c = cmds.slice(from, to);
  if (c.length !== 1 || c[0].heredoc === null || c[0].words.length !== 1 || c[0].words[0].lit !== "cat") return null;
  return c[0].heredoc.replace(/\n+$/, "");
}

function dec08(sub, rest, dir, cmd, cmds, ctx, st) {
  if (sub !== "merge" && sub !== "commit") return null;
  const prof = ctx.profile(dir);
  if (!prof?.trailer) return null;
  const base = prof.base;
  const msgs = [], files = [], pos = [], flags = new Set();
  const valued = sub === "merge" ? ["-s", "-X", "--strategy", "--strategy-option", "--into-name", "--cleanup"] : ["--author", "--date", "--cleanup", "--fixup", "--squash", "-t", "--template", "--trailer", "--pathspec-from-file"];
  const shortValued = sub === "merge" ? "sX" : "t";
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i], a = w.lit;
    if (a === null) { pos.push(w); continue; }
    if (a === "--") { pos.push(...rest.slice(i + 1)); break; }
    if (a === "--message") { msgs.push(messageOf(rest[++i], cmds)); continue; }
    if (a === "--file") { files.push(rest[++i]?.exp ?? null); continue; }
    if (a.startsWith("--message=")) { msgs.push(a.slice(10)); continue; }
    if (a.startsWith("--file=")) { files.push(a.slice(7)); continue; }
    if (sub === "commit" && /^--(reuse|reedit)-message$/.test(a)) { i++; continue; }
    if (a.startsWith("--")) { flags.add(a.split("=")[0]); if (valued.includes(a)) i++; continue; }
    if (/^-[a-zA-Z]+$/.test(a)) {
      for (let k = 1; k < a.length; k++) {
        const ch = a[k];
        if (ch === "m" || ch === "F" || (sub === "commit" && (ch === "C" || ch === "c")) || shortValued.includes(ch)) {
          const v = a.length > k + 1 ? { lit: a.slice(k + 1), exp: a.slice(k + 1) } : rest[++i];
          if (ch === "m") msgs.push(messageOf(v, cmds));
          else if (ch === "F") files.push(v?.exp ?? null);
          break;
        }
        flags.add(`-${ch}`);
      }
      continue;
    }
    pos.push(w);
  }
  const why = `DEC-08: the merge commit message needs the "${prof.trailer}:" trailer (the reviewer that ran and the review pointer, or "<owner> waived - <reason>") in the same last paragraph as Co-Authored-By`;
  const explicit = `${why}; give the message explicitly: use -F with a message file.`;
  const gdir = dir ?? st.cwd;
  const inMerge = () => {
    if (st.merging) return true;
    const head = gdir && ctx.mergeHead(gdir);
    return !!head && !(base && ctx.baseShas(gdir, base).includes(head));
  };
  if (sub === "merge") {
    if (flags.has("--abort") || flags.has("--quit")) return null;
    if (flags.has("--continue")) return inMerge() ? explicit : null;
    if (!flags.has("--no-ff") || !pos.length) return null;
    const baseRefs = base ? [base, `origin/${base}`, `refs/heads/${base}`, `refs/remotes/origin/${base}`] : [];
    const catchUpRef = (w) => w.lit === "FETCH_HEAD" || baseRefs.includes(w.lit) || (/^[0-9a-f]{7,40}$/.test(w.lit ?? "") && !!base && !!gdir && ctx.baseShas(gdir, base).some((h) => h.startsWith(w.lit)));
    if (pos.every(catchUpRef)) return null;
    if (flags.has("--no-commit")) { st.merging = true; return null; }
  } else {
    if (flags.has("--amend") || !inMerge()) return null;
  }
  if (!msgs.length && !files.length) return explicit;
  const texts = [...msgs];
  for (const f of files) texts.push(f === "-" ? cmd.heredoc : f === null ? null : isAbsolute(f) || dir ? ctx.readFile(isAbsolute(f) ? f : resolve(dir, f)) : null);
  if (texts.some((t) => t === null || t === undefined)) return `${why}; this message cannot be read before it runs: use -F with a message file.`;
  return trailerOk(texts.join("\n\n"), prof.trailer) ? null : `${why}; fix the message file and pass it with -F.`;
}

// ---------- the walk over the commands ----------
const DECLARE = new Set(["export", "declare", "typeset", "local", "readonly"]);
// `$(mktemp)`, `$(mktemp -d)`, `$(mktemp [-d] -t NAME.XXXX)`: a new path in the temp dir. Not -p, --tmpdir or a template path.
export function isMktempAssign(raw) {
  const m = /^[A-Za-z_]\w*=("?)\$\(/.exec(raw);
  if (!m || !raw.endsWith(`)${m[1]}`)) return false;
  const inner = raw.slice(m[0].length, raw.length - 1 - m[1].length).trimStart();
  if (!inner.startsWith("mktemp")) return false;
  const rest = inner.slice("mktemp".length);
  if (rest.trim() === "") return true;
  if (!/^\s/.test(rest)) return false;
  const tokens = rest.trim().split(/\s+/);
  for (let k = 0; k < tokens.length; k++) {
    if (["-d", "-q", "--directory", "--quiet"].includes(tokens[k])) continue;
    if (/^-[dq]*t$/.test(tokens[k]) && /^[\w.-]+$/.test(tokens[k + 1] ?? "")) { k++; continue; }
    return false;
  }
  return true;
}

// Records the variables a command assigns: prefix assignments, export/declare, read, for, mapfile.
function assigns(cmd, r, st) {
  const set = (raw) => {
    const m = isMktempAssign(raw);
    const name = /^[A-Za-z_]\w*/.exec(raw)?.[0];
    if (!name) return;
    st.assigned.add(name);
    if (m) st.temp.add(name); else st.temp.delete(name);
  };
  const w = cmd.words;
  let i = 0;
  while (i < w.length && KEYWORDS.has(w[i].lit)) i++;
  if (w[i]?.lit === "for" || w[i]?.lit === "select") { if (w[i + 1]) set(w[i + 1].raw); return; }
  for (; i < w.length && isAssign(w[i].raw); i++) set(w[i].raw);
  if (!r || r.dynamic) return;
  if (DECLARE.has(r.name)) for (const a of r.args) { if (!a.raw.startsWith("-")) set(a.raw); }
  if (r.name === "read") {
    for (let k = 0; k < r.args.length; k++) {
      const a = r.args[k].raw;
      if (/^-[pdntuN]$/.test(a)) { k++; continue; }
      if (a === "-a") { if (r.args[k + 1]) set(r.args[++k].raw); continue; }
      if (!a.startsWith("-")) set(a);
    }
  }
  if ((r.name === "mapfile" || r.name === "readarray") && r.args.length) set(r.args[r.args.length - 1].raw);
  if (r.name === "printf") for (let k = 0; k < r.args.length; k++) { const a = r.args[k].raw; if (a === "-v" && r.args[k + 1]) set(r.args[++k].raw); else if (/^-v\w/.test(a)) set(a.slice(2)); }
}

const deny = (what) => `OPR-01: the operator session does not ${what}; ${DELEGATE}.`;

function checkCmds(cmds, st, ctx, op, total) {
  for (const cmd of cmds) {
    const r = resolveCmd(cmd.words);
    if (op) {
      for (const { target } of cmd.redirs) { const d = target_(target, st, ctx); if (d) return deny(`write ${d} (shell redirect)`); }
      if (r?.dynamic) return deny("run a command whose program it cannot tell before it runs");
    }
    assigns(cmd, r, st);
    if (!r || r.dynamic) continue;
    if (r.name === "cd" || r.name === "pushd") {
      const t = r.args.find((w) => w.lit === null || !w.lit.startsWith("-") || w.lit === "-");
      const e = t ? expOf(t, st) : st.env.HOME;
      st.cwd = cmd.depth > 0 || st.complex || e == null || e === "-" ? null : isAbsolute(e) ? e : st.cwd && resolve(st.cwd, e);
      continue;
    }
    if (r.name === "popd") { st.cwd = null; continue; }
    if (r.opaque) { if (op) return deny(`run "${r.name}" with a command or script it cannot check (run it via a worker)`); continue; }
    if (r.scripter) { if (op) return deny(`run "${r.name}" with inline code (script writers: delegate to a worker)`); continue; }
    if ("inner" in r) {
      if (r.inner === null) { if (op) return deny(`run ${r.name} with a script it cannot read (run it via a worker)`); continue; }
      let inner;
      try { inner = parseShell(r.inner, st.env); } catch { if (op) return deny(`run a ${r.name} script it cannot parse (run it via a worker)`); continue; }
      // eval runs in this shell (shared cwd and variables); sh -c in a child (a copy).
      const sub = r.name === "eval" ? st : { ...st, assigned: new Set(st.assigned), temp: new Set(st.temp) };
      sub.complex ||= inner.complex;
      const d = checkCmds(inner, sub, ctx, op, total + inner.length);
      if (d) return d;
      continue;
    }
    if (r.name === "git") {
      const g = gitSplit(r.args, st.cwd, op);
      if (g.bad) { if (op) return deny(`run git with ${g.bad}`); continue; }
      if (op && g.config) return deny("run git with -c (a config override can run a program)");
      if (!g.sub) continue;
      const why = op ? gitNotReadOnly(g.sub, g.rest) : null;
      if (!why) {
        const d8 = dec08(g.sub, g.rest, g.dir, cmd, cmds, ctx, st);
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
      return deny(`run "git ${g.sub}${g.rest.length ? " " + g.rest.map(shown).join(" ") : ""}" (${why})`);
    }
    if (!op) continue;
    if (r.name === "gh") { const d = ghDeny(r.args); if (d) return deny(d); continue; }
    const targets = writeTargets(r.name, r.args);
    if (r.xargs && (targets.length || r.name in WRITERS || r.name === "sed")) return deny(`run "xargs ${r.name}" (its targets are unknown before it runs)`);
    for (const t of targets) { const d = target_(t, st, ctx); if (d) return deny(`write ${d} (${r.name})`); }
  }
  return null;
}

// A word's expansion, or null when it uses a variable this command assigns (its value is unknown here).
const expOf = (w, st) => ((w.vars ?? []).some((v) => st.assigned.has(v)) ? null : w.exp);

// Returns a description when the write target is (or may be) inside a worktree of the repo, else null.
function target_(w, st, ctx) {
  const vs = w.vars ?? [];
  const lead = /^"?\$\{?([A-Za-z_]\w*)\}?(["/]|$)/.exec(w.raw);
  if (lead && st.temp.has(lead[1]) && vs.every((v) => st.temp.has(v)) && !/(^|\/)\.\.(\/|"|$)/.test(w.raw)) return null;
  if (vs.some((v) => st.assigned.has(v))) return `${shown(w)}, a path with a variable set in this command`;
  if (w.exp === null) return `${shown(w)}, a path it cannot resolve before it runs`;
  if (!isAbsolute(w.exp) && !st.cwd) return `${shown(w)} in an unknown directory`;
  const f = real(resolve(st.cwd ?? "/", w.exp));
  if (ctx.operatorFiles.includes(f)) return null;
  return ctx.roots.some((r) => inside(r, f)) ? `${shown(w)} inside the repo` : null;
}

// ---------- outward actions (every session): git, gh and GitHub MCP calls that reach the forge ----------
// Classes: local and branch push (silent), shared (ask where the permission mode prompts, else deny; denied when not alone
// in its call), destructive (deny in every mode; the owner runs it with `!`). Protected branches: main, master, release/*,
// the target of origin/HEAD, plus the profile's base_branch and protected_branches (the profile only adds). A helper git call
// that fails or times out gives the stricter class. Reasons use one short fixed shape built from parsed fields, never the command line.
const ASK_MODES = new Set(["default", "acceptEdits", "plan", "auto", "bypassPermissions"]);
const GITGH = /\b(git|gh)\b/;
const COND1 = /\b(push|tag|release|api|pr|repo|config|auth)\b|--delete|\bgh\s+(run|workflow)\b/;
const TOKENISH = /gh[pousr]_|github_pat_|glpat-|xox[a-z]-|AKIA[0-9A-Z]{12}|[A-Za-z0-9]{32,}/;
const TOKENISH_ALL = /gh[pousr]_\w*|github_pat_\w*|glpat-[\w-]*|xox[a-z]-[\w-]*|AKIA[0-9A-Z]{12}|[A-Za-z0-9]{32,}/g;
// Key shapes are plain string checks (the unsafe-regex rule). keyIs(head, tails, mid): the key is head.<tail>; mid "req" needs a
// non-empty subsection between them, "opt" allows one, "none" forbids one.
const keyIs = (head, tails, mid = "none") => (k) => {
  const key = k.toLowerCase();
  if (!key.startsWith(`${head}.`)) return false;
  const rest = key.slice(head.length + 1);
  return tails.some((t) => (mid !== "req" && rest === t) || (mid !== "none" && rest.length > t.length + 1 && rest.endsWith(`.${t}`)));
};
const keyPrefix = (p) => (k) => k.toLowerCase().startsWith(p);
const CONFIG_KEYS = [keyPrefix("alias."), keyIs("core", ["hookspath"]), keyPrefix("remote."), keyPrefix("url."), keyPrefix("push."), (k) => {
  const key = k.toLowerCase();
  return key === "include.path" || (key.startsWith("includeif.") && key.length > "includeif..path".length && key.endsWith(".path"));
}];
// Keys whose value git runs as a command; a -c of one asks unless the value is a harmless pager or editor.
const COMMAND_KEYS = [keyIs("core", ["pager", "editor", "sshcommand", "fsmonitor", "askpass", "gitproxy", "alternaterefscommand"]), keyPrefix("pager."),
  keyIs("sequence", ["editor"]), keyIs("diff", ["external"]), keyIs("diff", ["textconv", "command"], "req"), keyIs("merge", ["driver"], "req"),
  keyIs("filter", ["clean", "smudge", "process"], "req"), keyIs("credential", ["helper"], "opt"), keyIs("gpg", ["program"], "opt"),
  ...["difftool", "mergetool", "browser", "man"].map((h) => keyIs(h, ["cmd", "path"], "req")), keyIs("uploadpack", ["packobjectshook"]),
  keyIs("sendemail", ["smtpserver", "tocmd", "cccmd", "headercmd"], "opt"), keyIs("trailer", ["cmd", "command"], "req")];
const HARMLESS_CMD = new Set(["", "cat", "less", "more", "true", "false", ":"]);
// Built-ins that run commands or other git commands they are given; the push-capable plumbing.
const GIT_RUNNERS = new Set(["for-each-repo", "filter-branch", "difftool", "mergetool"]);
const GIT_PUSHERS = new Set(["send-pack", "http-push", "receive-pack"]);
const GIT_BUILTINS = new Set(("add am annotate apply archive backfill bisect blame branch bundle cat-file check-attr check-ignore check-mailmap check-ref-format " +
  "checkout checkout-index cherry cherry-pick citool clean clone column commit commit-graph commit-tree config count-objects credential describe diff " +
  "diff-files diff-index diff-tree difftool fetch fetch-pack filter-branch fmt-merge-msg for-each-ref for-each-repo format-patch fsck gc get-tar-commit-id " +
  "grep gui hash-object help hook index-pack init instaweb interpret-trailers log ls-files ls-remote ls-tree mailinfo mailsplit maintenance merge merge-base " +
  "merge-file merge-index merge-tree mergetool mktag mktree multi-pack-index mv name-rev notes pack-objects pack-refs patch-id prune prune-packed pull " +
  "range-diff read-tree rebase reflog refs remote repack replace replay request-pull rerere reset restore rev-list rev-parse revert rm shortlog show " +
  "show-branch show-ref sparse-checkout stash status stripspace submodule switch symbolic-ref tag unpack-objects update-index update-ref var " +
  "verify-commit verify-pack verify-tag version whatchanged worktree write-tree").split(" "));
const GH_TOP = new Set(("agent-task alias api attestation auth browse cache codespace completion config copilot extension gist gpg-key help issue label " +
  "org pr preview project release repo ruleset run search secret ssh-key status variable version workflow").split(" "));
const GH_OUT_ENDPOINT = /(^|\/)(merges|pulls|merge|refs|contents|git|releases|actions|branches|tags)(\/|$|\?)/;
// git push's long options (git 2.53 `push --git-completion-helper-all`); git accepts any unique prefix.
const PUSH_LONG = "verbose quiet repo all branches mirror delete tags dry-run porcelain force force-with-lease force-if-includes recurse-submodules thin receive-pack exec set-upstream progress prune follow-tags signed atomic push-option".split(" ");
const PUSH_OPTS = [...PUSH_LONG, ...PUSH_LONG.map((o) => `no-${o}`), "no-verify", "verify", "ipv4", "ipv6"];
const PUSH_VALUED = new Set(["repo", "recurse-submodules", "receive-pack", "exec", "push-option"]);
const pushLong = (n) => { if (PUSH_OPTS.includes(n)) return n; const c = PUSH_OPTS.filter((o) => o.startsWith(n)); return n && c.length === 1 ? c[0] : null; };
// Ref namespaces a short destination can resolve to on the remote that are neither branches nor tags.
const OTHER_NS = /^(remotes|notes|pull|replace|stash)\//;

// A value fit for a reason: no URL, query, token-looking run or shell text.
export function safe(v) {
  if (typeof v !== "string" || v === "") return "?";
  if (TOKENISH.test(v)) return "<redacted>";
  const s = v.split("?")[0];
  if (s === "") return "?";
  if (s.includes("://") || /^[^@]*@[^{]/.test(s)) return "<url>";
  if (/[^\w./@{}^~+:*#=,-]/.test(s)) return "…";
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}
const argShow = (w) => (w.lit === null ? "<?>" : safe(w.lit));
const remoteShow = (r) => (r == null ? "?" : r === "origin" ? "origin" : /[:/@]/.test(r) ? "<url>" : safe(r));
const sessionBy = (input) => (input?.agent_id ? `subagent ${safe(input.agent_type ?? "?")}` : null);

// The reason: a headline, then only the rows that apply (at most 6 lines). kind: ASK or DENY.
export function outwardReason(kind, f, input, extra = {}) {
  const rows = [`orbit · ${kind} · ${f.what}`];
  const row = (k, v) => rows.push(`${k.padEnd(9)}${v}`);
  row("action", f.action);
  if (f.commit) row("commit", `${f.commit.sha} "${String(f.commit.subject).replace(/[\p{Cc}"]/gu, "").replace(TOKENISH_ALL, "<redacted>").slice(0, 60)}"`);
  const by = sessionBy(input);
  if (by) row("by", by);
  if (extra.note) row("note", extra.note);
  row("do", extra.do ?? (kind === "ASK" ? "approve only if you gave the go" : f.cmd ? `run it yourself with ! ${f.cmd}` : "do it yourself, outside the agent"));
  return rows.join("\n");
}

// The shorthands git resolves in a refspec side: `@` is HEAD, `heads/X` a branch, `tags/X` a tag.
const short = (s) => (s === "@" ? "HEAD" : /^(heads|tags)\//.test(s) ? `refs/${s}` : s);
// git push: force, deletes, tags, unknown targets and protected candidates (resolved after the walk).
function pushOut(rest, dir, cwd, getCtx, add, xargs) {
  let force = false, del = false, wide = false, other = false, unknown = false;
  const pos = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i].lit;
    if (a === null) { pos.push(null); continue; }
    if (a === "--") { pos.push(...rest.slice(i + 1).map((w) => w.lit)); break; }
    if (a.startsWith("--")) {
      const eq = a.indexOf("="), n = pushLong(a.slice(2, eq < 0 ? undefined : eq));
      if (n === null) { unknown = true; continue; }
      if (PUSH_VALUED.has(n) && eq < 0) i++;
      if (["force", "force-with-lease", "force-if-includes", "mirror", "prune"].includes(n)) force = true;
      else if (n === "delete") del = true;
      else if (["tags", "follow-tags", "all", "branches"].includes(n)) wide = true;
      else if (["repo", "receive-pack", "exec"].includes(n)) other = true;
      continue;
    }
    if (a.length > 1 && a.startsWith("-")) {
      for (let k = 1; k < a.length; k++) {
        if (a[k] === "f") force = true;
        else if (a[k] === "d") del = true;
        else if (a[k] === "o") { if (k === a.length - 1) i++; break; }
      }
      continue;
    }
    pos.push(a);
  }
  const remote = pos[0], specs = pos.slice(1), rs = remoteShow(remote);
  const cmd = `git ${dir && dir !== cwd ? `-C ${safe(dir)} ` : ""}push ${rest.map(argShow).join(" ")}`.trim();
  const flag = force ? " --force" : del ? " --delete" : "";
  const f = (cls, what, dst, more = {}) => add({ cls, what, sub: "push", action: `git push${flag} → ${rs}/${safe(dst ?? "?")}`, refs: [`${rs}/${safe(dst ?? "?")}`], dst, cmd, dir, ...more });
  const dstOf = (s) => (s == null ? null : s.includes(":") ? s.slice(s.indexOf(":") + 1) : s.replace(/^\+/, ""));
  if (force || specs.some((s) => s?.startsWith("+"))) return f("destructive", "force push", dstOf(specs.find((s) => s !== "") ?? null));
  const dels = (del ? specs : specs.filter((s) => s !== null && s.startsWith(":")).map((s) => s.slice(1))).map((s) => (s === null ? s : short(s)));
  if (del || dels.length) {
    if (remote !== "origin" || !dir || !dels.length || xargs) return f("destructive", "remote delete of a target it cannot read", dels[0] ?? null);
    for (const t of dels) {
      if (!t) { f("destructive", "remote delete of a target it cannot read", t); continue; }
      if (t.startsWith("refs/tags/")) { f("destructive", "tag delete", t.slice(10)); continue; }
      if (t.startsWith("refs/heads/")) { f("candidate", "", t.slice(11), { del: true }); continue; }
      if (t.startsWith("refs/")) { f("destructive", "remote delete of a target it cannot read", t); continue; }
      const k = getCtx().refKind(dir, t);
      if (k === FAIL || k.tag) f("destructive", k === FAIL ? "remote delete of a target it cannot read" : "tag delete", t);
      else if (k.branch || k.remote) f("candidate", "", t, { del: true });
      else f("destructive", "remote delete of a target it cannot read", t);
    }
    if (del) return;
  }
  const plain = specs.filter((s) => !(s !== null && s.startsWith(":")));
  if (unknown) return f("shared", "push with an option it cannot read", dstOf(plain[0]));
  if (xargs) return f("shared", "push with arguments it cannot read", null);
  if (!dir) return f("shared", "push from a directory it cannot tell", dstOf(plain[0]));
  if (remote === undefined) return f("shared", "push with no remote or refspec", null);
  if (remote !== "origin") return f("shared", remote !== null && /[:/@]/.test(remote) ? "push to a URL" : "push to another remote", dstOf(plain[0]));
  if (other) return f("shared", "push with --repo, --receive-pack or --exec", dstOf(plain[0]));
  if (wide) return f("shared", "push of tags or all branches", dstOf(plain[0]) ?? "*");
  if (!plain.length && !dels.length) return f("shared", "push with no refspec", null);
  for (const s of plain) {
    if (s === null || s.includes("*") || s === "") { f("shared", "push with a refspec it cannot read", s); continue; }
    const c = s.indexOf(":"), src = short(c < 0 ? s : s.slice(0, c));
    let dst = c < 0 ? null : short(s.slice(c + 1));
    if (dst === null && src === "HEAD") {
      const h = getCtx().head(dir);
      if (h === FAIL || !h) { f("shared", "push of HEAD on a branch it cannot read", "HEAD"); continue; }
      dst = h;
    }
    dst ??= src;
    if (dst.startsWith("refs/tags/") || src.startsWith("refs/tags/")) { f("shared", "tag push", dst.replace(/^refs\/tags\//, ""), { rev: src }); continue; }
    const qualified = dst.startsWith("refs/heads/");
    if (qualified) dst = dst.slice(11);
    else if (dst.startsWith("refs/") || dst === "HEAD" || OTHER_NS.test(dst)) { f("shared", "push to a ref outside branches", dst); continue; }
    const names = [...new Set([src !== "HEAD" && !src.startsWith("refs/") && !/^[0-9a-f]{7,40}$/.test(src) ? src : null, qualified ? null : dst].filter(Boolean))];
    const kinds = names.map((n) => getCtx().refKind(dir, n));
    if (kinds.includes(FAIL)) { f("shared", "push of a ref it cannot read", dst); continue; }
    if (kinds.some((k) => k.tag && !k.branch)) { f("shared", "tag push", dst, { rev: src }); continue; }
    f("candidate", "", dst, { rev: src });
  }
}

// git config writes and -c/--config-env overrides that can redirect a push or run a command.
const riskyKey = (k) => [...CONFIG_KEYS, ...COMMAND_KEYS].some((r) => r(k));
function gitConfigOut(args, add) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i].lit;
    if (a === null) return;
    let kv = null;
    if (a === "-c") kv = args[++i]?.lit ?? null;
    else if (/^-c./.test(a)) kv = a.slice(2);
    else if (a === "--config-env" || a.startsWith("--config-env=")) return add({ cls: "shared", what: "git config from the environment", sub: "config", action: "git --config-env", refs: [], cmd: null });
    else if (["-C", "--git-dir", "--work-tree", "--namespace"].includes(a)) { i++; continue; }
    else if (a.startsWith("-")) continue;
    else return;
    const key = kv === null ? null : kv.split("=")[0], value = kv === null ? null : kv.slice(key.length + 1);
    if (kv === null || CONFIG_KEYS.some((r) => r(key)) || (COMMAND_KEYS.some((r) => r(key)) && !HARMLESS_CMD.has(value.trim())) || GITGH.test(value)) return add({ cls: "shared", what: "git config that can redirect a command", sub: "config", action: `git -c ${safe(key ?? "?")}`, refs: [], cmd: null });
  }
}

// A plumbing push that forces or deletes (or has an argument it cannot read).
const forcedPlumbing = (lits) => lits.some((x) => x === null || /^[+:]/.test(x) || (/^-[^-]/.test(x) && /[fdD]/.test(x)) ||
  (x.length > 3 && ["force", "mirror", "delete"].some((n) => `--${n}`.startsWith(x.split("=")[0]))));

// loose: a git word found among another program's arguments; an unknown subcommand there is no git call.
function gitOut(r, st, getCtx, add, depth, loose = false) {
  const g = gitSplit(r.args, st.cwd, false);
  gitConfigOut(r.args, add);
  if (g.bad) return add({ cls: "shared", what: "git with an option it cannot read", sub: "git", action: "git", refs: [], cmd: null });
  if (!g.sub) { if (r.xargs) add({ cls: "shared", what: "git with arguments it cannot read", sub: "git", action: "git", refs: [], cmd: null }); return; }
  const sub = g.sub, rest = g.rest, shared = (what) => add({ cls: "shared", what, sub, action: `git ${safe(sub)}`, refs: [], cmd: null });
  const redirect = g.redirect || r.redirect || st.gitEnv;
  if (sub === "push") return pushOut(rest, redirect ? null : g.dir, st.cwd, getCtx, add, r.xargs);
  if (GIT_PUSHERS.has(sub)) {
    if (!forcedPlumbing(rest.map((w) => w.lit))) return shared("low-level push");
    return add({ cls: "destructive", what: "low-level forced push or delete", sub, action: `git ${safe(sub)}`, refs: [], cmd: null });
  }
  if (GIT_RUNNERS.has(sub)) return shared("git running a command");
  if (sub === "config") {
    if (!gitNotReadOnly("config", rest)) return;
    const lits = rest.map((w) => w.lit);
    if (lits.includes(null) || lits.some((x) => x === "-e" || x === "--edit") || lits.some((x) => riskyKey(x))) return shared("git config that can redirect a command");
    return;
  }
  if ((sub === "submodule" || sub === "rebase" || sub === "bisect") && GITGH.test(rest.map((w) => w.raw).join(" "))) return shared("git running a command");
  if (GIT_BUILTINS.has(sub)) return;
  if (depth > 2 || !g.dir) return shared("unknown git subcommand");
  const a = getCtx().alias(g.dir, sub);
  if (a === null && loose) return;
  if (a === FAIL || a === null) return shared("unknown git subcommand");
  if (a.trim().startsWith("!")) return shared("git shell alias");
  const words = a.trim().split(/\s+/).map((lit) => ({ lit, exp: lit, raw: lit, vars: [] }));
  return gitOut({ ...r, redirect, args: [...(g.dir !== st.cwd ? [{ lit: "-C", raw: "-C" }, { lit: g.dir, exp: g.dir, raw: g.dir }] : []), ...words, ...rest] }, st, getCtx, add, depth + 1);
}

function ghOut(r, add, loose = false) {
  const p = ghParse(r.args), [p0, p1] = p.pos.map((w) => w.lit);
  const where = p.repo === undefined ? "" : ` in ${safe(p.repo)}`;
  const cmd = `gh ${r.args.map(argShow).join(" ")}`;
  const target = p.pos.slice(2).map(argShow).join(" ");
  const f = (cls, what, action) => add({ cls, what, sub: [p0, p1].filter(Boolean).join(" "), action: `${action ?? `gh ${p0} ${p1 ?? "?"}${target ? ` ${target}` : ""}`}${where}`, refs: [target || safe(p1 ?? "?")], cmd });
  if (!p.pos.length) { if (r.xargs) f("shared", "gh with arguments it cannot read", "gh"); return; }
  if (p0 === null || (p1 === null && p0 !== "api")) return f("shared", "gh command it cannot read", "gh");
  if (!GH_TOP.has(p0)) return loose ? undefined : f("shared", "unknown gh command (an alias or extension)", `gh ${safe(p0)}`);
  if (p1 === undefined && r.xargs && ["release", "repo", "pr", "run", "workflow", "auth", "alias"].includes(p0)) return f("shared", "gh command it cannot read");
  if (p0 === "auth" && ["token", "login", "refresh", "setup-git"].includes(p1)) return f("shared", "GitHub credential access");
  if (p0 === "alias" && ["set", "import"].includes(p1)) return f("shared", "gh alias");
  if (p0 === "release") {
    if (p1 === "delete" || p1 === "delete-asset") return f("destructive", p1 === "delete" ? "release delete" : "release asset delete");
    if (p1 === "upload") return p.flags.has("--clobber") ? f("destructive", "release asset overwrite") : f("shared", "release upload");
    if (p1 === "create" || p1 === "edit") return f("shared", `release ${p1}`);
    return;
  }
  if (p0 === "repo" && (p1 === "delete" || p1 === "archive")) return f("destructive", `repo ${p1}`);
  if (p0 === "repo" && p1 === "edit") return [...p.flags].some((x) => /^--(visibility|archive)/.test(x)) ? f("destructive", "repo visibility or archive change") : f("shared", "repo settings edit");
  if (p0 === "repo" && p1 === "rename") return f("shared", "repo rename");
  if (p0 === "pr" && p1 === "merge") return f("shared", "pull request merge");
  if (p0 === "run" && (p1 === "cancel" || p1 === "rerun")) return f("shared", `run ${p1}`);
  if (p0 === "workflow" && p1 === "run") return f("shared", "workflow dispatch");
  if (p0 !== "api") return;
  const ep = p1 ?? null, epShow = ep === null ? "<?>" : safe(ep);
  if (p.method === null) return f("destructive", "gh api with a method it cannot read", `gh api ? ${epShow}`);
  const m = (p.method ?? (p.fields.length || p.input ? "POST" : "GET")).toUpperCase();
  if (m === "DELETE") return f("destructive", "gh api DELETE", `gh api DELETE ${epShow}`);
  const unread = p.input || p.fields.some((x) => x.lit === null || /^[^=]*=@/.test(x.lit));
  const body = p.fields.map((x) => x.lit ?? "").join("\n");
  if (ep === "graphql") {
    if (unread || !/\bmutation\b/.test(body)) return unread ? f("shared", "GraphQL mutation", "gh api graphql") : undefined;
    if (/\b(deleteRef|deleteRepository|archiveRepository)\b/.test(body) || (/\bupdateRefs?\b/.test(body) && /\bforce\s*[:=]\s*true\b/.test(body))) return f("destructive", "GraphQL delete, archive or forced ref update", "gh api graphql");
    return f("shared", "GraphQL mutation", "gh api graphql");
  }
  if (m === "GET" || m === "HEAD") return;
  const path = ep === null ? null : ep.replace(/^https?:\/\/[^/]+/, "").replace(/^\//, "").split("?")[0];
  if (path !== null && /^repos\/[^/]+\/[^/]+\/?$/.test(path)) {
    if (unread || p.fields.some((x) => /^archived=true$/i.test(x.lit))) return f("destructive", "repo archive (or a body it cannot read)", `gh api ${safe(m)} ${epShow}`);
    return f("shared", "repo settings write", `gh api ${safe(m)} ${epShow}`);
  }
  if (path !== null && m === "PATCH" && /(^|\/)git\/refs\//.test(path) && (unread || p.fields.some((x) => /^force=true$/i.test(x.lit)))) return f("destructive", "forced ref update (or a body it cannot read)", `gh api ${safe(m)} ${epShow}`);
  if (ep === null || GH_OUT_ENDPOINT.test(ep)) return f("shared", `gh api ${safe(m)}`, `gh api ${safe(m)} ${epShow}`);
}

// Walks the commands like checkCmds (wrappers, sh -c, eval, cd) and adds a finding per outward action.
// Programs that take git or gh as data (a pattern, a page, a package), never as a command to run.
const DATA_PROGRAMS = new Set(("echo printf grep egrep fgrep rg ag ack man which whereis type help info apropos whatis tldr cat bat less more head tail " +
  "wc sort uniq tr cut ls file stat basename dirname realpath readlink test [ printenv jq yq sed awk apt apt-get brew dnf yum pacman apk snap").split(" "));
// Programs that substitute or append arguments to the command they run.
const SUBST_PROGRAMS = new Set(["find", "fd", "parallel"]);
const GIT_SUBS = new Set([...GIT_BUILTINS, ...GIT_PUSHERS, ...GIT_RUNNERS, "push"]);
const isGitWord = (lit) => { const b = basename(lit); return b === "git" || b === "gh" || (b.startsWith("git-") && GIT_SUBS.has(b.slice(4))); };
const GIT_ENV = /^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR)=/;

// A git, git-<sub> or gh command (loose: found among another program's arguments).
function gitGhOut(r, st, getCtx, add, loose) {
  if (r.name === "gh") return ghOut(r, add, loose);
  const args = r.name === "git" ? r.args : [{ lit: r.name.slice(4), exp: r.name.slice(4), raw: r.name.slice(4), vars: [] }, ...r.args];
  return gitOut({ ...r, args }, st, getCtx, add, 0, loose);
}

// Walks the commands like checkCmds (wrappers, sh -c, eval, cd) and adds a finding per outward action.
function outWalk(cmds, st, getCtx, add, text) {
  if (cmds.length > 1 || cmds.complex) st.out.multi = true;
  // Condition 1 on the text the guard cannot read: a dynamic or unparseable string, or the words and heredoc of a script runner.
  const unreadable = (t) => { if (GITGH.test(t) && COND1.test(t)) add({ cls: "shared", what: "a command the guard cannot read", sub: "unknown", action: "git or gh inside a script or shell it cannot read", refs: [], cmd: null }); };
  // Another program with a git or gh word among its arguments (find -exec, unbuffer, parallel, ...): that word on is the command.
  const embedded = (r) => {
    if (DATA_PROGRAMS.has(r.name)) return false;
    const k = r.args.findIndex((w) => w.lit !== null && isGitWord(w.lit));
    if (k < 0 || r.args.slice(0, k).some((w) => w.lit !== null && DATA_PROGRAMS.has(basename(w.lit)))) return false;
    let words = r.args.slice(k).map((w) => (w.lit === "{}" ? { ...w, lit: null, exp: null } : w));
    const end = words.findIndex((w) => [";", "+", ":::", "::::", ":::+", "::::+"].includes(w.lit));   // find and parallel separators
    if (end >= 0) words = words.slice(0, end);
    gitGhOut({ name: basename(words[0].lit), args: words.slice(1), xargs: r.xargs || SUBST_PROGRAMS.has(r.name), redirect: r.redirect }, st, getCtx, add, true);
    return true;
  };
  for (const cmd of cmds) {
    if (cmd.words.some((w) => /^GIT_CONFIG\w*=/.test(w.raw))) add({ cls: "shared", what: "git config from the environment", sub: "config", action: "GIT_CONFIG_* variables", refs: [], cmd: null });
    const r = resolveCmd(cmd.words);
    assigns(cmd, r, st);
    const gitEnv = cmd.words.some((w) => GIT_ENV.test(w.raw));
    if (gitEnv && (!r || DECLARE.has(r.name))) st.gitEnv = true;
    if (!r) continue;
    if (r.dynamic) {
      if (/\b(push|tag|release|api|rerun|cancel|pr|repo|delete|config|auth|merge|workflow|alias)\b/.test(cmd.words.map((w) => w.raw).join(" "))) add({ cls: "shared", what: "a command whose program it cannot tell", sub: "unknown", action: "a program named by a variable", refs: [], cmd: null });
      continue;
    }
    if (gitEnv) r.redirect = true;
    if (r.name === "cd" || r.name === "pushd") {
      const t = r.args.find((w) => w.lit === null || !w.lit.startsWith("-") || w.lit === "-");
      const e = t ? expOf(t, st) : st.env.HOME;
      st.cwd = cmd.depth > 0 || st.complex || e == null || e === "-" ? null : isAbsolute(e) ? e : st.cwd && resolve(st.cwd, e);
      continue;
    }
    if (r.name === "popd") { st.cwd = null; continue; }
    if ("inner" in r && r.inner === null) { unreadable(text); continue; }
    if (r.opaque || r.scripter) { if (!embedded(r)) unreadable([...cmd.words.map((w) => w.raw), cmd.heredoc ?? ""].join("\n")); continue; }
    if ("inner" in r) {
      let inner;
      try { inner = parseShell(r.inner, st.env); } catch { unreadable(r.inner); continue; }
      const sub = r.name === "eval" ? st : { ...st, assigned: new Set(st.assigned), temp: new Set(st.temp) };
      sub.complex ||= inner.complex;
      outWalk(inner, sub, getCtx, add, text);
      continue;
    }
    if (r.name === "git" || r.name === "gh" || r.name.startsWith("git-")) gitGhOut(r, st, getCtx, add, false);
    else embedded(r);
  }
}

const FLOOR = (b) => b === "main" || b === "master" || b.startsWith("release/");
// Classifies a parsed command: { findings, multi }. Destructive findings are final before any profile read; the profile is
// read only to add protected branches to the push and delete candidates.
export function classifyOutward(cmds, text, cwd, env, getCtx) {
  const out = { findings: [], multi: false };
  outWalk(cmds, { cwd, env, assigned: new Set(), temp: new Set(), complex: cmds.complex, out }, getCtx, (f) => out.findings.push(f), text);
  if (out.findings.some((f) => f.cls === "destructive")) return out;
  const prot = new Map(), ft = new Map();
  const isProt = (dir, b) => {
    if (!prot.has(dir)) {
      const oh = getCtx().originHead(dir);
      const p = getCtx().profile(dir);
      prot.set(dir, oh === FAIL ? null : [oh, p?.base, ...(p?.protected ?? [])].filter((x) => typeof x === "string" && x));
    }
    const list = prot.get(dir);
    return list === null || FLOOR(b) || list.some((x) => x === b || (x.endsWith("*") && b.startsWith(x.slice(0, -1))));
  };
  out.findings = out.findings.map((f) => {
    if (f.cls !== "candidate") return f;
    const p = isProt(f.dir, f.dst);
    if (f.del) return { ...f, cls: p ? "destructive" : "shared", what: p ? "protected branch delete" : "remote branch delete" };
    if (p) return { ...f, cls: "shared", what: "push to protected branch" };
    if (!ft.has(f.dir)) ft.set(f.dir, getCtx().followTags(f.dir));
    const t = ft.get(f.dir);
    return t === false ? { ...f, cls: "branch", what: "push to protected branch" } : { ...f, cls: "shared", what: t === FAIL ? "push with config it cannot read" : "tag push (push.followTags)" };
  });
  return out;
}

// The decision for a shared finding: deny when not alone or when the mode cannot prompt, else ask.
function sharedDecision(f, input, multi) {
  if (multi) return outwardReason("DENY", f, input, { note: "not alone in its call", do: "run it alone in its own call" });
  if (!ASK_MODES.has(input?.permission_mode)) return outwardReason("DENY", f, input, { note: "no prompt in this permission mode", do: f.cmd ? `run it yourself with ! ${f.cmd}` : undefined });
  return { ask: outwardReason("ASK", f, input) };
}

function mcpOut(tool, ti) {
  const parts = tool.toLowerCase().split("__"), t = parts.slice(2).join("__");
  if (!(parts[1] ?? "").includes("github")) return null;
  const target = [ti.owner && ti.repo ? `${ti.owner}/${ti.repo}` : null, ti.pullNumber ?? ti.pull_number ?? ti.issue_number ?? null, ti.ref ?? ti.branch ?? ti.tag ?? ti.tag_name ?? ti.run_id ?? null];
  const show = `${target[0] === null ? "" : safe(String(target[0]))}${target[1] === null ? "" : `#${safe(String(target[1]))}`}${target[2] === null ? "" : ` ${safe(String(target[2]))}`}`.trim();
  const base = { sub: tool, action: `${safe(tool)}${show ? ` ${show}` : ""}`, refs: show ? [show] : [], cmd: null };
  const d = ["delete", "force"].find((w) => t.includes(w)) ?? (ti.force === true ? "force" : null);
  if (d) return { ...base, cls: "destructive", what: `GitHub ${d}` };
  if (/^(get|list|search|read)_/.test(t)) return null;
  const s = ["merge", "push", "release", "cancel", "rerun", "dispatch"].find((w) => t.includes(w));
  return { ...base, cls: "shared", what: s ? `GitHub ${s}` : "GitHub write" };
}

// A parse error or guard error on git/gh text with an outward word: shared (condition 1).
function unreadableDecision(input) {
  const text = input?.tool_input?.command;
  if (typeof text !== "string" || !GITGH.test(text) || !COND1.test(text)) return null;
  return sharedDecision({ cls: "shared", what: "a command the guard cannot read", action: "git or gh in a command it cannot parse", cmd: null }, input, false);
}

// Returns the deny reason (a string), { ask: reason }, or null to allow.
export function guard(input, env = {}, ctx = null) {
  const op = isOperator(input, env);
  const tool = input?.tool_name, ti = input?.tool_input ?? {};
  const cwd = typeof input?.cwd === "string" && input.cwd ? resolve(input.cwd) : null;
  const getCtx = () => ctx ?? (ctx = realCtx(cwd ?? env.CLAUDE_PROJECT_DIR ?? process.cwd(), env));
  if (EDIT_TOOLS.includes(tool)) {
    if (!op) return null;
    const f = ti.file_path ?? ti.notebook_path;
    if (typeof f !== "string" || !f || (!isAbsolute(f) && !cwd)) return `OPR-01: the operator session does not edit a file it cannot locate; ${DELEGATE}.`;
    const abs = real(resolve(cwd ?? "/", f)), c = getCtx();
    if (c.operatorFiles.includes(abs) || !c.roots.some((r) => inside(r, abs))) return null;
    return `OPR-01: the operator session does not edit or write ${f} inside the repo (its one file is .agents/operator.md); ${DELEGATE}.`;
  }
  if (typeof tool === "string" && tool.startsWith("mcp__")) {
    const f = mcpOut(tool, ti);
    return !f ? null : f.cls === "destructive" ? outwardReason("DENY", f, input) : sharedDecision(f, input, false);
  }
  if (tool !== "Bash") return null;
  if (typeof ti.command !== "string") return op ? `OPR-01: the operator session does not run a Bash call without a command string; ${DELEGATE}.` : null;
  let cmds;
  try { cmds = parseShell(ti.command, env); } catch (e) { return op ? `OPR-01: the operator session does not run a command it cannot parse (${e.message}); ${DELEGATE}.` : unreadableDecision(input); }
  const out = classifyOutward(cmds, ti.command, cwd, env, getCtx);
  const withCommit = (f) => {
    if (!f.rev || !f.dir) return f;
    const c = getCtx().commit(f.dir, f.rev);
    return c && c !== FAIL ? { ...f, commit: c } : f;
  };
  const d = out.findings.find((f) => f.cls === "destructive");
  if (d) return outwardReason("DENY", withCommit(d), input);
  if (op || /\bgit\b/.test(ti.command)) {
    const r = checkCmds(cmds, { cwd, env, assigned: new Set(), temp: new Set(), merging: false, complex: cmds.complex }, getCtx(), op, cmds.length);
    if (r) return r;
  }
  const s = out.findings.find((f) => f.cls === "shared");
  return s ? sharedDecision(withCommit(s), input, out.multi) : null;
}

// The hook entry: raw stdin in, { code, stdout, stderr } out. Fails closed only for the operator.
export function hookMain(raw, env, fn = guard) {
  let input;
  try { input = JSON.parse(raw); } catch {
    if (env.ORBIT_ROLE === "operator") return { code: 2, stdout: "", stderr: "OPR-01: the orbit guard cannot read the hook input, so the operator's tool call is denied.\n" };
    return { code: 0, stdout: "", stderr: "" };
  }
  let reason;
  try { reason = fn(input, env); } catch (e) {
    if (!isOperator(input, env)) reason = input?.tool_name === "Bash" ? unreadableDecision(input) : null;
    else reason = `OPR-01: the orbit guard failed (${e.message}), so the operator's tool call is denied.`;
  }
  const ask = reason !== null && typeof reason === "object";
  const stdout = reason ? JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: ask ? "ask" : "deny", permissionDecisionReason: ask ? reason.ask : reason } }) + "\n" : "";
  return { code: 0, stdout, stderr: "" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let raw = "";
  try { raw = readFileSync(0, "utf8"); } catch { /* stdin unreadable: treated as empty input, which hookMain handles */ }
  const o = hookMain(raw, process.env);
  process.stdout.write(o.stdout);
  process.stderr.write(o.stderr);
  process.exit(o.code);
}
